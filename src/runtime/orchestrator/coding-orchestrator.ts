import { workerDeviation } from "../../core/coding/plan-deviation.ts";
import {
  publishPlanDeviation,
  validateStoppedWorker,
} from "./plan-deviation.ts";
import { validateWorkerStrategy } from "../worker/development-strategy.ts";
import { PlanningRouting } from "./planning-routing.ts";
import { StateStore } from "../persistence/state-store.ts";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { SubagentNotDispatchedError } from "../ports/subagent-executor.ts";
import { readFile, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { JevAuthorization, jevBlockedReason } from "./jev-authorization.ts";
import {
  captureWorkspace,
  workspaceReviewPatch,
  assertWorkspaceIdentity,
  type WorkspaceSnapshot,
} from "../worker/workspace-evidence.ts";
import {
  parseWorkerAttempt,
  type WorkerAttemptEvidence,
} from "../worker/attempt-evidence.ts";
import { DEFAULT_SUBAGENT_TIMEOUT_MS } from "../integrations/subagents.ts";
import type { ArtifactRef } from "../../core/artifacts/references.ts";
import { isArtifactRef } from "../../core/artifacts/references.ts";
import {
  resolveExecutionProfile,
  type OrchestratorConfiguration,
  type ResolvedExecutionProfile,
} from "../../core/configuration.ts";
import { resolveExecutionRouting } from "../../core/decisions/execution-routing.ts";
import {
  isAcceptedFindingsArtifact,
  isModelTier,
  isReasoningTier,
  type Decision,
  type ModelTier,
  type ReasoningTier,
} from "../../core/decisions/types.ts";
import {
  isConfidence,
  isNonEmptyString,
  isNonNegativeInteger,
  isRecord,
  hasOnlyKeys,
} from "../../core/schema.ts";
import {
  assertStateInvariants,
  sameArtifactRef,
} from "../../core/workflow/invariants.ts";
import type { WorkflowState } from "../../core/workflow/state.ts";
import type { PlanSection } from "../../core/planning/policy.ts";
import {
  isSubagentRunId,
  subagentRunId,
  type SubagentRunId,
} from "../../types.ts";
import {
  ArtifactImmutableError,
  calculateSha256,
  createArtifactRef,
  validateArtifactRef,
} from "../persistence/artifact-store.ts";
import { artifactRelativePath } from "../persistence/artifact-paths.ts";
import {
  RuntimePortError,
  type AgentRunResult,
  type AgentRunRequest,
  type CodeReviewResult,
  type JevDecisionClient,
  type PlannotatorGate,
  type SubagentExecutor,
} from "../ports/index.ts";
import {
  createWorkerRequest,
  type WorkerInput,
} from "../integrations/subagents.ts";
import {
  advanceWorkflow,
  type WorkflowStateWriter,
} from "./advance-workflow.ts";
import type { WorkflowArtifactWriter } from "./planning-orchestrator.ts";
import type { OwnershipBoundary } from "./workflow-ownership.ts";

import { decisionFreshness } from "./coding-evidence.ts";
import { parsePlan } from "../planning/plan-parser.ts";
import {
  isDecisionFresh,
  isDecisionFreshness,
  type DecisionFreshness,
} from "../../core/decisions/decision-freshness.ts";
import {
  assertCodingAuthority,
  codingAuthority,
} from "../../core/coding/authority.ts";
import {
  isCodeReviewAttempt,
  type CodeReviewAttempt,
  type CodeReviewSource,
} from "../../core/coding/code-review.ts";
import {
  verifyCodeReviewSource,
  readWorkspaceBaseline,
} from "../worker/code-review-source.ts";

export const CODING_ENTRY_EVIDENCE_LIMITS = {
  maxPlanSummaryChars: 2_000,
  maxPlanSectionChars: 3_000,
  maxContextEvidenceChars: 2_000,
  maxContextRefs: 8,
} as const;

const routingPlanSections: readonly PlanSection[] = [
  "Scope / Requirements",
  "Architecture / Design",
  "Implementation Approach",
  "Expected Change Surface",
  "New Components",
  "New Dependencies",
  "Non-goals",
];

export interface ExecutionRoutingArtifact {
  freshness?: DecisionFreshness;
  sourceDecisionRef?: ArtifactRef<"round-decision">;
  schemaVersion: 1;
  approvedPlanRef: ArtifactRef<"plan">;
  planVersion: number;
  attempt: number;
  priorRetryCount: number;
  modelTier: Decision<ModelTier>;
  reasoningTier: Decision<ReasoningTier>;
  effectiveConfidence: number;
}

export interface ImplementationArtifact {
  workerAttemptRef?: ArtifactRef<"implementation">;
  schemaVersion: 1;
  implementationRevision: number;
  approvedPlanRef: ArtifactRef<"plan">;
  executionRoutingRef: ArtifactRef<"execution-routing">;
  acceptedFindingsRef?: ArtifactRef<"accepted-findings">;
  executionProfile: ResolvedExecutionProfile;
  repository: {
    cwd?: string;
    outputSha256: string;
  };
  runId?: SubagentRunId;
  output: string;
}

export function isExecutionRoutingArtifact(
  value: unknown,
): value is ExecutionRoutingArtifact {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "schemaVersion",
      "approvedPlanRef",
      "planVersion",
      "attempt",
      "priorRetryCount",
      "modelTier",
      "reasoningTier",
      "effectiveConfidence",
      "freshness",
      "sourceDecisionRef",
    ]) &&
    (value.sourceDecisionRef === undefined ||
      (isArtifactRef(value.sourceDecisionRef) &&
        value.sourceDecisionRef.kind === "round-decision")) &&
    (value.freshness === undefined || isDecisionFreshness(value.freshness)) &&
    value.schemaVersion === 1 &&
    isArtifactRef(value.approvedPlanRef) &&
    value.approvedPlanRef.kind === "plan" &&
    isPositiveInteger(value.planVersion) &&
    isPositiveInteger(value.attempt) &&
    isNonNegativeInteger(value.priorRetryCount) &&
    isDecision(value.modelTier, isModelTier) &&
    isDecision(value.reasoningTier, isReasoningTier) &&
    isConfidence(value.effectiveConfidence) &&
    value.effectiveConfidence ===
      Math.min(value.modelTier.confidence, value.reasoningTier.confidence)
  );
}

export function isImplementationArtifact(
  value: unknown,
): value is ImplementationArtifact {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "implementationRevision",
      "approvedPlanRef",
      "executionRoutingRef",
      "acceptedFindingsRef",
      "executionProfile",
      "workerAttemptRef",
      "repository",
      "runId",
      "output",
    ]) ||
    value.schemaVersion !== 1 ||
    !isPositiveInteger(value.implementationRevision) ||
    !isArtifactRef(value.approvedPlanRef) ||
    value.approvedPlanRef.kind !== "plan" ||
    !isArtifactRef(value.executionRoutingRef) ||
    value.executionRoutingRef.kind !== "execution-routing" ||
    !optionalArtifact(
      value,
      "acceptedFindingsRef",
      (candidate) =>
        isArtifactRef(candidate) && candidate.kind === "accepted-findings",
    ) ||
    !optionalArtifact(
      value,
      "workerAttemptRef",
      (ref) => isArtifactRef(ref) && ref.kind === "implementation",
    ) ||
    !isResolvedExecutionProfile(value.executionProfile) ||
    !isRepositoryIdentity(value.repository) ||
    (value.runId !== undefined && !isSubagentRunId(value.runId)) ||
    !isNonEmptyString(value.output)
  ) {
    return false;
  }
  return true;
}

export function parseExecutionRoutingArtifact(
  value: unknown,
): ExecutionRoutingArtifact {
  if (!isExecutionRoutingArtifact(value)) {
    throw new CodingOrchestrationError("Invalid execution routing artifact");
  }
  return value;
}

export function parseImplementationArtifact(
  value: unknown,
): ImplementationArtifact {
  if (!isImplementationArtifact(value)) {
    throw new CodingOrchestrationError("Invalid implementation artifact");
  }
  return value;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function isDecision<T>(
  value: unknown,
  predicate: (candidate: unknown) => candidate is T,
): value is Decision<T> {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["value", "confidence"]) &&
    predicate(value.value) &&
    isConfidence(value.confidence)
  );
}

function isResolvedExecutionProfile(
  value: unknown,
): value is ResolvedExecutionProfile {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["provider", "model", "thinking"]) &&
    isNonEmptyString(value.provider) &&
    isNonEmptyString(value.model) &&
    isNonEmptyString(value.thinking)
  );
}

function isRepositoryIdentity(
  value: unknown,
): value is ImplementationArtifact["repository"] {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["cwd", "outputSha256"]) &&
    optionalString(value, "cwd") &&
    typeof value.outputSha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(value.outputSha256)
  );
}

function optionalString(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || isNonEmptyString(value[key]);
}

function optionalArtifact(
  value: Record<string, unknown>,
  key: string,
  predicate: (candidate: unknown) => boolean,
): boolean {
  return value[key] === undefined || predicate(value[key]);
}

export interface CodingEntryInput {
  state: WorkflowState;
  cwd?: string;
  changeScope?: string;
  /** Resume may re-evaluate stale routing after validating the durable evidence. */
  reconcileStaleRouting?: boolean;
}

export interface CodingOrchestratorDependencies {
  ownership?: OwnershipBoundary;
  repositoryCwd?: string;
  workerTimeoutMs?: number;
  artifactStore: WorkflowArtifactWriter;
  stateStore: WorkflowStateWriter;
  jevDecisionClient: JevDecisionClient;
  subagentExecutor: SubagentExecutor;
  configuration: OrchestratorConfiguration;
  plannotatorGate?: PlannotatorGate;
}

export interface CodingExecutionResult {
  state: WorkflowState;
  routingRef: ArtifactRef<"execution-routing">;
  implementationRef: ArtifactRef<"implementation">;
  runId?: SubagentRunId;
  executionProfile: ResolvedExecutionProfile;
}

export interface CodingStoppedResult {
  state: WorkflowState;
  routingRef: ArtifactRef<"execution-routing">;
  deviationRef: ArtifactRef<"plan-deviation">;
  implementationRef?: never;
  runId?: SubagentRunId;
  executionProfile: ResolvedExecutionProfile;
}
export type CodingResult = CodingExecutionResult | CodingStoppedResult;

export interface CodeReviewArtifact {
  schemaVersion: 1;
  attemptRef: ArtifactRef<"code-review">;
  attemptId: string;
  status: "approved" | "feedback";
  implementationRef: ArtifactRef<"implementation">;
  implementationRevision: number;
  result: CodeReviewResult;
}
export function isCodeReviewArtifact(
  value: unknown,
): value is CodeReviewArtifact {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "schemaVersion",
      "attemptRef",
      "attemptId",
      "status",
      "implementationRef",
      "implementationRevision",
      "result",
    ]) &&
    value.schemaVersion === 1 &&
    isArtifactRef(value.attemptRef) &&
    value.attemptRef.kind === "code-review" &&
    isNonEmptyString(value.attemptId) &&
    isArtifactRef(value.implementationRef) &&
    value.implementationRef.kind === "implementation" &&
    isPositiveInteger(value.implementationRevision) &&
    isRecord(value.result) &&
    hasOnlyKeys(value.result, ["approved", "feedback", "annotations"]) &&
    typeof value.result.approved === "boolean" &&
    (value.result.feedback === undefined ||
      typeof value.result.feedback === "string") &&
    (value.result.annotations === undefined ||
      Array.isArray(value.result.annotations)) &&
    value.status === (value.result.approved ? "approved" : "feedback")
  );
}
export function parseCodeReviewArtifact(value: unknown): CodeReviewArtifact {
  if (!isCodeReviewArtifact(value))
    throw new CodingOrchestrationError("Invalid code review artifact");
  return value;
}
export interface OpenCodeReviewInput {
  state: WorkflowState;
}
export interface ReconcileCodeReviewInput {
  state: WorkflowState;
  attemptId: string;
}
export type CodeReviewOutcome =
  | {
      status: "approved" | "feedback";
      state: WorkflowState;
      attemptId: string;
      reviewRef: ArtifactRef<"code-review">;
    }
  | { status: "blocked"; state: WorkflowState };
export type OpenCodeReviewResult = CodeReviewOutcome;

export class StaleCodeReviewError extends Error {
  constructor(
    message = "Code review does not match the current implementation",
  ) {
    super(message);
    this.name = "StaleCodeReviewError";
  }
}

export class CodeReviewSourceError extends StaleCodeReviewError {}

export class CodeReviewOpenAttemptError extends StaleCodeReviewError {
  constructor() {
    super(
      "An unresolved local Code Review attempt requires explicit recovery; no external status or reopen is available",
    );
    this.name = "CodeReviewOpenAttemptError";
  }
}

export class CodingOrchestrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CodingOrchestrationError";
  }
}

export class CodeReviewAuthorityError extends CodingOrchestrationError {
  constructor(options?: { cause?: unknown }) {
    super("Code Review authority could not be validated", options);
    this.name = "CodeReviewAuthorityError";
  }
}

interface PlanHeading {
  line: number;
  level: number;
  title: string;
}

interface PlanEvidence {
  summary: string;
  relevantSections: readonly {
    title: PlanSection;
    content: string;
  }[];
}

interface ReadableArtifactStore extends WorkflowArtifactWriter {
  readText<K extends ArtifactRef["kind"]>(ref: ArtifactRef<K>): Promise<string>;
  // Preserve the public ArtifactStore schema callback's inferred result type.
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters
  writeJson?<K extends ArtifactRef["kind"], R>(
    kind: K,
    fileName: string,
    value: unknown,
    schema: (value: unknown) => R,
  ): Promise<ArtifactRef<K>>;
}

function isReadableArtifactStore(
  store: WorkflowArtifactWriter,
): store is ReadableArtifactStore {
  return typeof store.readText === "function";
}

function requireArtifactStore(
  store: WorkflowArtifactWriter,
): ReadableArtifactStore {
  if (!isReadableArtifactStore(store)) {
    throw new CodingOrchestrationError(
      "Coding entry requires ArtifactStore.readText",
    );
  }
  return store;
}

function normalizeHeading(value: string): string {
  return value
    .replace(/[ \t]+#+[ \t]*$/u, "")
    .replace(/\s*\/\s*/gu, " / ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function findPlanHeadings(markdown: string): PlanHeading[] {
  const headings: PlanHeading[] = [];
  let fenced = false;
  const lines = markdown.split(/\r?\n/u);
  lines.forEach((line, lineNumber) => {
    if (/^\s*(`{3,}|~{3,})/u.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const match = /^(#{1,6})[ \t]+(.+?)[ \t]*$/u.exec(line);
    if (!match) return;
    headings.push({
      line: lineNumber,
      level: match[1].length,
      title: match[2],
    });
  });
  return headings;
}

function sectionBody(
  lines: readonly string[],
  headings: readonly PlanHeading[],
  heading: PlanHeading,
): string {
  const end =
    headings.find(
      (candidate) =>
        candidate.line > heading.line && candidate.level <= heading.level,
    )?.line ?? lines.length;
  return lines
    .slice(heading.line + 1, end)
    .join("\n")
    .trim();
}

function extractPlanEvidence(markdown: string): PlanEvidence {
  const lines = markdown.split(/\r?\n/u);
  const headings = findPlanHeadings(markdown);
  const relevantSections = routingPlanSections.flatMap((title) => {
    const heading = headings.find(
      (candidate) =>
        normalizeHeading(candidate.title) === normalizeHeading(title),
    );
    if (!heading) return [];
    const content = sectionBody(lines, headings, heading);
    if (content.length === 0) return [];
    return [
      {
        title,
        content: bound(
          content,
          CODING_ENTRY_EVIDENCE_LIMITS.maxPlanSectionChars,
        ),
      },
    ];
  });
  const scope = relevantSections.find(
    (section) => section.title === "Scope / Requirements",
  )?.content;
  const fallback = markdown
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
  return {
    summary: bound(
      scope ?? fallback ?? markdown.trim(),
      CODING_ENTRY_EVIDENCE_LIMITS.maxPlanSummaryChars,
    ),
    relevantSections,
  };
}

function bound(value: string, maximum: number): string {
  return value.slice(0, maximum);
}

function contextRefs(state: WorkflowState): readonly ArtifactRef[] {
  const candidates: Array<ArtifactRef | undefined> = [
    state.taskRef,
    state.planning.context.scoutRef,
    state.planning.context.researchRef,
    state.planning.context.clarificationRef,
  ];
  const refs = candidates.filter(
    (ref): ref is ArtifactRef => ref !== undefined,
  );
  if (refs.length > CODING_ENTRY_EVIDENCE_LIMITS.maxContextRefs) {
    throw new CodingOrchestrationError(
      "Too many context artifacts for routing",
    );
  }
  return refs;
}

function parseArtifact<T>(
  content: string,
  predicate: (value: unknown) => value is T,
  name: string,
): T {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new CodingOrchestrationError(`Invalid ${name} JSON artifact`, {
      cause: error,
    });
  }
  if (!predicate(value)) {
    throw new CodingOrchestrationError(`Invalid ${name} artifact`);
  }
  return value;
}

async function readAuthoritativeText(
  store: ReadableArtifactStore,
  ref: ArtifactRef,
  label: string,
): Promise<string> {
  try {
    validateArtifactRef(ref);
  } catch (error) {
    throw new CodingOrchestrationError(`Invalid ${label} artifact reference`, {
      cause: error,
    });
  }
  let content: string;
  try {
    content = await store.readText(ref);
  } catch (error) {
    throw new CodingOrchestrationError(
      `Unable to read authoritative ${label} artifact`,
      { cause: error },
    );
  }
  if (typeof content !== "string" || calculateSha256(content) !== ref.sha256) {
    throw new CodingOrchestrationError(
      `Authoritative ${label} artifact ref does not match its content`,
    );
  }
  return content;
}

export class WorkerAttemptAuthorityError extends CodingOrchestrationError {
  constructor(
    readonly reason:
      | "authority-inconsistent"
      | "authoritative-artifact-corrupt",
    readonly evidenceRef: ArtifactRef,
  ) {
    super(`Worker attempt authority rejected: ${reason}`);
    this.name = "WorkerAttemptAuthorityError";
  }
}

/** True only for the attempt that already published the current implementation. */
export async function validateCompletedWorkerAttempt(
  store: WorkflowArtifactWriter,
  state: WorkflowState,
  ref: ArtifactRef<"implementation">,
  attempt: WorkerAttemptEvidence,
  executor?: SubagentExecutor,
): Promise<boolean> {
  // An unpublished next attempt still belongs to reconciliation, not continuation.
  if (
    attempt.targetRevision !== state.coding.implementationRevision &&
    !sameArtifactRef(attempt.implementationRef, state.coding.implementationRef)
  )
    return false;
  if (
    attempt.status !== "succeeded" ||
    attempt.targetRevision !== state.coding.implementationRevision ||
    attempt.inputRevision !== state.coding.implementationRevision - 1 ||
    attempt.workflowId !== state.workflowId ||
    attempt.dispatch.ownerRunId !== state.workflowId ||
    attempt.launchStatus !== "observed" ||
    !attempt.launch ||
    !attempt.receipt ||
    !sameArtifactRef(attempt.implementationRef, state.coding.implementationRef)
  )
    throw new WorkerAttemptAuthorityError("authority-inconsistent", ref);
  try {
    const implementation = parseImplementationArtifact(
      JSON.parse(
        await readAuthoritativeText(
          requireArtifactStore(store),
          attempt.implementationRef!,
          "completed implementation",
        ),
      ),
    );
    if (
      attempt.receipt.launchContractDigest !==
        attempt.launch.launchContractDigest ||
      attempt.receipt.runId !== attempt.runId ||
      attempt.receipt.requestId !== attempt.dispatch.requestId ||
      attempt.launch.model !==
        `${attempt.executionProfile.provider}/${attempt.executionProfile.model}` ||
      attempt.launch.thinking !== attempt.executionProfile.thinking ||
      implementation.implementationRevision !== attempt.targetRevision ||
      implementation.runId !== attempt.runId ||
      !sameArtifactRef(
        implementation.approvedPlanRef,
        attempt.approvedPlanRef,
      ) ||
      !sameArtifactRef(
        implementation.executionRoutingRef,
        attempt.executionRoutingRef,
      ) ||
      !implementation.workerAttemptRef ||
      (!sameArtifactRef(implementation.workerAttemptRef, ref) &&
        !sameArtifactRef(
          implementation.workerAttemptRef,
          attempt.previousRef,
        )) ||
      calculateSha256(implementation.output) !==
        implementation.repository.outputSha256 ||
      !isDeepStrictEqual(
        implementation.executionProfile,
        attempt.executionProfile,
      ) ||
      attempt.after?.status !== "observed" ||
      attempt.before.root !== attempt.after.snapshot.root ||
      attempt.before.cwd !== attempt.after.snapshot.cwd
    )
      throw new Error("Completed implementation binding mismatch");

    // Compare historical authority, not the routing/findings for the next fix.
    const readable = requireArtifactStore(store);
    const observed = parseWorkerAttempt(
      JSON.parse(
        await readAuthoritativeText(
          readable,
          implementation.workerAttemptRef,
          "Worker result observation",
        ),
      ),
    );
    const identityFields = [
      "workflowId",
      "attemptId",
      "inputRevision",
      "targetRevision",
      "approvedPlanRef",
      "planVersion",
      "inputImplementationRef",
      "executionRoutingRef",
      "inputRefs",
      "executionProfile",
      "dispatch",
      "launch",
      "receipt",
      "runId",
      "launchStatus",
      "before",
      "resultDigest",
    ] as const;
    if (
      identityFields.some(
        (key) => !isDeepStrictEqual(observed[key], attempt[key]),
      ) ||
      (observed.after?.status === "observed" &&
        !isDeepStrictEqual(observed.after, attempt.after))
    )
      throw new Error("Completed Worker observation identity mismatch");
    const routing = parseExecutionRoutingArtifact(
      JSON.parse(
        await readAuthoritativeText(
          readable,
          attempt.executionRoutingRef,
          "completed execution routing",
        ),
      ),
    );
    if (
      !sameArtifactRef(routing.approvedPlanRef, attempt.approvedPlanRef) ||
      routing.planVersion !== attempt.planVersion ||
      routing.attempt !== attempt.targetRevision
    )
      throw new Error("Completed Worker routing binding mismatch");
    await validateWorkerStrategy(store, state, attempt, executor);
    parsePlan(
      await readAuthoritativeText(
        readable,
        attempt.approvedPlanRef,
        "completed Plan",
      ),
      {
        architectureRequired: state.planning.architectureRequired !== false,
      },
    );
  } catch (error) {
    if (error instanceof RuntimePortError && error.kind === "reconciliation")
      throw error;
    throw new WorkerAttemptAuthorityError(
      "authoritative-artifact-corrupt",
      attempt.implementationRef!,
    );
  }
  return true;
}

function requireApprovedPlan(state: WorkflowState): ArtifactRef<"plan"> {
  if (state.phase !== "implementing" && state.phase !== "fixing") {
    throw new CodingOrchestrationError(
      "Coding entry requires an approved plan in implementing or fixing phase",
    );
  }
  try {
    assertStateInvariants(state);
  } catch (error) {
    throw new CodingOrchestrationError(
      "Coding entry requires a valid approved plan",
      { cause: error },
    );
  }
  const ref = state.planning.approvedPlanRef;
  if (
    !ref ||
    state.planning.approvedPlanVersion === undefined ||
    !state.planning.currentPlanRef ||
    !sameArtifactRef(ref, state.planning.currentPlanRef) ||
    state.planning.approvedPlanVersion !== state.planning.currentPlanVersion
  ) {
    throw new CodingOrchestrationError(
      "Coding entry requires a valid approved plan",
    );
  }
  try {
    validateArtifactRef(ref);
  } catch (error) {
    throw new CodingOrchestrationError(
      "Coding entry requires a valid approved plan reference",
      { cause: error },
    );
  }
  return ref;
}

function routingAttempt(state: WorkflowState): number {
  const attempt = state.coding.implementationRevision + 1;
  if (!Number.isSafeInteger(attempt) || attempt <= 0) {
    throw new CodingOrchestrationError("Execution routing attempt is invalid");
  }
  return attempt;
}

function executionProfile(
  artifact: ExecutionRoutingArtifact,
  configuration: OrchestratorConfiguration,
): ResolvedExecutionProfile {
  return resolveExecutionProfile(
    configuration,
    artifact.modelTier.value,
    artifact.reasoningTier.value,
  );
}

function expectedArtifactRef<K extends ArtifactRef["kind"]>(
  kind: K,
  fileName: string,
  value: unknown,
): ArtifactRef<K> {
  const content = JSON.stringify(value);
  return createArtifactRef(kind, artifactRelativePath(kind, fileName), content);
}

async function persistJson<K extends ArtifactRef["kind"]>(
  store: ReadableArtifactStore,
  kind: K,
  fileName: string,
  value: unknown,
  schema: (candidate: unknown) => unknown,
): Promise<ArtifactRef<K>> {
  const content = JSON.stringify(value);
  const expected = expectedArtifactRef(kind, fileName, value);
  try {
    const ref = store.writeJson
      ? await store.writeJson(kind, fileName, value, schema)
      : await writeJsonFallback(store, kind, fileName, content, value, schema);
    validateArtifactRef(ref);
    if (!sameArtifactRef(ref, expected)) {
      throw new CodingOrchestrationError(
        `${kind} artifact writer returned a mismatched reference`,
      );
    }
    return ref;
  } catch (error) {
    if (!(error instanceof ArtifactImmutableError)) throw error;
    try {
      if ((await store.readText(expected)) === content) return expected;
    } catch {
      // An immutable collision with unreadable content is not reusable.
    }
    throw error;
  }
}

async function writeJsonFallback<K extends ArtifactRef["kind"]>(
  store: ReadableArtifactStore,
  kind: K,
  fileName: string,
  content: string,
  value: unknown,
  schema: (candidate: unknown) => unknown,
): Promise<ArtifactRef<K>> {
  const validated = schema(value);
  if (validated === false || validated === undefined) {
    throw new CodingOrchestrationError(`Invalid ${kind} artifact`);
  }
  return store.writeText(kind, fileName, content);
}

async function blockAndThrow(
  state: WorkflowState,
  reason:
    | "integration-unavailable"
    | "agent-infrastructure-unavailable"
    | "agent-execution-ambiguous"
    | "retry-budget-exhausted"
    | "operator-attention-required",
  stateStore: WorkflowStateWriter,
  error: unknown,
): Promise<never> {
  await advanceWorkflow(state, { type: "BLOCK", reason }, stateStore);
  if (error instanceof Error) throw error;
  throw new CodingOrchestrationError(String(error));
}

function codeReviewFileName(attemptId: string): string {
  if (!attemptId)
    throw new StaleCodeReviewError("Missing local Code Review attempt id");
  return `result-${encodeURIComponent(attemptId)}.json`;
}
type CurrentCodeReviewBinding = Pick<
  CodeReviewArtifact,
  "implementationRef" | "implementationRevision"
>;

function currentCodeReviewBinding(
  state: WorkflowState,
): CurrentCodeReviewBinding {
  const implementationRef = state.coding.implementationRef;
  const implementationRevision = state.coding.implementationRevision;
  if (!implementationRef || !isPositiveInteger(implementationRevision)) {
    throw new StaleCodeReviewError(
      "Code review requires a current implementation revision",
    );
  }
  return { implementationRef, implementationRevision };
}

function assertCodeReviewMatchesCurrent(
  state: WorkflowState,
  review: Pick<
    CodeReviewArtifact,
    "implementationRef" | "implementationRevision"
  >,
): void {
  const current = currentCodeReviewBinding(state);
  if (
    review.implementationRevision !== current.implementationRevision ||
    !sameArtifactRef(review.implementationRef, current.implementationRef)
  ) {
    throw new StaleCodeReviewError(
      "Code review result is stale for the current implementation revision",
    );
  }
}

function requirePersistedCodeReview(
  state: WorkflowState,
  attemptId: string,
): void {
  const binding = state.coding.codeReview;
  if (
    Object.keys(state.external).some((key) =>
      key.startsWith("plannotator.code-review."),
    )
  )
    throw new StaleCodeReviewError(
      "Legacy external Code identity cannot grant local authority",
    );
  if (
    !binding ||
    binding.attemptId !== attemptId ||
    !state.coding.codeReviewAttemptRef
  )
    throw new StaleCodeReviewError(
      "Missing or mismatched durable local Code Review binding",
    );
  assertCodeReviewMatchesCurrent(state, binding);
}

export class CodingOrchestrator {
  constructor(private readonly dependencies: CodingOrchestratorDependencies) {}

  async openCodeReview({
    state: inputState,
  }: OpenCodeReviewInput): Promise<OpenCodeReviewResult> {
    if (inputState.phase !== "awaiting-code-review")
      throw Error("Code review requires awaiting-code-review phase");
    const gate = this.dependencies.plannotatorGate;
    if (!gate) throw Error("PlannotatorGate is required");
    if (
      Object.keys(inputState.external).some((key) =>
        key.startsWith("plannotator.code-review."),
      )
    )
      throw new CodeReviewOpenAttemptError();
    if (inputState.coding.codeReviewAttemptRef && !inputState.coding.codeReview)
      throw new CodeReviewOpenAttemptError();
    if (inputState.coding.codeReview)
      return this.reconcileCodeReview({
        state: inputState,
        attemptId: inputState.coding.codeReview.attemptId,
      });
    await this.validateCodeReviewAuthority(inputState);
    const store = requireArtifactStore(this.dependencies.artifactStore);
    if (!store.rootDirectory)
      throw new StaleCodeReviewError("Missing durable Code Review storage");
    const authority = codingAuthority(inputState);
    const fileName = `attempt-r${authority.implementationRevision}.json`;
    // Orphan intent is a barrier even if its State publication failed.
    try {
      await readFile(
        join(
          store.rootDirectory,
          artifactRelativePath("code-review", fileName),
        ),
      );
      throw new CodeReviewOpenAttemptError();
    } catch (error) {
      if (
        !(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
      )
        throw error;
    }
    const implementation = parseImplementationArtifact(
      JSON.parse(
        await readAuthoritativeText(
          store,
          authority.implementationRef,
          "implementation",
        ),
      ),
    );
    const cwd =
      implementation.repository.cwd ?? this.dependencies.repositoryCwd;
    if (!cwd)
      throw new StaleCodeReviewError(
        "Code Review requires the implementation workspace",
      );
    if (!implementation.workerAttemptRef || !inputState.coding.workerAttemptRef)
      throw new StaleCodeReviewError(
        "Code Review requires durable Worker workspace evidence",
      );
    const worker = parseWorkerAttempt(
      JSON.parse(
        await readAuthoritativeText(
          store,
          inputState.coding.workerAttemptRef,
          "Worker attempt",
        ),
      ),
    );
    const snapshot = await captureWorkspace(
      cwd,
      store.rootDirectory,
      worker.before,
    ).catch(() => {
      throw new CodeReviewSourceError(
        "Code Review workspace/provider observation is unavailable",
      );
    });
    if (
      worker.workflowId !== inputState.workflowId ||
      worker.status !== "succeeded" ||
      !sameArtifactRef(worker.implementationRef, authority.implementationRef) ||
      !sameArtifactRef(worker.previousRef, implementation.workerAttemptRef) ||
      worker.targetRevision !== authority.implementationRevision ||
      !sameArtifactRef(worker.approvedPlanRef, authority.approvedPlanRef) ||
      worker.after?.status !== "observed" ||
      !isDeepStrictEqual(worker.after.snapshot, snapshot)
    )
      throw new CodeReviewSourceError(
        "Implementation workspace changed before Code Review",
      );
    const baseline = await readWorkspaceBaseline(
      store,
      inputState.coding.workerAttemptRef,
      worker,
    );
    if (!sameArtifactRef(baseline.ref, inputState.coding.workspaceBaselineRef))
      throw new CodeReviewSourceError(
        "Missing or changed original workspace baseline",
      );
    const patch = await workspaceReviewPatch(
      baseline.snapshot,
      snapshot,
      store.rootDirectory,
    ).catch(() => {
      throw new CodeReviewSourceError(
        "Code Review patch source is unsupported or unavailable",
      );
    });
    const patchRef = await store.writeText(
      "code-review",
      `patch-r${authority.implementationRevision}.diff`,
      patch,
    );
    const source: CodeReviewSource = {
      ...(snapshot.kind === "git"
        ? { type: "git-patch" as const }
        : {
            type: "filesystem-patch" as const,
            baselineRef: baseline.ref,
            workerAttemptRef: inputState.coding.workerAttemptRef,
          }),
      cwd: snapshot.cwd,
      patchFile: await realpath(join(store.rootDirectory, patchRef.path)),
      patchSha256: patchRef.sha256,
      workspaceDigest: calculateSha256(JSON.stringify(snapshot)),
    };
    await verifyCodeReviewSource(source, store.rootDirectory).catch(() => {
      throw new CodeReviewSourceError(
        "Code Review source changed during preparation",
      );
    });
    const attempt: CodeReviewAttempt = {
      schemaVersion: 1,
      recordType: "code-review-attempt",
      authority,
      attemptId: randomUUID(),
      requestId: randomUUID(),
      source,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    const attemptRef = await persistJson(
      store,
      "code-review",
      fileName,
      attempt,
      isCodeReviewAttempt,
    );
    const pending = structuredClone(inputState);
    pending.coding.codeReviewAttemptRef = attemptRef;
    pending.coding.codeReview = {
      attemptId: attempt.attemptId,
      implementationRef: authority.implementationRef,
      implementationRevision: authority.implementationRevision,
    };
    const state = await this.dependencies.stateStore.saveState(
      pending,
      inputState.stateRevision,
    );
    await this.readCodeReviewAttempt(state, attempt.attemptId);
    let result: CodeReviewResult;
    try {
      result = await gate.openCodeReview({
        requestId: attempt.requestId,
        cwd: source.cwd,
        patchFile: source.patchFile,
      });
    } catch (error) {
      if (error instanceof RuntimePortError && error.kind === "reconciliation")
        throw new StaleCodeReviewError(error.message);
      return {
        status: "blocked",
        state: await advanceWorkflow(
          state,
          {
            type: "BLOCK",
            reason: "human-gate-unavailable",
            evidenceRef: attemptRef,
          },
          this.dependencies.stateStore,
        ),
      };
    }
    return this.applyCodeReview({
      state,
      attemptId: attempt.attemptId,
      result,
    });
  }

  private async readCodeReviewAttempt(
    state: WorkflowState,
    attemptId: string,
  ): Promise<CodeReviewAttempt> {
    requirePersistedCodeReview(state, attemptId);
    const store = requireArtifactStore(this.dependencies.artifactStore);
    const attempt = parseArtifact(
      await readAuthoritativeText(
        store,
        state.coding.codeReviewAttemptRef!,
        "Code Review attempt",
      ),
      isCodeReviewAttempt,
      "Code Review attempt",
    );
    assertCodingAuthority(state, attempt.authority);
    if (attempt.attemptId !== attemptId)
      throw new StaleCodeReviewError(
        "Local Code Review attempt identity changed",
      );
    if (!store.rootDirectory)
      throw new StaleCodeReviewError("Missing durable Code Review storage");
    if (
      attempt.source.type === "filesystem-patch" &&
      (!sameArtifactRef(
        attempt.source.workerAttemptRef,
        state.coding.workerAttemptRef,
      ) ||
        !sameArtifactRef(
          attempt.source.baselineRef,
          state.coding.workspaceBaselineRef,
        ))
    )
      throw new CodeReviewSourceError(
        "Code Review belongs to a different Worker snapshot",
      );
    try {
      await verifyCodeReviewSource(attempt.source, store.rootDirectory);
    } catch (error) {
      throw new CodeReviewSourceError(
        error instanceof Error ? error.message : String(error),
      );
    }
    return attempt;
  }

  async reconcileCodeReview({
    state,
    attemptId,
  }: ReconcileCodeReviewInput): Promise<CodeReviewOutcome> {
    requirePersistedCodeReview(state, attemptId);
    const store = requireArtifactStore(this.dependencies.artifactStore);
    let content: string;
    try {
      content = await readFile(
        join(
          store.rootDirectory!,
          artifactRelativePath("code-review", codeReviewFileName(attemptId)),
        ),
        "utf8",
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      )
        throw new CodeReviewOpenAttemptError();
      throw error;
    }
    const ref = createArtifactRef(
      "code-review",
      artifactRelativePath("code-review", codeReviewFileName(attemptId)),
      content,
    );
    const artifact = parseCodeReviewArtifact(
      JSON.parse(await readAuthoritativeText(store, ref, "Code Review result")),
    );
    if (
      artifact.attemptId !== attemptId ||
      !sameArtifactRef(artifact.attemptRef, state.coding.codeReviewAttemptRef)
    )
      throw new StaleCodeReviewError(
        "Recovered Code Review result has another local binding",
      );
    assertCodeReviewMatchesCurrent(state, artifact);
    return this.applyCodeReview({ state, attemptId, result: artifact.result });
  }

  async applyCodeReview({
    state: submittedState,
    attemptId,
    result,
  }: {
    state: WorkflowState;
    attemptId: string;
    result: CodeReviewResult;
  }): Promise<CodeReviewOutcome> {
    const root = requireArtifactStore(
      this.dependencies.artifactStore,
    ).rootDirectory;
    if (!root)
      throw new StaleCodeReviewError("Missing durable Code Review storage");
    const state = await new StateStore(root).loadState();
    if (state.workflowId !== submittedState.workflowId)
      throw new StaleCodeReviewError(
        "Workflow identity changed during Code Review",
      );
    const attempt = await this.readCodeReviewAttempt(state, attemptId);
    await this.validateCodeReviewAuthority(state);
    const artifact: CodeReviewArtifact = {
      schemaVersion: 1,
      attemptRef: state.coding.codeReviewAttemptRef!,
      attemptId,
      status: result.approved ? "approved" : "feedback",
      implementationRef: attempt.authority.implementationRef,
      implementationRevision: attempt.authority.implementationRevision,
      result: structuredClone(result),
    };
    parseCodeReviewArtifact(artifact);
    const store = requireArtifactStore(this.dependencies.artifactStore);
    const expectedRef = createArtifactRef(
      "code-review",
      artifactRelativePath("code-review", codeReviewFileName(attemptId)),
      JSON.stringify(artifact),
    );
    if (sameArtifactRef(state.coding.latestCodeReviewRef, expectedRef)) {
      await readAuthoritativeText(store, expectedRef, "Code Review result");
      return {
        status: artifact.status,
        state,
        attemptId,
        reviewRef: expectedRef,
      };
    }
    if (
      state.coding.latestCodeReviewRef ||
      state.phase !== "awaiting-code-review"
    )
      throw new StaleCodeReviewError(
        "Changed settled result or stale Code Review phase",
      );
    const reviewRef = await persistJson(
      store,
      "code-review",
      codeReviewFileName(attemptId),
      artifact,
      parseCodeReviewArtifact,
    );
    const next = await advanceWorkflow(
      state,
      artifact.status === "approved"
        ? { type: "CODE_APPROVED", reviewRef }
        : { type: "CODE_FEEDBACK", feedbackRef: reviewRef },
      this.dependencies.stateStore,
    );
    return { status: artifact.status, state: next, attemptId, reviewRef };
  }

  private async validateCodeReviewAuthority(
    state: WorkflowState,
  ): Promise<void> {
    try {
      const store = requireArtifactStore(this.dependencies.artifactStore);
      assertStateInvariants(state);
      const planRef = state.planning.approvedPlanRef;
      if (!planRef) throw new Error("Missing approved Plan authority");
      parsePlan(await readAuthoritativeText(store, planRef, "approved plan"), {
        architectureRequired: state.planning.architectureRequired !== false,
      });
      const current = currentCodeReviewBinding(state);
      const implementation = parseImplementationArtifact(
        JSON.parse(
          await readAuthoritativeText(
            store,
            current.implementationRef,
            "implementation",
          ),
        ),
      );
      if (
        implementation.implementationRevision !==
          current.implementationRevision ||
        !sameArtifactRef(implementation.approvedPlanRef, planRef) ||
        !sameArtifactRef(
          implementation.executionRoutingRef,
          state.coding.executionRoutingRef,
        ) ||
        calculateSha256(implementation.output) !==
          implementation.repository.outputSha256
      )
        throw new Error(
          "Implementation artifact binding or output hash mismatch",
        );
    } catch (error) {
      if (error instanceof CodeReviewAuthorityError) throw error;
      throw new CodeReviewAuthorityError({ cause: error });
    }
  }

  async execute(input: CodingEntryInput): Promise<CodingResult> {
    const store = requireArtifactStore(this.dependencies.artifactStore);
    const approvedPlanRef = requireApprovedPlan(input.state);
    const previousAttemptRef = input.state.coding.workerAttemptRef;
    const baselineRef = input.state.coding.workspaceBaselineRef;
    const initialBaseline = baselineRef
      ? parseWorkerAttempt(
          JSON.parse(
            await readAuthoritativeText(
              store,
              baselineRef,
              "original workspace baseline",
            ),
          ),
        )
      : undefined;
    if (
      (previousAttemptRef && !initialBaseline) ||
      (initialBaseline &&
        (initialBaseline.workflowId !== input.state.workflowId ||
          initialBaseline.inputRevision !== 0 ||
          initialBaseline.status !== "intent" ||
          initialBaseline.previousRef))
    )
      throw new CodingOrchestrationError(
        "Missing or invalid original workspace baseline",
      );
    let previousAttempt: WorkerAttemptEvidence | undefined;
    if (previousAttemptRef) {
      let completed: boolean;
      try {
        previousAttempt = parseWorkerAttempt(
          JSON.parse(
            await readAuthoritativeText(
              store,
              previousAttemptRef,
              "Worker attempt",
            ),
          ),
        );
        completed =
          (await validateStoppedWorker(
            store,
            input.state,
            previousAttemptRef,
            previousAttempt,
          )) ||
          (await validateCompletedWorkerAttempt(
            store,
            input.state,
            previousAttemptRef,
            previousAttempt,
            this.dependencies.subagentExecutor,
          ));
      } catch (error) {
        if (
          error instanceof RuntimePortError &&
          error.kind === "reconciliation"
        )
          return blockAndThrow(
            input.state,
            "operator-attention-required",
            this.dependencies.stateStore,
            error,
          );
        await advanceWorkflow(
          input.state,
          {
            type: "FAIL",
            reason:
              error instanceof WorkerAttemptAuthorityError
                ? error.reason
                : "authoritative-artifact-corrupt",
            evidenceRef:
              error instanceof WorkerAttemptAuthorityError
                ? error.evidenceRef
                : previousAttemptRef,
          },
          this.dependencies.stateStore,
        );
        throw error;
      }
      if (!completed) {
        return blockAndThrow(
          input.state,
          "agent-execution-ambiguous",
          this.dependencies.stateStore,
          new CodingOrchestrationError(
            "Worker attempt requires exact reconciliation before another dispatch",
          ),
        );
      }
    }
    if (
      input.state.phase === "implementing" &&
      input.state.counters.automatedFixRoundsUsed >=
        this.dependencies.configuration.retries.maxAutomatedFixRounds
    ) {
      return blockAndThrow(
        input.state,
        "retry-budget-exhausted",
        this.dependencies.stateStore,
        new CodingOrchestrationError(
          "Automated retry budget is exhausted before Worker launch",
        ),
      );
    }
    const planContent = await readAuthoritativeText(
      store,
      approvedPlanRef,
      "approved plan",
    );
    const method = await new PlanningRouting(this.dependencies).method(
      input.state,
      true,
    );
    const parsedPlan = parsePlan(planContent, {
      architectureRequired: input.state.planning.architectureRequired !== false,
      developmentMethod: method.method,
    });
    const planEvidence = extractPlanEvidence(planContent);
    const refs = contextRefs(input.state);
    const contextEvidence = await Promise.all(
      refs.map(async (ref) => ({
        ref,
        content: bound(
          await readAuthoritativeText(store, ref, `context ${ref.kind}`),
          CODING_ENTRY_EVIDENCE_LIMITS.maxContextEvidenceChars,
        ),
      })),
    );
    const changeScope = bound(
      input.changeScope?.trim() || planEvidence.summary,
      CODING_ENTRY_EVIDENCE_LIMITS.maxPlanSummaryChars,
    );
    if (changeScope.length === 0) {
      throw new CodingOrchestrationError("Coding entry change scope is empty");
    }

    const routingInput = {
      approvedPlanRef,
      planEvidence,
      playbook: input.state.playbook,
      changeScope,
      contextRefs: refs,
      contextEvidence,
      priorRetryCount: input.state.counters.automatedFixRoundsUsed,
    } as const;
    const authorityRefs: ArtifactRef[] = [approvedPlanRef, ...refs];
    for (const ref of [
      input.state.coding.implementationRef,
      input.state.coding.roundDecisionRef,
      input.state.coding.acceptedFindingsRef,
      input.state.coding.latestCodeReviewRef,
    ]) {
      if (ref) {
        // Verify each authority ref before it can enter the routing input.
        // oxlint-disable-next-line eslint/no-await-in-loop
        await readAuthoritativeText(store, ref, "routing input");
        authorityRefs.push(ref);
      }
    }
    const freshness = decisionFreshness(
      input.state,
      routingInput,
      authorityRefs,
      this.dependencies.configuration,
    );
    let routingArtifact: ExecutionRoutingArtifact;
    let routingRef = input.state.coding.executionRoutingRef;
    let priorRouting: ExecutionRoutingArtifact | undefined;
    if (routingRef) {
      const routingContent = await readAuthoritativeText(
        store,
        routingRef,
        "execution routing",
      );
      routingArtifact = parseArtifact(
        routingContent,
        isExecutionRoutingArtifact,
        "execution routing",
      );
      if (
        !sameArtifactRef(routingArtifact.approvedPlanRef, approvedPlanRef) ||
        routingArtifact.planVersion !== input.state.planning.approvedPlanVersion
      ) {
        throw new CodingOrchestrationError(
          "Execution routing decision does not match the approved plan",
        );
      }
      const authorization = new JevAuthorization(
        input.state,
        this.dependencies.configuration.jev,
        store,
        this.dependencies.stateStore,
        "routing",
        ["plan", "context"],
      );
      try {
        await authorization.assertAllowed(false);
      } catch (error) {
        return blockAndThrow(
          authorization.state,
          jevBlockedReason(error),
          this.dependencies.stateStore,
          error,
        );
      }
      priorRouting = routingArtifact;
      if (!isDecisionFresh(routingArtifact.freshness, freshness)) {
        if (
          !input.reconcileStaleRouting &&
          (input.state.phase !== "fixing" || !routingArtifact.freshness)
        )
          throw new CodingOrchestrationError(
            "Stale execution routing freshness; reconciliation required",
          );
        routingRef = undefined;
      }
    }
    if (!routingRef) {
      const authorization = new JevAuthorization(
        input.state,
        this.dependencies.configuration.jev,
        store,
        this.dependencies.stateStore,
        "routing",
        ["plan", "context"],
      );
      let rawDecision;
      try {
        await authorization.assertAllowed();
        rawDecision = await this.dependencies.jevDecisionClient.routeExecution(
          routingInput,
          authorization.context,
        );
        input = { ...input, state: authorization.state };
      } catch (error) {
        return blockAndThrow(
          authorization.state,
          jevBlockedReason(error),
          this.dependencies.stateStore,
          error,
        );
      }
      const decision = resolveExecutionRouting(rawDecision, {
        autoDecisionThreshold:
          this.dependencies.configuration.decision.autoDecisionThreshold,
        escalationThreshold:
          this.dependencies.configuration.decision.escalationThreshold,
      });
      if (priorRouting && input.state.counters.strongerRetriesUsed > 0) {
        const models = ["ECONOMY", "STANDARD", "STRONG"] as const;
        const reasoning = ["LOW", "MEDIUM", "HIGH"] as const;
        if (
          models.indexOf(decision.modelTier.value) <
          models.indexOf(priorRouting.modelTier.value)
        )
          decision.modelTier.value = priorRouting.modelTier.value;
        if (
          reasoning.indexOf(decision.reasoningTier.value) <
          reasoning.indexOf(priorRouting.reasoningTier.value)
        )
          decision.reasoningTier.value = priorRouting.reasoningTier.value;
      }
      routingArtifact = {
        freshness,
        schemaVersion: 1,
        approvedPlanRef,
        planVersion: input.state.planning.approvedPlanVersion!,
        attempt: routingAttempt(input.state),
        priorRetryCount: input.state.counters.automatedFixRoundsUsed,
        modelTier: decision.modelTier,
        reasoningTier: decision.reasoningTier,
        effectiveConfidence: decision.effectiveConfidence,
      };
      routingRef = await persistJson(
        store,
        "execution-routing",
        `execution-routing-${routingArtifact.attempt}-${freshness.inputDigest.slice(0, 16)}-${freshness.configurationDigest.slice(0, 16)}.json`,
        routingArtifact,
        isExecutionRoutingArtifact,
      );
    }

    let routedState =
      routingRef === input.state.coding.executionRoutingRef
        ? input.state
        : await advanceWorkflow(
            input.state,
            { type: "EXECUTION_ROUTED", decisionRef: routingRef },
            this.dependencies.stateStore,
          );
    const resolvedProfile = executionProfile(
      routingArtifact!,
      this.dependencies.configuration,
    );

    let acceptedFindingsRef: ArtifactRef<"accepted-findings"> | undefined;
    let humanCodeFeedbackRef: ArtifactRef<"code-review"> | undefined;
    if (routedState.phase === "fixing") {
      const candidate = routedState.coding.acceptedFindingsRef;
      if (candidate) {
        if (candidate.kind !== "accepted-findings") {
          throw new CodingOrchestrationError(
            "Fix Worker requires an accepted-findings artifact reference",
          );
        }
        const acceptedContent = await readAuthoritativeText(
          store,
          candidate,
          "accepted findings",
        );
        const acceptedArtifact = parseArtifact(
          acceptedContent,
          isAcceptedFindingsArtifact,
          "accepted findings",
        );
        if (
          !sameArtifactRef(acceptedArtifact.approvedPlanRef, approvedPlanRef) ||
          acceptedArtifact.planVersion !==
            input.state.planning.currentPlanVersion ||
          acceptedArtifact.implementationRevision !==
            routedState.coding.implementationRevision ||
          acceptedArtifact.round !== routedState.coding.reviewRound
        ) {
          throw new CodingOrchestrationError(
            "Accepted findings artifact does not match the current coding authority",
          );
        }
        assertCodingAuthority(routedState, acceptedArtifact.authority);
        acceptedFindingsRef = candidate;
      }

      const feedbackCandidate = routedState.coding.latestCodeReviewRef;
      if (feedbackCandidate) {
        const feedbackContent = await readAuthoritativeText(
          store,
          feedbackCandidate,
          "human code feedback",
        );
        const feedbackArtifact = parseArtifact(
          feedbackContent,
          isCodeReviewArtifact,
          "human code feedback",
        );
        const codeReviewBinding = routedState.coding.codeReview;
        if (
          feedbackArtifact.status !== "feedback" ||
          !sameArtifactRef(
            feedbackArtifact.implementationRef,
            routedState.coding.implementationRef,
          ) ||
          feedbackArtifact.implementationRevision !==
            routedState.coding.implementationRevision ||
          !codeReviewBinding ||
          feedbackArtifact.attemptId !== codeReviewBinding.attemptId ||
          !sameArtifactRef(
            feedbackArtifact.attemptRef,
            routedState.coding.codeReviewAttemptRef,
          )
        ) {
          throw new CodingOrchestrationError(
            "Human code feedback does not match the current coding authority",
          );
        }
        humanCodeFeedbackRef = feedbackCandidate;
      }
    }

    const workerInput: WorkerInput = {
      developmentMethod: parsedPlan.developmentMethod,
      testSeams: parsedPlan.testSeams,
      developmentMethodRef: input.state.planning.developmentMethodRef!,
      skills: parsedPlan.supportingSkills,
      approvedPlanRef,
      contextRefs: refs,
      executionProfile: resolvedProfile,
      ...(acceptedFindingsRef ? { acceptedFindingsRef } : {}),
      ...(humanCodeFeedbackRef ? { humanCodeFeedbackRef } : {}),
    };
    if (this.dependencies.ownership) {
      routedState = await this.dependencies.ownership.validate(
        routedState,
        this.dependencies.stateStore,
      );
      if (routedState.phase === "blocked")
        throw new CodingOrchestrationError(
          "Workspace ownership changed before Worker authority",
        );
    }
    let before: WorkspaceSnapshot;
    try {
      if (!store.rootDirectory)
        throw new CodingOrchestrationError(
          "Worker evidence requires a rooted ArtifactStore",
        );
      before = await captureWorkspace(
        input.cwd ??
          this.dependencies.repositoryCwd ??
          input.state.projectRoot ??
          process.cwd(),
        store.rootDirectory,
        initialBaseline?.before,
      );
      if (input.state.projectRoot) {
        const scoped = relative(
          await realpath(input.state.projectRoot),
          before.cwd,
        );
        if (scoped.startsWith("..") || isAbsolute(scoped))
          throw Error("Worker cwd is outside workflow project scope");
      }
      if (
        initialBaseline &&
        !previousAttempt &&
        !isDeepStrictEqual(initialBaseline.before, before)
      )
        throw Error(
          "Workspace changed since proven non-dispatch; reconcile before new mutation",
        );
      if (previousAttempt) {
        assertWorkspaceIdentity(previousAttempt.before, before);
        if (
          previousAttempt.after?.status !== "observed" ||
          (!this.dependencies.ownership &&
            !isDeepStrictEqual(previousAttempt.after.snapshot, before))
        )
          throw Error(
            "Workspace changed since previous Worker; reconcile before new mutation",
          );
      }
      if (
        previousAttempt?.status === "deviated" &&
        (previousAttempt.after?.status !== "observed" ||
          (!this.dependencies.ownership &&
            !isDeepStrictEqual(previousAttempt.after.snapshot, before)))
      )
        throw new Error(
          "Workspace changed since stopped Worker; reconcile before new mutation",
        );
    } catch (error) {
      return blockAndThrow(
        routedState,
        "agent-infrastructure-unavailable",
        this.dependencies.stateStore,
        error,
      );
    }
    const timeoutMs =
      this.dependencies.workerTimeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw new CodingOrchestrationError("Invalid Worker deadline");
    const attemptId = randomUUID();
    const dispatch = {
      requestId: randomUUID(),
      ownerRunId: routedState.workflowId,
      nodeId: `worker-${attemptId}`,
      deadline: new Date(Date.now() + timeoutMs).toISOString(),
    };
    const workerRequest: AgentRunRequest = {
      ...createWorkerRequest(
        {
          ...workerInput,
          deviationBinding: {
            workflowId: routedState.workflowId,
            attemptId,
            approvedPlanRef,
            planVersion: routedState.planning.approvedPlanVersion!,
            inputRevision: routedState.coding.implementationRevision,
          },
        },
        { cwd: before.cwd },
      ),
      dispatch,
    };
    const intent: WorkerAttemptEvidence = {
      schemaVersion: 1,
      recordType: "worker-attempt",
      workflowId: routedState.workflowId,
      attemptId,
      inputRevision: routedState.coding.implementationRevision,
      targetRevision: routedState.coding.implementationRevision + 1,
      approvedPlanRef,
      planVersion: routedState.planning.approvedPlanVersion!,
      executionRoutingRef: routingRef,
      inputRefs: workerRequest.inputRefs ?? [],
      executionProfile: resolvedProfile,
      dispatch,
      observedAt: new Date().toISOString(),
      status: "intent",
      launchStatus: "unknown",
      before,
      ...(previousAttemptRef || baselineRef
        ? { previousRef: previousAttemptRef ?? baselineRef }
        : {}),
      ...(routedState.coding.implementationRef
        ? { inputImplementationRef: routedState.coding.implementationRef }
        : {}),
    };
    const intentRef = await persistJson(
      store,
      "implementation",
      `attempt-${attemptId}-intent.json`,
      intent,
      parseWorkerAttempt,
    );
    routedState = await this.dependencies.stateStore.saveState(
      {
        ...routedState,
        coding: {
          ...routedState.coding,
          workerAttemptRef: intentRef,
          workspaceBaselineRef: baselineRef ?? intentRef,
        },
      },
      routedState.stateRevision,
    );
    let workerResult: AgentRunResult;
    try {
      workerRequest.onPrepared = async (launch) => {
        const current = await captureWorkspace(
          before.cwd,
          store.rootDirectory,
          before,
        );
        if (!isDeepStrictEqual(current, before))
          throw Error("Workspace changed before Worker dispatch");
        intent.launch = launch;
        const ref = await persistJson(
          store,
          "implementation",
          `attempt-${attemptId}-launch.json`,
          { ...intent, previousRef: routedState.coding.workerAttemptRef },
          parseWorkerAttempt,
        );
        routedState = await this.dependencies.stateStore.saveState(
          {
            ...routedState,
            coding: { ...routedState.coding, workerAttemptRef: ref },
          },
          routedState.stateRevision,
        );
      };
      workerRequest.onStarted = async (receipt) => {
        intent.receipt = receipt;
        const ref = await persistJson(
          store,
          "implementation",
          `attempt-${attemptId}-receipt.json`,
          {
            ...intent,
            previousRef: routedState.coding.workerAttemptRef,
            status: "ambiguous",
            launchStatus: "observed",
            runId: subagentRunId(receipt.runId),
            after: { status: "pending" },
          },
          parseWorkerAttempt,
        );
        routedState = await this.dependencies.stateStore.saveState(
          {
            ...routedState,
            coding: { ...routedState.coding, workerAttemptRef: ref },
          },
          routedState.stateRevision,
        );
      };
      workerResult =
        await this.dependencies.subagentExecutor.run(workerRequest);
    } catch (error) {
      workerResult =
        error instanceof SubagentNotDispatchedError
          ? {
              status: "failed",
              notDispatched: true,
              error: "Adapter could not dispatch the request",
            }
          : {
              status: "ambiguous",
              timedOut:
                error instanceof RuntimePortError && error.kind === "timeout",
              reason: "Dispatch outcome is unknown",
            };
    }
    let after: NonNullable<WorkerAttemptEvidence["after"]> = {
      status: "pending",
    };
    const matchesDispatch =
      !workerResult.dispatch ||
      JSON.stringify(workerResult.dispatch) === JSON.stringify(dispatch);
    const validRunId =
      matchesDispatch &&
      typeof workerResult.runId === "string" &&
      workerResult.runId.trim()
        ? workerResult.runId
        : undefined;
    const resultDigest = calculateSha256(JSON.stringify(workerResult));
    const recordObservation = async (
      status: WorkerAttemptEvidence["status"],
      implementationRef?: ArtifactRef<"implementation">,
      suffix = "result",
    ) => {
      const record: WorkerAttemptEvidence = {
        ...intent,
        previousRef: routedState.coding.workerAttemptRef!,
        status,
        after,
        launchStatus:
          workerResult.status === "failed" && workerResult.notDispatched
            ? "not-started"
            : validRunId
              ? "observed"
              : "unknown",
        observedAt: new Date().toISOString(),
        ...(validRunId ? { runId: validRunId } : {}),
        resultDigest,
        ...(implementationRef ? { implementationRef } : {}),
      };
      const ref = await persistJson(
        store,
        "implementation",
        `attempt-${attemptId}-${suffix}.json`,
        record,
        parseWorkerAttempt,
      );
      routedState = await this.dependencies.stateStore.saveState(
        {
          ...routedState,
          coding: { ...routedState.coding, workerAttemptRef: ref },
        },
        routedState.stateRevision,
      );
      return ref;
    };
    // Capture the exposed identity before any post-run subprocess or file scan.
    await recordObservation("ambiguous", undefined, "received");
    try {
      const snapshot = await captureWorkspace(
        before.cwd,
        store.rootDirectory,
        before,
      );
      if (snapshot.root !== before.root) throw Error("Repository root changed");
      after = { status: "observed", snapshot };
    } catch {
      after = { status: "unavailable", reason: "observation-failed" };
    }
    const successful =
      workerResult.status === "succeeded" &&
      validRunId &&
      typeof workerResult.output === "string" &&
      workerResult.output.trim() &&
      intent.launch &&
      intent.receipt &&
      intent.receipt.launchContractDigest ===
        intent.launch.launchContractDigest &&
      intent.receipt.runId === validRunId &&
      intent.receipt.requestId === dispatch.requestId &&
      intent.receipt.agent === workerRequest.agent &&
      intent.receipt.cwd === before.cwd &&
      after.status === "observed";
    if (!successful || workerResult.status !== "succeeded") {
      const status =
        workerResult.status === "failed"
          ? "failed"
          : workerResult.status === "ambiguous" && workerResult.timedOut
            ? "timed-out"
            : "ambiguous";
      const ref = await recordObservation(status);
      await advanceWorkflow(
        routedState,
        {
          type: "BLOCK",
          reason:
            status === "failed"
              ? "agent-infrastructure-unavailable"
              : "agent-execution-ambiguous",
          evidenceRef: ref,
        },
        this.dependencies.stateStore,
      );
      throw new CodingOrchestrationError(`Worker did not succeed: ${status}`);
    }

    // Transport success can be a terminal stop, never implementation success.
    try {
      if (workerDeviation(workerResult.output)) {
        const observedRef = await recordObservation(
          "ambiguous",
          undefined,
          "observed",
        );
        const observed = parseWorkerAttempt(
          JSON.parse(
            await readAuthoritativeText(store, observedRef, "stopped Worker"),
          ),
        );
        const stopped = await publishPlanDeviation(
          routedState,
          observedRef,
          observed,
          workerResult.output,
          this.dependencies,
        );
        return {
          ...stopped,
          routingRef,
          runId: workerResult.runId,
          executionProfile: resolvedProfile,
        };
      }
    } catch (error) {
      // Persistence/stop-signal failures leave the exact attempt as a recovery barrier.
      try {
        await advanceWorkflow(
          routedState,
          {
            type: "BLOCK",
            reason: "agent-execution-ambiguous",
            evidenceRef: routedState.coding.workerAttemptRef,
          },
          this.dependencies.stateStore,
        );
      } catch {
        /* Original error wins; CAS/attempt barrier still forbids redispatch. */
      }
      throw error;
    }

    const implementationRevision =
      routedState.coding.implementationRevision + 1;
    if (!Number.isSafeInteger(implementationRevision)) {
      throw new CodingOrchestrationError(
        "Implementation revision cannot be incremented safely",
      );
    }
    const implementationArtifact: ImplementationArtifact = {
      schemaVersion: 1,
      workerAttemptRef: routedState.coding.workerAttemptRef!,
      implementationRevision,
      approvedPlanRef,
      executionRoutingRef: routingRef,
      ...(acceptedFindingsRef ? { acceptedFindingsRef } : {}),
      executionProfile: resolvedProfile,
      repository: {
        cwd: before.cwd,
        outputSha256: calculateSha256(workerResult.output),
      },
      ...(workerResult.runId ? { runId: workerResult.runId } : {}),
      output: workerResult.output,
    };
    let implementationRef: ArtifactRef<"implementation">;
    try {
      implementationRef = await persistJson(
        store,
        "implementation",
        `implementation-${implementationRevision}.json`,
        implementationArtifact,
        isImplementationArtifact,
      );
    } catch (error) {
      // The Worker already ran; do not leave an active state that can relaunch
      // it blindly when the result Artifact cannot be made authoritative.
      try {
        await advanceWorkflow(
          routedState,
          {
            type: "BLOCK",
            reason: "agent-execution-ambiguous",
            evidenceRef: routedState.coding.workerAttemptRef,
          },

          this.dependencies.stateStore,
        );
      } catch {
        // Preserve the original Artifact persistence error.
      }
      throw error;
    }
    await recordObservation("succeeded", implementationRef);
    let completed: WorkflowState;
    try {
      completed = await advanceWorkflow(
        routedState,
        {
          type: "IMPLEMENTATION_COMPLETE",
          resultRef: implementationRef,
          ...(workerResult.runId ? { runId: workerResult.runId } : {}),
        },
        this.dependencies.stateStore,
      );
    } catch (error) {
      // The Worker already ran. If State can still be written, record the
      // durable result as a consistency failure so a restart cannot relaunch it.
      try {
        await advanceWorkflow(
          routedState,
          {
            type: "BLOCK",
            reason: "agent-execution-ambiguous",
            evidenceRef: implementationRef,
          },
          this.dependencies.stateStore,
        );
      } catch {
        // Preserve the original State persistence error; recovery owns the
        // remaining orphan-artifact reconciliation boundary.
      }
      throw error;
    }
    return {
      state: completed,
      routingRef,
      implementationRef,
      ...(workerResult.runId ? { runId: workerResult.runId } : {}),
      executionProfile: resolvedProfile,
    };
  }
}

export async function executeCodingEntry(
  input: CodingEntryInput,
  dependencies: CodingOrchestratorDependencies,
): Promise<CodingResult> {
  return new CodingOrchestrator(dependencies).execute(input);
}

export async function openCodeReview(
  input: OpenCodeReviewInput,
  dependencies: CodingOrchestratorDependencies,
): Promise<OpenCodeReviewResult> {
  return new CodingOrchestrator(dependencies).openCodeReview(input);
}

export async function reconcileCodeReview(
  input: ReconcileCodeReviewInput,
  dependencies: CodingOrchestratorDependencies,
): Promise<CodeReviewOutcome> {
  return new CodingOrchestrator(dependencies).reconcileCodeReview(input);
}

export const runCoding = executeCodingEntry;
