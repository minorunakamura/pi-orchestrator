// Every durable intent, file observation and mutation is deliberately sequential.
// oxlint-disable eslint/no-await-in-loop
import { RuntimePortError } from "../ports/errors.ts";
import { artifactRelativePath } from "../persistence/artifact-paths.ts";
import {
  captureWorkspace,
  unchangedDocumentScope,
} from "../worker/workspace-evidence.ts";
import type { OwnershipBoundary } from "./workflow-ownership.ts";
import { isWorkspaceSnapshot } from "../worker/attempt-evidence.ts";
import { realpath, lstat, readFile, mkdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, join, posix } from "node:path";
import type {
  ArtifactKind,
  ArtifactRef,
} from "../../core/artifacts/references.ts";
import type { WorkflowState } from "../../core/workflow/state.ts";
import { sameArtifactRef } from "../../core/workflow/invariants.ts";
import {
  isRecord,
  isNonEmptyString,
  isNonNegativeInteger,
  isOneOf,
  optional,
  parseSchema,
} from "../../core/schema.ts";
import { isArtifactRef } from "../../core/artifacts/references.ts";
import type {
  ClarificationPort,
  ClarificationRequest,
  ClarificationSetup,
} from "../ports/clarification-port.ts";
import type { WorkflowArtifactWriter } from "./planning-orchestrator.ts";
import {
  advanceWorkflow,
  type WorkflowStateWriter,
} from "./advance-workflow.ts";
import {
  ArtifactImmutableError,
  calculateSha256,
  createArtifactRef,
} from "../persistence/artifact-store.ts";
import {
  normalizeHumanQuestions,
  parseHumanReply,
  type HumanQuestion,
  type HumanReply,
} from "../integrations/ask-user-question.ts";

export interface ClarificationDependencies {
  artifactStore: WorkflowArtifactWriter;
  stateStore: WorkflowStateWriter & {
    loadState?: () => Promise<WorkflowState>;
  };
  clarificationPort?: ClarificationPort;
  ownership?: OwnershipBoundary;
}
export interface DurableClarificationRequest extends ClarificationRequest {
  schemaVersion: 1;
  workflowId: string;
  mode: "GRILL_ME" | "GRILL_WITH_DOCS";
  sourceRevision: number;
  sourceDigest: string;
  canonicalProjectRoot: string;
  contextRefs: ArtifactRef[];
  evidence: { ref: ArtifactRef; content: string }[];
}
interface Progress {
  schemaVersion: 1;
  requestRef: ArtifactRef<"clarification">;
  previousRef?: ArtifactRef<"clarification">;
  round: number;
  status: "pending" | "answered" | "declined" | "completed";
  questions: HumanQuestion[];
  reply?: HumanReply;
  summary?: string;
  documents?: DocumentChange[];
  documentRef?: ArtifactRef<"domain-document-write">;
}
export interface DocumentChange {
  path: string;
  content: string;
}
interface DocumentSnapshot extends DocumentChange {
  before: string | null;
  beforeHash: string | null;
  afterHash: string;
}

function sourceDigest(state: WorkflowState): string {
  const copy = structuredClone(state);
  copy.stateRevision = 0;
  copy.updatedAt = "";
  delete copy.planning.clarificationRequestRef;
  delete copy.planning.clarificationProgressRef;
  delete copy.planning.domainDocumentWriteRef;
  delete copy.workspaceCheckpointRef;
  return calculateSha256(JSON.stringify(copy));
}

async function publish<K extends ArtifactKind>(
  deps: ClarificationDependencies,
  kind: K,
  label: string,
  value: unknown,
): Promise<ArtifactRef<K>> {
  const content = JSON.stringify(value, null, 2) + "\n";
  const name = `${label}-${calculateSha256(content)}.md`;
  const ref = createArtifactRef(
    kind,
    artifactRelativePath(kind, name),
    content,
  );
  try {
    const written = await deps.artifactStore.writeText(kind, name, content);
    if (!sameArtifactRef(written, ref))
      throw Error("Clarification artifact identity mismatch");
  } catch (error) {
    if (
      !(error instanceof ArtifactImmutableError) ||
      !deps.artifactStore.readText ||
      (await deps.artifactStore.readText(ref)) !== content
    )
      throw error;
  }
  return ref;
}

async function read<T>(
  deps: ClarificationDependencies,
  ref: ArtifactRef,
  schema: (value: unknown) => value is T,
): Promise<T> {
  if (!deps.artifactStore.readText)
    throw Error("Clarification requires an authoritative Artifact reader");
  const value: unknown = JSON.parse(await deps.artifactStore.readText(ref));
  return parseSchema(value, schema, "Clarification evidence");
}

function isRequest(value: unknown): value is DurableClarificationRequest {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    isNonEmptyString(value.workflowId) &&
    isNonNegativeInteger(value.sourceRevision) &&
    isNonEmptyString(value.sourceDigest) &&
    isNonEmptyString(value.canonicalProjectRoot) &&
    isNonEmptyString(value.prompt) &&
    isOneOf(["GRILL_ME", "GRILL_WITH_DOCS"] as const, value.mode) &&
    Array.isArray(value.contextRefs) &&
    value.contextRefs.every(isArtifactRef) &&
    Array.isArray(value.evidence) &&
    value.evidence.every(
      (e) =>
        isRecord(e) && isArtifactRef(e.ref) && typeof e.content === "string",
    ) &&
    JSON.stringify(value.contextRefs) ===
      JSON.stringify(value.evidence.map((e) => e.ref)) &&
    optional(
      value,
      "setup",
      (setup) =>
        isRecord(setup) &&
        isNonEmptyString(setup.rootSessionId) &&
        Array.isArray(setup.skills) &&
        setup.skills.every(
          (s) =>
            isRecord(s) &&
            [s.name, s.path, s.sha256, s.content].every(isNonEmptyString),
        ),
    )
  );
}

function isProgress(value: unknown): value is Progress {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isArtifactRef(value.requestRef) ||
    value.requestRef.kind !== "clarification" ||
    !isNonNegativeInteger(value.round) ||
    value.round < 1 ||
    value.round > 8 ||
    !isOneOf(
      ["pending", "answered", "declined", "completed"] as const,
      value.status,
    ) ||
    !Array.isArray(value.questions) ||
    !optional(
      value,
      "documentRef",
      (ref) => isArtifactRef(ref) && ref.kind === "domain-document-write",
    )
  )
    return false;
  if (value.confirmedByPort === true)
    return value.status === "completed" && isNonEmptyString(value.answer);
  try {
    const questions = normalizeHumanQuestions(value.questions);
    if (value.status === "pending") return value.reply === undefined;
    const reply = parseHumanReply(
      {
        version: 1,
        requestId: "persisted",
        success: true,
        result: value.reply,
      },
      "persisted",
      questions,
    );
    if (value.status === "completed")
      return (
        isNonEmptyString(value.summary) &&
        reply.status === "answered" &&
        questions.length === 1 &&
        reply.answers[questions[0].question] === "Confirm"
      );
    return value.status === "declined" || reply.status === "answered";
  } catch {
    return false;
  }
}

interface DocumentEvidence {
  schemaVersion: 1;
  status: "intent" | "completed";
  workflowId: string;
  sourceRevision: number;
  answerRef: ArtifactRef<"clarification">;
  intentRef?: ArtifactRef<"domain-document-write">;
  requestRef: ArtifactRef<"clarification">;
  projectRoot: string;
  operations: DocumentSnapshot[];
  workspaceBeforeRef?: ArtifactRef<"reconciliation">;
  workspaceAfterRef?: ArtifactRef<"reconciliation">;
  scopeBeforeRef?: ArtifactRef<"reconciliation">;
  scopeAfterRef?: ArtifactRef<"reconciliation">;
}
function isDocumentEvidence(value: unknown): value is DocumentEvidence {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    isNonEmptyString(value.workflowId) &&
    isNonNegativeInteger(value.sourceRevision) &&
    isArtifactRef(value.answerRef) &&
    value.answerRef.kind === "clarification" &&
    optional(
      value,
      "intentRef",
      (ref) => isArtifactRef(ref) && ref.kind === "domain-document-write",
    ) &&
    isOneOf(["intent", "completed"] as const, value.status) &&
    isArtifactRef(value.requestRef) &&
    value.requestRef.kind === "clarification" &&
    isNonEmptyString(value.projectRoot) &&
    [
      "workspaceBeforeRef",
      "workspaceAfterRef",
      "scopeBeforeRef",
      "scopeAfterRef",
    ].every((key) =>
      optional(
        value,
        key,
        (ref) => isArtifactRef(ref) && ref.kind === "reconciliation",
      ),
    ) &&
    Array.isArray(value.operations) &&
    value.operations.length > 0 &&
    value.operations.length <= 4 &&
    value.operations.every(
      (op) =>
        isRecord(op) &&
        isNonEmptyString(op.path) &&
        typeof op.content === "string" &&
        (op.before === null || typeof op.before === "string") &&
        op.beforeHash ===
          (op.before === null ? null : calculateSha256(op.before)) &&
        op.afterHash === calculateSha256(op.content),
    )
  );
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

async function saveRef(
  state: WorkflowState,
  deps: ClarificationDependencies,
  key:
    | "clarificationRequestRef"
    | "clarificationProgressRef"
    | "domainDocumentWriteRef",
  ref: ArtifactRef,
): Promise<WorkflowState> {
  return deps.stateStore.saveState(
    { ...state, planning: { ...state.planning, [key]: ref } },
    state.stateRevision,
  );
}

export async function prepareClarification(
  state: WorkflowState,
  deps: ClarificationDependencies,
  input: {
    mode: "GRILL_ME" | "GRILL_WITH_DOCS";
    modeRef?: ArtifactRef<"clarification-mode">;
    prompt?: string;
    contextRefs: readonly ArtifactRef[];
  },
): Promise<{ state: WorkflowState; request: DurableClarificationRequest }> {
  if (state.planning.clarificationRequestRef) {
    const request = await loadClarification(state, deps);
    if (
      request.mode !== input.mode ||
      (input.prompt !== undefined && input.prompt !== request.prompt) ||
      JSON.stringify(input.contextRefs) !== JSON.stringify(request.contextRefs)
    )
      throw Error("Clarification request changed; explicit recovery required");
    return { state, request };
  }
  const prompt =
    input.prompt ??
    "Investigate the durable evidence, grill the unresolved Human decisions, and confirm shared understanding before Planning. Do not guess missing facts or grant implementation authority.";
  if (!prompt.trim() || prompt.length > 8192 || input.contextRefs.length > 12)
    throw Error("Invalid bounded clarification input");
  const evidence: DurableClarificationRequest["evidence"] = [];
  for (const ref of input.contextRefs) {
    // Evidence is accepted in full or rejected, never silently truncated.
    // oxlint-disable-next-line eslint/no-await-in-loop
    const content = await deps.artifactStore.readText!(ref);
    if (Buffer.byteLength(content) > 65536)
      throw Error("Clarification evidence exceeds per-artifact bound");
    evidence.push({ ref, content });
  }
  if (Buffer.byteLength(JSON.stringify(evidence)) > 131072)
    throw Error("Clarification evidence exceeds total bound");
  let setup: ClarificationSetup | undefined;
  try {
    setup = await deps.clarificationPort?.setup?.(input.mode);
  } catch (error) {
    throw new RuntimePortError(
      "infrastructure",
      "Root clarification skill/TUI setup unavailable",
      { cause: error },
    );
  }
  const request: DurableClarificationRequest = {
    schemaVersion: 1,
    workflowId: state.workflowId,
    sourceRevision: state.stateRevision,
    sourceDigest: sourceDigest(state),
    canonicalProjectRoot: await realpath(state.projectRoot!),
    mode: input.mode,
    ...(input.modeRef ? { modeRef: input.modeRef } : {}),
    prompt,
    contextRefs: structuredClone([...input.contextRefs]),
    evidence,
    ...(setup ? { setup } : {}),
  };
  const ref = await publish(deps, "clarification", "human-request", request);
  state = await saveRef(state, deps, "clarificationRequestRef", ref);
  return { state, request: { ...request, requestRef: ref } };
}

export async function loadClarification(
  state: WorkflowState,
  deps: ClarificationDependencies,
  rootSessionId?: string,
): Promise<DurableClarificationRequest> {
  const ref = state.planning.clarificationRequestRef;
  if (state.phase !== "clarifying" || !ref)
    throw Error("No active durable clarification request");
  const request = await read(deps, ref, isRequest);
  if (
    request.workflowId !== state.workflowId ||
    request.sourceDigest !== sourceDigest(state) ||
    request.canonicalProjectRoot !== (await realpath(state.projectRoot!)) ||
    !["GRILL_ME", "GRILL_WITH_DOCS"].includes(request.mode) ||
    !Array.isArray(request.contextRefs) ||
    !Array.isArray(request.evidence) ||
    (rootSessionId !== undefined &&
      request.setup?.rootSessionId !== rootSessionId)
  )
    throw Error("Stale clarification State or root session identity");
  for (const evidence of request.evidence) {
    // Verify original bounded evidence again at every execution boundary.
    // oxlint-disable-next-line eslint/no-await-in-loop
    if ((await deps.artifactStore.readText!(evidence.ref)) !== evidence.content)
      throw Error("Clarification input drift");
  }
  return { ...request, requestRef: ref };
}

async function progress(
  state: WorkflowState,
  deps: ClarificationDependencies,
): Promise<Progress | undefined> {
  if (!state.planning.clarificationProgressRef) return undefined;
  const value = await read(
    deps,
    state.planning.clarificationProgressRef,
    isProgress,
  );
  if (
    !sameArtifactRef(
      value.requestRef,
      state.planning.clarificationRequestRef,
    ) ||
    !Number.isSafeInteger(value.round) ||
    value.round < 1 ||
    value.round > 8 ||
    !["pending", "answered", "declined", "completed"].includes(value.status)
  )
    throw Error("Invalid clarification progress binding");
  return value;
}

export async function recoverClarification(
  state: WorkflowState,
  deps: ClarificationDependencies,
): Promise<WorkflowState> {
  if (!state.planning.clarificationRequestRef) return state;
  await loadClarification(state, deps);
  const current = await progress(state, deps);
  if (current?.status === "completed") {
    await verifyClarificationDocuments(state, deps);
    return advanceWorkflow(
      state,
      {
        type: "CLARIFICATION_COMPLETE",
        clarificationRef: state.planning.clarificationProgressRef!,
      },
      deps.stateStore,
    );
  }
  if (
    current?.status === "pending" ||
    current?.status === "declined" ||
    state.planning.domainDocumentWriteRef
  )
    return advanceWorkflow(
      state,
      {
        type: "BLOCK",
        reason: "operator-attention-required",
        evidenceRef:
          state.planning.domainDocumentWriteRef ??
          state.planning.clarificationProgressRef,
      },
      deps.stateStore,
    );
  return state;
}

export async function publishSynchronousClarification(
  state: WorkflowState,
  deps: ClarificationDependencies,
  answer: string,
): Promise<WorkflowState> {
  if (!answer.trim()) throw Error("Clarification answer must not be empty");
  // Synchronous ports provide confirmed Human evidence; production uses explicit rounds below.
  const ref = await publish(deps, "clarification", "human-answer", {
    schemaVersion: 1,
    requestRef: state.planning.clarificationRequestRef,
    round: 1,
    status: "completed",
    questions: [],
    confirmedByPort: true,
    answer,
  });
  state = await saveRef(state, deps, "clarificationProgressRef", ref);
  return advanceWorkflow(
    state,
    { type: "CLARIFICATION_COMPLETE", clarificationRef: ref },
    deps.stateStore,
  );
}

export async function runClarificationRound(
  state: WorkflowState,
  deps: ClarificationDependencies,
  input: {
    requestHash: string;
    rootSessionId: string;
    questions?: HumanQuestion[];
    summary?: string;
    documents?: DocumentChange[];
  },
  ask: (id: string, questions: HumanQuestion[]) => Promise<HumanReply>,
): Promise<WorkflowState> {
  const request = await loadClarification(state, deps, input.rootSessionId);
  if (request.requestRef!.sha256 !== input.requestHash)
    throw Error("Clarification request hash mismatch");
  const previous = await progress(state, deps);
  if (state.planning.domainDocumentWriteRef)
    throw Error(
      "Domain-document attempt cannot be replayed; explicit reconciliation required",
    );
  if (previous && previous.status !== "answered")
    throw Error("Pending/settled clarification cannot be replayed");
  const round = (previous?.round ?? 0) + 1;
  if (round > 8)
    throw Error(
      "Clarification round budget exhausted; operator attention required",
    );
  const final = input.summary !== undefined;
  if (final && (!input.summary!.trim() || input.summary!.length > 8192))
    throw Error("Invalid shared-understanding summary");
  const documents = input.documents ?? [];
  if (
    (!final && documents.length) ||
    (request.mode !== "GRILL_WITH_DOCS" && documents.length)
  )
    throw Error("Mode does not grant document mutation");
  const snapshots = await snapshotDocuments(
    state,
    documents,
    request.canonicalProjectRoot,
  );
  const questions = normalizeHumanQuestions(
    final
      ? [
          {
            question: `Shared understanding:\n${input.summary}\n\n${snapshots.length ? `Authorize these exact domain-document updates:\n${JSON.stringify(snapshots, null, 2)}` : "No domain-document updates."}\n\nConfirm that all decisions are settled. This does not approve implementation.`,
            header: "Confirm",
            options: [{ label: "Confirm" }, { label: "Decline" }],
            allowOther: false,
          },
        ]
      : input.questions,
  );
  const pending: Progress = {
    schemaVersion: 1,
    requestRef: request.requestRef!,
    ...(state.planning.clarificationProgressRef
      ? { previousRef: state.planning.clarificationProgressRef }
      : {}),
    round,
    status: "pending",
    questions,
    ...(final ? { summary: input.summary, documents } : {}),
  };
  const pendingRef = await publish(
    deps,
    "clarification",
    "human-round",
    pending,
  );
  state = await saveRef(state, deps, "clarificationProgressRef", pendingRef);
  let reply: HumanReply;
  try {
    reply = await ask(pendingRef.sha256, questions);
  } catch {
    return advanceWorkflow(
      state,
      {
        type: "BLOCK",
        reason: "human-gate-unavailable",
        evidenceRef: pendingRef,
      },
      deps.stateStore,
    );
  }
  const confirmed =
    reply.status === "answered" &&
    (!final || reply.answers[questions[0].question] === "Confirm");
  const answered: Progress = {
    ...pending,
    previousRef: pendingRef,
    status: confirmed ? "answered" : "declined",
    reply,
  };
  const answerRef = await publish(
    deps,
    "clarification",
    "human-reply",
    answered,
  );
  state = await saveRef(state, deps, "clarificationProgressRef", answerRef);
  if (!confirmed)
    return advanceWorkflow(
      state,
      {
        type: "BLOCK",
        reason: "operator-attention-required",
        evidenceRef: answerRef,
      },
      deps.stateStore,
    );
  if (deps.ownership) {
    state = await deps.ownership.validate(state, deps.stateStore);
    if (state.phase === "blocked") return state;
  }
  if (!final) return state;
  try {
    await loadClarification(state, deps, input.rootSessionId);
    state = await writeDocuments(
      state,
      deps,
      snapshots,
      answerRef,
      request.canonicalProjectRoot,
    );
  } catch {
    if (deps.stateStore.loadState) state = await deps.stateStore.loadState();
    await loadClarification(state, deps, input.rootSessionId);
    return advanceWorkflow(
      state,
      {
        type: "BLOCK",
        reason: "operator-attention-required",
        evidenceRef: state.planning.domainDocumentWriteRef ?? answerRef,
      },
      deps.stateStore,
    );
  }
  const completedRef = await publish(
    deps,
    "clarification",
    "clarification-complete",
    {
      ...answered,
      status: "completed",
      unresolvedDecisions: [],
      previousRef: answerRef,
      ...(state.planning.domainDocumentWriteRef
        ? { documentRef: state.planning.domainDocumentWriteRef }
        : {}),
    },
  );
  state = await saveRef(state, deps, "clarificationProgressRef", completedRef);
  return advanceWorkflow(
    state,
    { type: "CLARIFICATION_COMPLETE", clarificationRef: completedRef },
    deps.stateStore,
  );
}

function validateDocumentPath(path: string): void {
  if (
    !path ||
    // Reject control bytes before any filesystem operation or Human authorization.
    // oxlint-disable-next-line eslint/no-control-regex
    /[\x00-\x1f\x7f]/u.test(path) ||
    path.includes("\\") ||
    posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    path
      .split("/")
      .some((p) => ["..", ".", ".git", ".pi", "node_modules"].includes(p)) ||
    !/^(?:CONTEXT-MAP\.md|(?:[^/]+\/)*CONTEXT\.md|(?:[^/]+\/)*docs\/adr\/[^/]+\.md)$/u.test(
      path,
    )
  )
    throw Error("Unauthorized domain-document path");
}

async function documentTarget(
  root: string,
  path: string,
  createParents = false,
): Promise<string> {
  validateDocumentPath(path);
  if ((await realpath(root)) !== resolve(root))
    throw Error("Noncanonical project root");
  const parts = path.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    // oxlint-disable-next-line eslint/no-await-in-loop
    if (createParents)
      await mkdir(current).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "EEXIST") throw e;
      });
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw Error("Unsafe document parent");
    } catch (error) {
      if (!isMissing(error) || createParents) throw error;
    }
  }
  return join(root, path);
}

async function documentContent(
  root: string,
  path: string,
): Promise<string | null> {
  const target = await documentTarget(root, path);
  try {
    const stat = await lstat(target);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > 65536
    )
      throw Error("Unsafe domain-document file");
    return await readFile(target, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function snapshotDocuments(
  state: WorkflowState,
  changes: DocumentChange[],
  canonicalRoot: string,
): Promise<DocumentSnapshot[]> {
  if (
    !Array.isArray(changes) ||
    changes.length > 4 ||
    new Set(changes.map((d) => d.path)).size !== changes.length
  )
    throw Error("Invalid bounded document changes");
  const snapshots: DocumentSnapshot[] = [];
  for (const change of changes) {
    if (
      !state.projectRoot ||
      typeof change.path !== "string" ||
      typeof change.content !== "string" ||
      !change.content.trim() ||
      Buffer.byteLength(change.content) > 8192
    )
      throw Error("Invalid domain-document content");
    // oxlint-disable-next-line eslint/no-await-in-loop
    const before = await documentContent(canonicalRoot, change.path);
    snapshots.push({
      ...change,
      before,
      beforeHash: before === null ? null : calculateSha256(before),
      afterHash: calculateSha256(change.content),
    });
  }
  return snapshots;
}

async function writeDocuments(
  state: WorkflowState,
  deps: ClarificationDependencies,
  snapshots: DocumentSnapshot[],
  answerRef: ArtifactRef<"clarification">,
  canonicalRoot: string,
): Promise<WorkflowState> {
  if (!snapshots.length) return state;
  const paths = snapshots.map((snapshot) => snapshot.path);
  const workspaceBefore = state.ownershipRef
    ? await captureWorkspace(canonicalRoot, deps.artifactStore.rootDirectory)
    : undefined;
  const scopeBefore = state.ownershipRef
    ? await captureWorkspace(
        canonicalRoot,
        deps.artifactStore.rootDirectory,
        undefined,
        paths,
      )
    : undefined;
  const workspaceBeforeRef = workspaceBefore
    ? await publish(
        deps,
        "reconciliation",
        "document-workspace-before",
        workspaceBefore,
      )
    : undefined;
  const scopeBeforeRef = scopeBefore
    ? await publish(
        deps,
        "reconciliation",
        "document-scope-before",
        scopeBefore,
      )
    : undefined;
  const intent = {
    schemaVersion: 1,
    status: "intent",
    workflowId: state.workflowId,
    sourceRevision: state.stateRevision,
    requestRef: state.planning.clarificationRequestRef,
    answerRef,
    projectRoot: canonicalRoot,
    operations: snapshots,
    ...(workspaceBeforeRef ? { workspaceBeforeRef, scopeBeforeRef } : {}),
  };
  const intentRef = await publish(
    deps,
    "domain-document-write",
    "domain-document-intent",
    intent,
  );
  state = await saveRef(state, deps, "domainDocumentWriteRef", intentRef);
  // No retry after this barrier: even one partial write requires explicit recovery.
  for (const snapshot of snapshots) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    if (
      (await documentContent(canonicalRoot, snapshot.path)) !== snapshot.before
    )
      throw Error("Document before identity changed");
    // oxlint-disable-next-line eslint/no-await-in-loop
    const target = await documentTarget(canonicalRoot, snapshot.path, true);
    // oxlint-disable-next-line eslint/no-await-in-loop
    const file = await open(
      target,
      constants.O_RDWR |
        constants.O_NOFOLLOW |
        (snapshot.before === null ? constants.O_CREAT | constants.O_EXCL : 0),
      0o644,
    );
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536)
        throw Error("Unsafe document write target");
      if (snapshot.before !== null) {
        const buffer = Buffer.alloc(stat.size);
        // Explicit position preserves the write offset at zero.
        // oxlint-disable-next-line eslint/no-await-in-loop
        const observed = await file.read(buffer, 0, buffer.length, 0);
        if (
          observed.bytesRead !== buffer.length ||
          calculateSha256(buffer) !== snapshot.beforeHash
        )
          throw Error("Opened document before identity changed");
      }
      // oxlint-disable-next-line eslint/no-await-in-loop
      await file.truncate(0);
      // oxlint-disable-next-line eslint/no-await-in-loop
      await file.writeFile(snapshot.content, "utf8");
      // oxlint-disable-next-line eslint/no-await-in-loop
      await file.sync();
    } finally {
      // oxlint-disable-next-line eslint/no-await-in-loop
      await file.close();
    }
    // oxlint-disable-next-line eslint/no-await-in-loop
    if (
      (await documentContent(canonicalRoot, snapshot.path)) !== snapshot.content
    )
      throw Error("Document after identity mismatch");
  }
  const scopeAfter = state.ownershipRef
    ? await captureWorkspace(
        canonicalRoot,
        deps.artifactStore.rootDirectory,
        undefined,
        paths,
      )
    : undefined;
  if (
    scopeBefore &&
    scopeAfter &&
    !unchangedDocumentScope(scopeBefore, scopeAfter, paths)
  )
    throw Error("Out-of-band mutation during documentation write");
  const workspaceAfter = state.ownershipRef
    ? await captureWorkspace(canonicalRoot, deps.artifactStore.rootDirectory)
    : undefined;
  const workspaceAfterRef = workspaceAfter
    ? await publish(
        deps,
        "reconciliation",
        "document-workspace-after",
        workspaceAfter,
      )
    : undefined;
  const scopeAfterRef = scopeAfter
    ? await publish(deps, "reconciliation", "document-scope-after", scopeAfter)
    : undefined;
  const resultRef = await publish(
    deps,
    "domain-document-write",
    "domain-document-result",
    {
      ...intent,
      status: "completed",
      intentRef,
      ...(workspaceAfterRef ? { workspaceAfterRef, scopeAfterRef } : {}),
    },
  );
  return saveRef(state, deps, "domainDocumentWriteRef", resultRef);
}

export async function verifyClarificationDocuments(
  state: WorkflowState,
  deps: ClarificationDependencies,
): Promise<void> {
  if (!state.planning.domainDocumentWriteRef) return;
  const completionRef =
    state.phase === "clarifying"
      ? state.planning.clarificationProgressRef
      : state.planning.context.clarificationRef;
  if (!completionRef)
    throw Error("Missing document-bound clarification completion");
  const completion = await read(deps, completionRef, isProgress);
  if (
    completion.status !== "completed" ||
    !sameArtifactRef(
      completion.documentRef,
      state.planning.domainDocumentWriteRef,
    )
  )
    throw Error("Clarification document binding mismatch");
  const result = await read(
    deps,
    state.planning.domainDocumentWriteRef,
    isDocumentEvidence,
  );
  if (
    result.status !== "completed" ||
    !result.intentRef ||
    result.workflowId !== state.workflowId ||
    result.projectRoot !== (await realpath(state.projectRoot!)) ||
    !sameArtifactRef(result.requestRef, state.planning.clarificationRequestRef)
  )
    throw Error("Unresolved document mutation");
  const intent = await read(deps, result.intentRef, isDocumentEvidence);
  const answer = await read(deps, result.answerRef, isProgress);
  const request = await read(deps, result.requestRef, isRequest);
  if (
    request.mode !== "GRILL_WITH_DOCS" ||
    request.workflowId !== state.workflowId ||
    request.canonicalProjectRoot !== result.projectRoot ||
    !sameArtifactRef(completion.requestRef, result.requestRef) ||
    JSON.stringify(answer.reply) !== JSON.stringify(completion.reply) ||
    !Array.isArray(answer.documents) ||
    answer.documents.length !== result.operations.length ||
    !answer.documents.every(
      (document, index) =>
        document.path === result.operations[index].path &&
        document.content === result.operations[index].content,
    ) ||
    intent.status !== "intent" ||
    intent.workflowId !== result.workflowId ||
    intent.sourceRevision !== result.sourceRevision ||
    intent.projectRoot !== result.projectRoot ||
    !sameArtifactRef(intent.requestRef, result.requestRef) ||
    !sameArtifactRef(intent.answerRef, result.answerRef) ||
    !sameArtifactRef(completion.previousRef, result.answerRef) ||
    answer.status !== "answered" ||
    !sameArtifactRef(answer.requestRef, result.requestRef) ||
    JSON.stringify(intent.operations) !== JSON.stringify(result.operations)
  )
    throw Error("Domain-document intent/answer binding mismatch");
  if (state.ownershipRef || result.workspaceBeforeRef) {
    if (
      !sameArtifactRef(result.workspaceBeforeRef, intent.workspaceBeforeRef) ||
      !sameArtifactRef(result.scopeBeforeRef, intent.scopeBeforeRef)
    )
      throw Error("Document workspace intent binding mismatch");
    for (const ref of [
      result.workspaceBeforeRef,
      result.scopeBeforeRef,
      result.workspaceAfterRef,
      result.scopeAfterRef,
    ]) {
      if (!ref) throw Error("Missing document workspace evidence");
      const snapshot = await read(deps, ref, isWorkspaceSnapshot);
      if (
        snapshot.root !== result.projectRoot ||
        snapshot.cwd !== result.projectRoot
      )
        throw Error("Document workspace identity mismatch");
    }
  }
  for (const operation of result.operations) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    if (
      (await documentContent(result.projectRoot, operation.path)) !==
      operation.content
    )
      throw Error("Domain-document drift");
  }
}

export async function validateClarificationSetup(
  setup: ClarificationSetup,
): Promise<void> {
  for (const skill of setup.skills) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    if (
      (await readFile(skill.path, "utf8")) !== skill.content ||
      calculateSha256(skill.content) !== skill.sha256
    )
      throw Error("Clarification skill drift");
  }
}
