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
import type { SubagentRunId } from "../../types.ts";
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
  type JevDecisionClient,
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

export const CODING_ENTRY_EVIDENCE_LIMITS = {
  maxPlanSummaryChars: 2_000,
  maxPlanSectionChars: 3_000,
  maxContextEvidenceChars: 2_000,
  maxContextRefs: 8,
} as const;

const routingPlanSections: readonly PlanSection[] = [
  "Scope / Requirements",
  "Architecture / Design",
  "Implementation Plan",
];

export interface ExecutionRoutingArtifact {
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
    ]) &&
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
    !isResolvedExecutionProfile(value.executionProfile) ||
    !isRepositoryIdentity(value.repository) ||
    !optionalString(value, "runId") ||
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
}

export interface CodingOrchestratorDependencies {
  artifactStore: WorkflowArtifactWriter;
  stateStore: WorkflowStateWriter;
  jevDecisionClient: JevDecisionClient;
  subagentExecutor: SubagentExecutor;
  configuration: OrchestratorConfiguration;
}

export interface CodingExecutionResult {
  state: WorkflowState;
  routingRef: ArtifactRef<"execution-routing">;
  implementationRef: ArtifactRef<"implementation">;
  runId?: SubagentRunId;
  executionProfile: ResolvedExecutionProfile;
}

export class CodingOrchestrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CodingOrchestrationError";
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
  writeJson?<K extends ArtifactRef["kind"], R>(
    kind: K,
    fileName: string,
    value: unknown,
    schema: (value: unknown) => R,
  ): Promise<ArtifactRef<K>>;
}

function requireArtifactStore(
  store: WorkflowArtifactWriter,
): ReadableArtifactStore {
  if (typeof store.readText !== "function") {
    throw new CodingOrchestrationError(
      "Coding entry requires ArtifactStore.readText",
    );
  }
  return store as ReadableArtifactStore;
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

function blockedReason(
  error: unknown,
):
  | "integration-unavailable"
  | "agent-infrastructure-unavailable"
  | "agent-execution-ambiguous" {
  if (error instanceof RuntimePortError && error.kind === "reconciliation") {
    return "agent-execution-ambiguous";
  }
  return "agent-infrastructure-unavailable";
}

function resultBlockedReason(
  result: AgentRunResult,
): "agent-infrastructure-unavailable" | "agent-execution-ambiguous" {
  return result.status === "ambiguous"
    ? "agent-execution-ambiguous"
    : "agent-infrastructure-unavailable";
}

async function blockAndThrow(
  state: WorkflowState,
  reason:
    | "integration-unavailable"
    | "agent-infrastructure-unavailable"
    | "agent-execution-ambiguous",
  stateStore: WorkflowStateWriter,
  error: unknown,
): Promise<never> {
  await advanceWorkflow(state, { type: "BLOCK", reason }, stateStore);
  if (error instanceof Error) throw error;
  throw new CodingOrchestrationError(String(error));
}

export class CodingOrchestrator {
  constructor(private readonly dependencies: CodingOrchestratorDependencies) {}

  async execute(input: CodingEntryInput): Promise<CodingExecutionResult> {
    const store = requireArtifactStore(this.dependencies.artifactStore);
    const approvedPlanRef = requireApprovedPlan(input.state);
    const planContent = await readAuthoritativeText(
      store,
      approvedPlanRef,
      "approved plan",
    );
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

    let routingArtifact: ExecutionRoutingArtifact;
    let routingRef = input.state.coding.executionRoutingRef;
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
    } else {
      const routingInput = {
        approvedPlanRef,
        planEvidence,
        playbook: input.state.playbook,
        changeScope,
        contextRefs: refs,
        contextEvidence,
        priorRetryCount: input.state.counters.automatedFixRoundsUsed,
      } as const;
      let rawDecision;
      try {
        rawDecision =
          await this.dependencies.jevDecisionClient.routeExecution(
            routingInput,
          );
      } catch (error) {
        return blockAndThrow(
          input.state,
          "integration-unavailable",
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
      routingArtifact = {
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
        `execution-routing-${routingArtifact.attempt}.json`,
        routingArtifact,
        isExecutionRoutingArtifact,
      );
    }

    const routedState =
      routingRef === input.state.coding.executionRoutingRef
        ? input.state
        : await advanceWorkflow(
            input.state,
            { type: "EXECUTION_ROUTED", decisionRef: routingRef },
            this.dependencies.stateStore,
          );
    const resolvedProfile = executionProfile(
      routingArtifact,
      this.dependencies.configuration,
    );

    let acceptedFindingsRef: ArtifactRef<"accepted-findings"> | undefined;
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
            routedState.coding.implementationRevision
        ) {
          throw new CodingOrchestrationError(
            "Accepted findings artifact does not match the current coding authority",
          );
        }
        acceptedFindingsRef = candidate;
      }
    }

    const workerInput: WorkerInput = {
      approvedPlanRef,
      contextRefs: refs,
      executionProfile: resolvedProfile,
      ...(acceptedFindingsRef ? { acceptedFindingsRef } : {}),
    };
    const workerRequest = createWorkerRequest(workerInput, { cwd: input.cwd });
    let workerResult: AgentRunResult;
    try {
      workerResult =
        await this.dependencies.subagentExecutor.run(workerRequest);
    } catch (error) {
      return blockAndThrow(
        routedState,
        blockedReason(error),
        this.dependencies.stateStore,
        error,
      );
    }
    if (workerResult.status !== "succeeded") {
      const error = new CodingOrchestrationError(
        `Worker did not succeed: ${workerResult.status}`,
        { cause: workerResult },
      );
      return blockAndThrow(
        routedState,
        resultBlockedReason(workerResult),
        this.dependencies.stateStore,
        error,
      );
    }
    if (
      typeof workerResult.output !== "string" ||
      workerResult.output.trim().length === 0 ||
      (workerResult.runId !== undefined &&
        typeof workerResult.runId !== "string")
    ) {
      return blockAndThrow(
        routedState,
        "agent-execution-ambiguous",
        this.dependencies.stateStore,
        new CodingOrchestrationError("Worker returned an invalid result"),
      );
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
      implementationRevision,
      approvedPlanRef,
      executionRoutingRef: routingRef,
      ...(acceptedFindingsRef ? { acceptedFindingsRef } : {}),
      executionProfile: resolvedProfile,
      repository: {
        ...(input.cwd ? { cwd: input.cwd } : {}),
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
          { type: "FAIL", reason: "persistence-consistency-failure" },
          this.dependencies.stateStore,
        );
      } catch {
        // Preserve the original Artifact persistence error.
      }
      throw error;
    }
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
            type: "FAIL",
            reason: "persistence-consistency-failure",
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
): Promise<CodingExecutionResult> {
  return new CodingOrchestrator(dependencies).execute(input);
}

export const runCoding = executeCodingEntry;
