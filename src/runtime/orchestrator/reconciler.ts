import { randomUUID } from "node:crypto";
import { PlanningAgentPendingError } from "./planning-agent-run.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ArtifactKind,
  ArtifactRef,
} from "../../core/artifacts/references.ts";
import { isArtifactRef } from "../../core/artifacts/references.ts";
import { isRecord } from "../../core/schema.ts";
import { parsePlan } from "../planning/plan-parser.ts";
import type { OrchestratorConfiguration } from "../../core/configuration.ts";
import {
  parseAcceptedFindingsArtifact,
  parseFindingEvaluationArtifact,
  parseRoundDecisionArtifact,
  parseValidationResult,
  type FindingEvaluationArtifact,
  type RoundDecisionArtifact,
  type ValidationResult,
} from "../../core/decisions/types.ts";
import {
  assertStateInvariants,
  sameArtifactRef,
} from "../../core/workflow/invariants.ts";
import type {
  WorkflowEvent,
  WorkflowState,
} from "../../core/workflow/state.ts";
import type { WorkflowPhase } from "../../core/workflow/phase.ts";
import {
  calculateSha256,
  createArtifactRef,
  ArtifactImmutableError,
  validateArtifactRef,
} from "../persistence/artifact-store.ts";
import { artifactRelativePath } from "../persistence/artifact-paths.ts";
import type {
  AgentRunResult,
  AgentRunStatus,
  ClarificationPort,
  JevDecisionClient,
  PlannotatorGate,
  SubagentExecutor,
  ValidationExecutor,
} from "../ports/index.ts";
import { RuntimePortError } from "../ports/errors.ts";
import { subagentRunId, type SubagentRunId } from "../../types.ts";
import {
  captureRepository,
  type RepositorySnapshot,
} from "../worker/repository-evidence.ts";
import {
  parseWorkerAttempt,
  type WorkerAttemptEvidence,
} from "../worker/attempt-evidence.ts";
import {
  PlanningOrchestrator,
  type WorkflowArtifactWriter,
} from "./planning-orchestrator.ts";
import {
  CodingOrchestrator,
  validateCompletedWorkerAttempt,
  WorkerAttemptAuthorityError,
  CodeReviewAuthorityError,
  CodeReviewOpenAttemptError,
  StaleCodeReviewError,
  isImplementationArtifact,
  parseExecutionRoutingArtifact,
  parseImplementationArtifact,
  type CodingOrchestratorDependencies,
  type ImplementationArtifact,
} from "./coding-orchestrator.ts";
import type { WorkflowStateWriter } from "./advance-workflow.ts";
import { advanceWorkflow } from "./advance-workflow.ts";
import {
  ValidationRunner,
  type ValidationRunnerDependencies,
} from "./validation-runner.ts";
import { ReviewRunner, parseReviewArtifact } from "./review-runner.ts";
import {
  FindingEvaluationRunner,
  persistedFindings,
  type FindingEvaluationRunnerDependencies,
} from "./finding-evaluation.ts";
import {
  assembleCodingEvidence,
  assertValidationAuthority,
  decisionFreshness,
  reviewEvidenceRefs,
  sourcedFindings,
} from "./coding-evidence.ts";
import {
  RoundDecisionRunner,
  type RoundDecisionRunnerDependencies,
} from "./round-decision.ts";
import { routeRoundDecision } from "../../core/decisions/round-decision.ts";
import { isDecisionFresh } from "../../core/decisions/decision-freshness.ts";
import { assertCodingAuthority } from "../../core/coding/authority.ts";

export type ReconciliationStatus =
  | "advanced"
  | "pending"
  | "blocked"
  | "failed";

export interface ReconciliationArtifact {
  schemaVersion: 1;
  recordType: "workflow-reconciliation";
  workflowId: string;
  phase: WorkflowPhase;
  outcome: "advanced" | "pending" | "blocked" | "failed";
  sourceStateRevision: number;
  observedAt: string;
  reason?: string;
  evidenceRefs: readonly ArtifactRef[];
}

export interface ReconciliationResult {
  status: ReconciliationStatus;
  state: WorkflowState;
  phase: WorkflowPhase;
  reconciliationRef?: ArtifactRef<"reconciliation">;
  reason?: string;
}

export interface ResumeReconcilerDependencies {
  artifactStore: WorkflowArtifactWriter;
  stateStore: WorkflowStateWriter;
  loadState?: () => Promise<WorkflowState>;
  subagentExecutor: SubagentExecutor;
  jevDecisionClient?: JevDecisionClient;
  validationExecutor?: ValidationExecutor;
  configuration?: OrchestratorConfiguration;
  plannotatorGate?: PlannotatorGate;
  clarificationPort?: ClarificationPort;
  repositoryCwd?: string;
  cwd?: string;
  changeScope?: string;
  clarificationPrompt?: string;
  now?: () => string;
}

export class ReconciliationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ReconciliationError";
  }
}

class IncompleteReviewArtifactsError extends ReconciliationError {
  readonly evidenceRef?: ArtifactRef;

  constructor(message: string, evidenceRef?: ArtifactRef) {
    super(message);
    this.name = "IncompleteReviewArtifactsError";
    this.evidenceRef = evidenceRef;
  }
}

function isDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Number.isFinite(Date.parse(value))
  );
}

export function isReconciliationArtifact(
  value: unknown,
): value is ReconciliationArtifact {
  if (!isRecord(value)) return false;
  const candidate = value;
  const keys = Object.keys(candidate);
  const expected = [
    "evidenceRefs",
    "observedAt",
    "outcome",
    "phase",
    "recordType",
    "schemaVersion",
    "sourceStateRevision",
    "workflowId",
  ];
  if (candidate.reason !== undefined) expected.push("reason");
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key)) &&
    candidate.schemaVersion === 1 &&
    candidate.recordType === "workflow-reconciliation" &&
    typeof candidate.workflowId === "string" &&
    typeof candidate.phase === "string" &&
    typeof candidate.outcome === "string" &&
    ["advanced", "pending", "blocked", "failed"].includes(candidate.outcome) &&
    typeof candidate.sourceStateRevision === "number" &&
    Number.isSafeInteger(candidate.sourceStateRevision) &&
    isDate(candidate.observedAt) &&
    (candidate.reason === undefined || typeof candidate.reason === "string") &&
    Array.isArray(candidate.evidenceRefs) &&
    candidate.evidenceRefs.every(isArtifactRef)
  );
}

type ReadableWorkflowArtifactWriter = WorkflowArtifactWriter & {
  readText(ref: ArtifactRef): Promise<string>;
};

function isReadable(
  store: WorkflowArtifactWriter,
): store is ReadableWorkflowArtifactWriter {
  return typeof store.readText === "function";
}

function asReadable(
  store: WorkflowArtifactWriter,
): ReadableWorkflowArtifactWriter {
  if (!isReadable(store))
    throw new ReconciliationError("Resume requires a readable ArtifactStore");
  return store;
}

function sameDispatch(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const sensitiveIdentityValue =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[oprs]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/giu;

function safeDiagnostic(value: string): string {
  return value
    .replace(/Bearer\s+[^\s,;]+/giu, "Bearer [redacted]")
    .replace(
      /((?:api[_-]?key|auth(?:orization)?|credential|password|secret|token)\s*[:=]\s*)([^\s,;]+)/giu,
      "$1[redacted]",
    )
    .replace(sensitiveIdentityValue, "[redacted]")
    .replace(/https?:\/\/[^/\s:@]+:[^@\s]+@/giu, "https://[redacted]@");
}

async function readAuthoritativeText(
  store: WorkflowArtifactWriter,
  ref: ArtifactRef,
  label: string,
): Promise<string> {
  const readable = asReadable(store);
  try {
    validateArtifactRef(ref);
    const content = await readable.readText(ref);
    if (calculateSha256(content) !== ref.sha256)
      throw new Error("hash mismatch");
    return content;
  } catch (error) {
    throw new ReconciliationError(
      `Unable to read authoritative ${label} artifact`,
      { cause: error },
    );
  }
}

async function readJson<T>(
  store: WorkflowArtifactWriter,
  ref: ArtifactRef,
  parser: (value: unknown) => T,
  label: string,
): Promise<T> {
  const content = await readAuthoritativeText(store, ref, label);
  try {
    return parser(JSON.parse(content));
  } catch (error) {
    throw new ReconciliationError(`Invalid ${label} artifact`, {
      cause: error,
    });
  }
}

function expectedRef<K extends ArtifactKind>(
  kind: K,
  fileName: string,
  value: unknown,
): ArtifactRef<K> {
  return createArtifactRef(
    kind,
    artifactRelativePath(kind, fileName),
    JSON.stringify(value),
  );
}

async function persistJson<K extends ArtifactKind>(
  store: WorkflowArtifactWriter,
  kind: K,
  fileName: string,
  value: unknown,
  schema: (value: unknown) => unknown,
): Promise<ArtifactRef<K>> {
  const content = JSON.stringify(value);
  const expected = expectedRef(kind, fileName, value);
  try {
    const ref = store.writeJson
      ? await store.writeJson(kind, fileName, value, schema)
      : await store.writeText(kind, fileName, content);
    if (!sameArtifactRef(ref, expected))
      throw new ReconciliationError(`${kind} ArtifactRef mismatch`);
    return ref;
  } catch (error) {
    if (error instanceof ArtifactImmutableError && store.readText) {
      try {
        if ((await store.readText(expected)) === content) return expected;
      } catch {
        // Preserve the immutable collision.
      }
    }
    throw error;
  }
}

function withoutObservationTime(value: WorkerAttemptEvidence) {
  const clone: Partial<WorkerAttemptEvidence> = structuredClone(value);
  delete clone.observedAt;
  return clone;
}

function sameWorkerRecordIgnoringObservationTime(
  left: WorkerAttemptEvidence,
  right: WorkerAttemptEvidence,
): boolean {
  return (
    JSON.stringify(withoutObservationTime(left)) ===
    JSON.stringify(withoutObservationTime(right))
  );
}

async function persistWorkerRecord(
  store: WorkflowArtifactWriter,
  fileName: string,
  value: WorkerAttemptEvidence,
): Promise<ArtifactRef<"implementation">> {
  try {
    return await persistJson(
      store,
      "implementation",
      fileName,
      value,
      parseWorkerAttempt,
    );
  } catch (error) {
    if (!(error instanceof ArtifactImmutableError)) throw error;
    const existing = await discoverArtifact(store, "implementation", fileName);
    if (!existing) throw error;
    const persisted = await readJson(
      store,
      existing,
      parseWorkerAttempt,
      "Worker attempt",
    );
    if (!sameWorkerRecordIgnoringObservationTime(persisted, value)) throw error;
    return existing;
  }
}

async function persistImplementationRecord(
  store: WorkflowArtifactWriter,
  fileName: string,
  value: ImplementationArtifact,
): Promise<ArtifactRef<"implementation">> {
  try {
    return await persistJson(
      store,
      "implementation",
      fileName,
      value,
      isImplementationArtifact,
    );
  } catch (error) {
    if (!(error instanceof ArtifactImmutableError)) throw error;
    const existing = await discoverArtifact(store, "implementation", fileName);
    if (!existing) throw error;
    const persisted = await readJson(
      store,
      existing,
      parseImplementationArtifact,
      "implementation",
    );
    if (
      persisted.implementationRevision !== value.implementationRevision ||
      !sameArtifactRef(persisted.approvedPlanRef, value.approvedPlanRef) ||
      !sameArtifactRef(
        persisted.executionRoutingRef,
        value.executionRoutingRef,
      ) ||
      persisted.runId !== value.runId ||
      !persisted.workerAttemptRef ||
      !value.workerAttemptRef ||
      !sameArtifactRef(persisted.workerAttemptRef, value.workerAttemptRef) ||
      persisted.repository.outputSha256 !== value.repository.outputSha256 ||
      persisted.repository.cwd !== value.repository.cwd ||
      JSON.stringify(persisted.executionProfile) !==
        JSON.stringify(value.executionProfile) ||
      persisted.output !== value.output ||
      (persisted.acceptedFindingsRef
        ? !sameArtifactRef(
            persisted.acceptedFindingsRef,
            value.acceptedFindingsRef,
          )
        : value.acceptedFindingsRef !== undefined)
    ) {
      throw error;
    }
    return existing;
  }
}

async function discoverArtifact<K extends ArtifactKind>(
  store: WorkflowArtifactWriter,
  kind: K,
  fileName: string,
): Promise<ArtifactRef<K> | undefined> {
  const root = store.rootDirectory;
  if (!root || !store.readText) return undefined;
  const path = join(root, artifactRelativePath(kind, fileName));
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  const ref = createArtifactRef(
    kind,
    artifactRelativePath(kind, fileName),
    content,
  );
  try {
    await store.readText(ref);
    return ref;
  } catch {
    return undefined;
  }
}

function planFileName(version: number): string {
  return `plan-v${version}.md`;
}

function reviewFileName(
  kind: "correctness-review" | "ponytail-review",
  round: number,
): string {
  return `${kind === "correctness-review" ? "correctness" : "ponytail"}-${round}.json`;
}

function roundDecisionFileName(revision: number): string {
  return `round-decision-${revision}.json`;
}

function validationFileName(revision: number): string {
  return `validation-${revision}.json`;
}

function findingEvaluationFileName(round: number): string {
  return `finding-evaluation-${round}.json`;
}

function acceptedFindingsFileName(round: number): string {
  return `accepted-findings-${round}.json`;
}

export class WorkflowReconciler {
  private readonly now: () => string;
  private readonly deps: ResumeReconcilerDependencies;

  constructor(dependencies: ResumeReconcilerDependencies) {
    this.deps = dependencies;
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  async reconcile(state: WorkflowState): Promise<ReconciliationResult> {
    try {
      assertStateInvariants(state);
    } catch (error) {
      throw new ReconciliationError(
        "Persisted Workflow State is not recoverable",
        { cause: error },
      );
    }
    if (state.phase === "blocked") return this.reconcileBlocked(state);
    switch (state.phase) {
      case "gathering-context":
        return this.reconcileContext(state);
      case "clarifying":
        return this.reconcileClarification(state);
      case "planning":
        return this.reconcilePlanning(state);
      case "awaiting-plan-review":
        return this.reconcilePlanGate(state);
      case "implementing":
      case "fixing":
        return this.reconcileCoding(state);
      case "validating":
        return this.reconcileValidation(state);
      case "reviewing":
        return this.reconcileReview(state);
      case "awaiting-code-review":
        return this.reconcileCodeGate(state);
      case "completed":
        return { status: "advanced", state, phase: state.phase };
      case "failed":
        return {
          status: "failed",
          state,
          phase: state.phase,
          reason: state.failure?.reason,
        };
    }
    throw new ReconciliationError(
      `Unsupported workflow phase: ${String(state.phase)}`,
    );
  }

  private async record(
    state: WorkflowState,
    outcome: ReconciliationArtifact["outcome"],
    evidenceRefs: readonly ArtifactRef[] = [],
    reason?: string,
  ): Promise<ArtifactRef<"reconciliation">> {
    const value: ReconciliationArtifact = {
      schemaVersion: 1,
      recordType: "workflow-reconciliation",
      workflowId: state.workflowId,
      phase: state.phase,
      outcome,
      sourceStateRevision: state.stateRevision,
      observedAt: this.now(),
      ...(reason ? { reason: safeDiagnostic(reason) } : {}),
      evidenceRefs: [...evidenceRefs],
    };
    return persistJson(
      this.deps.artifactStore,
      "reconciliation",
      `reconciliation-${randomUUID()}.json`,
      value,
      isReconciliationArtifact,
    );
  }

  private async block(
    state: WorkflowState,
    reason: Extract<WorkflowState["block"], { reason: string }>["reason"],
    evidenceRef?: ArtifactRef,
    message?: string,
  ): Promise<ReconciliationResult> {
    const reconciliationRef = await this.record(
      state,
      "blocked",
      evidenceRef ? [evidenceRef] : [],
      message,
    );
    const next = await advanceWorkflow(
      state,
      {
        type: "BLOCK",
        reason,
        evidenceRef: reconciliationRef,
      },
      this.deps.stateStore,
    );
    return {
      status: "blocked",
      state: next,
      phase: next.phase,
      reconciliationRef,
      reason,
    };
  }

  private async fail(
    state: WorkflowState,
    reason: Extract<
      NonNullable<WorkflowState["failure"]>,
      { reason: string }
    >["reason"],
    evidenceRef?: ArtifactRef,
  ): Promise<ReconciliationResult> {
    const reconciliationRef = await this.record(
      state,
      "failed",
      evidenceRef ? [evidenceRef] : [],
      reason,
    );
    const next = await advanceWorkflow(
      state,
      {
        type: "FAIL",
        reason,
        evidenceRef: reconciliationRef,
      },
      this.deps.stateStore,
    );
    return {
      status: "failed",
      state: next,
      phase: next.phase,
      reconciliationRef,
      reason,
    };
  }

  private async transition(
    state: WorkflowState,
    event: WorkflowEvent,
    evidenceRefs: readonly ArtifactRef[] = [],
  ): Promise<ReconciliationResult> {
    const reconciliationRef = await this.record(
      state,
      "advanced",
      evidenceRefs,
    );
    const next = await advanceWorkflow(state, event, this.deps.stateStore);
    return {
      status: "advanced",
      state: next,
      phase: next.phase,
      reconciliationRef,
    };
  }

  private async reconcileContext(
    state: WorkflowState,
  ): Promise<ReconciliationResult> {
    let current = state;
    const store = this.deps.artifactStore;
    const stage = state.planning.context.scoutRef ? "research" : "scout";
    const attempt =
      stage === "research" &&
      (!state.planning.researchRequired || state.planning.context.researchRef)
        ? undefined
        : state.planning.agentAttempts?.[stage];
    if (attempt && !attempt.receipt && !attempt.notDispatched) {
      // Observation must not race the original dispatch's receipt save.
      return {
        status: "blocked",
        state,
        phase: state.phase,
        reason:
          "Planning launch identity is not yet durable; do not redispatch",
      };
    }
    if (!current.planning.agentAttempts && !current.planning.context.scoutRef) {
      const ref = await discoverArtifact(store, "scout", "scout.md");
      if (ref) {
        current = await advanceWorkflow(
          current,
          { type: "CONTEXT_EVIDENCE_PERSISTED", scoutRef: ref },
          this.deps.stateStore,
        );
      }
    }
    if (
      !current.planning.agentAttempts &&
      current.planning.researchRequired &&
      !current.planning.context.researchRef
    ) {
      const ref = await discoverArtifact(store, "research", "research.md");
      if (ref) {
        current = await advanceWorkflow(
          current,
          { type: "CONTEXT_EVIDENCE_PERSISTED", researchRef: ref },
          this.deps.stateStore,
        );
      }
    }
    if (
      current.planning.context.scoutRef &&
      (!current.planning.researchRequired ||
        current.planning.context.researchRef)
    ) {
      return this.transition(
        current,
        current.planning.clarificationRequired
          ? { type: "CLARIFICATION_REQUIRED" }
          : { type: "CONTEXT_READY" },
        [
          current.planning.context.scoutRef,
          ...(current.planning.context.researchRef
            ? [current.planning.context.researchRef]
            : []),
        ],
      );
    }
    const orchestrator = new PlanningOrchestrator({
      artifactStore: store,
      stateStore: this.deps.stateStore,
      subagentExecutor: this.deps.subagentExecutor,
      clarificationPort: this.deps.clarificationPort,
    });
    try {
      const result = await orchestrator.gatherContext({
        state: current,
        cwd: this.deps.cwd ?? this.deps.repositoryCwd,
      });
      return {
        status:
          result.state.phase === "blocked"
            ? "blocked"
            : result.state.phase === "gathering-context"
              ? "pending"
              : "advanced",
        state: result.state,
        phase: result.state.phase,
      };
    } catch (error) {
      if (error instanceof Error && /planning policy/iu.test(error.message))
        return this.block(
          current,
          "operator-attention-required",
          undefined,
          error.message,
        );
      const durable = await this.loadCurrentState(current);
      if (durable.phase === "blocked")
        return { status: "blocked", state: durable, phase: durable.phase };
      throw error;
    }
  }

  private async reconcileClarification(
    state: WorkflowState,
  ): Promise<ReconciliationResult> {
    if (!this.deps.clarificationPort || !this.deps.clarificationPrompt) {
      return this.block(
        state,
        "operator-attention-required",
        undefined,
        "Clarification requires an explicit Human prompt; it must not be inferred from transient state",
      );
    }
    const result = await new PlanningOrchestrator({
      artifactStore: this.deps.artifactStore,
      stateStore: this.deps.stateStore,
      subagentExecutor: this.deps.subagentExecutor,
      clarificationPort: this.deps.clarificationPort,
    }).requestClarification({
      state,
      prompt: this.deps.clarificationPrompt,
    });
    if (result.status === "provided")
      return {
        status: "advanced",
        state: result.state,
        phase: result.state.phase,
      };
    if (result.status === "blocked")
      return {
        status: "blocked",
        state: result.state,
        phase: result.state.phase,
      };
    return {
      status: "pending",
      state: result.state,
      phase: result.state.phase,
    };
  }

  private async reconcilePlanning(
    state: WorkflowState,
  ): Promise<ReconciliationResult> {
    const store = this.deps.artifactStore;
    const version = state.planning.currentPlanVersion + 1;
    const attempt = state.planning.agentAttempts?.[`plan-v${version}`];
    if (attempt && !attempt.receipt && !attempt.notDispatched) {
      return {
        status: "blocked",
        state,
        phase: state.phase,
        reason:
          "Planning launch identity is not yet durable; do not redispatch",
      };
    }
    const existing = state.planning.agentAttempts
      ? undefined
      : await discoverArtifact(store, "plan", planFileName(version));
    if (existing) {
      try {
        const content = await readAuthoritativeText(store, existing, "plan");
        parsePlan(content, {
          architectureRequired: state.planning.architectureRequired !== false,
        });
        return this.transition(
          state,
          { type: "PLAN_CREATED", planRef: existing, version },
          [existing],
        );
      } catch (error) {
        return this.block(
          state,
          "operator-attention-required",
          existing,
          error instanceof Error
            ? error.message
            : "Malformed orphan Plan artifact",
        );
      }
    }
    const orchestrator = new PlanningOrchestrator({
      artifactStore: store,
      stateStore: this.deps.stateStore,
      subagentExecutor: this.deps.subagentExecutor,
      plannotatorGate: this.deps.plannotatorGate,
    });
    try {
      const result = await orchestrator.createPlan({
        state,
        cwd: this.deps.cwd ?? this.deps.repositoryCwd,
      });
      return {
        status: result.state.phase === "blocked" ? "blocked" : "advanced",
        state: result.state,
        phase: result.state.phase,
      };
    } catch (error) {
      if (error instanceof PlanningAgentPendingError)
        return {
          status: "pending",
          state: error.state,
          phase: error.state.phase,
        };
      if (error instanceof Error && /planning policy/iu.test(error.message))
        return this.block(
          state,
          "operator-attention-required",
          undefined,
          error.message,
        );
      const durable = await this.loadCurrentState(state);
      if (durable.phase === "blocked")
        return { status: "blocked", state: durable, phase: durable.phase };
      throw error;
    }
  }

  private async reconcilePlanGate(
    state: WorkflowState,
  ): Promise<ReconciliationResult> {
    const gate = this.deps.plannotatorGate;
    if (!gate)
      return this.block(
        state,
        "human-gate-unavailable",
        undefined,
        "Plan Gate integration is unavailable",
      );
    const binding = state.planning.planReview;
    const identity =
      state.external[
        `plannotator.plan-review.v${state.planning.currentPlanVersion}`
      ];
    if (!binding && identity) {
      return this.block(
        state,
        "operator-attention-required",
        undefined,
        "Plan review identity exists without its exact durable binding",
      );
    }
    if (!binding) {
      // An open review is not transactional with State. Resume must not guess that no orphan exists.
      return this.block(
        state,
        "human-gate-unavailable",
        undefined,
        "Possible orphan Plan review; explicit external reconciliation is required",
      );
    }
    try {
      const outcome = await new PlanningOrchestrator({
        artifactStore: this.deps.artifactStore,
        stateStore: this.deps.stateStore,
        subagentExecutor: this.deps.subagentExecutor,
        plannotatorGate: gate,
      }).reconcilePlanReview({ state, reviewId: binding.reviewId });
      if (outcome.status === "approved" || outcome.status === "feedback") {
        return {
          status: "advanced",
          state: outcome.state,
          phase: outcome.state.phase,
        };
      }
      if (outcome.status === "blocked")
        return {
          status: "blocked",
          state: outcome.state,
          phase: outcome.state.phase,
        };
      return {
        status: "pending",
        state: outcome.state,
        phase: outcome.state.phase,
        reason: outcome.status === "unknown" ? outcome.reason : undefined,
      };
    } catch (error) {
      if (error instanceof RuntimePortError || error instanceof Error) {
        return this.block(
          state,
          "operator-attention-required",
          undefined,
          error.message,
        );
      }
      throw error;
    }
  }

  private codingDependencies(): CodingOrchestratorDependencies {
    if (!this.deps.configuration || !this.deps.jevDecisionClient) {
      throw new ReconciliationError(
        "Coding resume requires configuration and JevDecisionClient",
      );
    }
    return {
      artifactStore: this.deps.artifactStore,
      stateStore: this.deps.stateStore,
      subagentExecutor: this.deps.subagentExecutor,
      jevDecisionClient: this.deps.jevDecisionClient,
      configuration: this.deps.configuration,
      plannotatorGate: this.deps.plannotatorGate,
      repositoryCwd: this.deps.repositoryCwd,
    };
  }

  private async reconcileCoding(
    state: WorkflowState,
  ): Promise<ReconciliationResult> {
    const worker = await this.reconcileWorker(state);
    if (worker) return worker;
    if (!this.deps.configuration || !this.deps.jevDecisionClient)
      return this.block(
        state,
        "operator-attention-required",
        undefined,
        "Product Runtime configuration is unavailable",
      );
    try {
      const result = await new CodingOrchestrator(
        this.codingDependencies(),
      ).execute({
        state,
        cwd: this.deps.cwd ?? this.deps.repositoryCwd,
        ...(this.deps.changeScope
          ? { changeScope: this.deps.changeScope }
          : {}),
        reconcileStaleRouting: true,
      });
      return {
        status: "advanced",
        state: result.state,
        phase: result.state.phase,
      };
    } catch (error) {
      const current = await this.loadCurrentState(state);
      if (current.phase === "blocked")
        return { status: "blocked", state: current, phase: current.phase };
      throw error;
    }
  }

  private async loadCurrentState(
    fallback: WorkflowState,
  ): Promise<WorkflowState> {
    return this.deps.loadState ? this.deps.loadState() : fallback;
  }

  private async readAttempt(
    state: WorkflowState,
  ): Promise<
    | { ref: ArtifactRef<"implementation">; attempt: WorkerAttemptEvidence }
    | undefined
  > {
    const ref = state.coding.workerAttemptRef;
    if (!ref) return undefined;
    const attempt = await readJson(
      this.deps.artifactStore,
      ref,
      parseWorkerAttempt,
      "Worker attempt",
    );
    return { ref, attempt };
  }

  private validateAttemptBinding(
    state: WorkflowState,
    ref: ArtifactRef<"implementation">,
    attempt: WorkerAttemptEvidence,
  ): void {
    if (
      attempt.launchStatus === "not-started" &&
      attempt.implementationRef !== undefined
    ) {
      throw new ReconciliationError(
        "A not-started Worker attempt cannot contain an implementation result",
      );
    }
    const inputImplementationMatches =
      (attempt.inputImplementationRef === undefined) ===
        (state.coding.implementationRef === undefined) &&
      (attempt.inputImplementationRef === undefined ||
        sameArtifactRef(
          attempt.inputImplementationRef,
          state.coding.implementationRef,
        ));
    if (!state.planning.approvedPlanRef)
      throw new ReconciliationError(
        "Worker attempt is missing the approved Plan",
      );
    const requiredInputs: ArtifactRef[] = [
      state.taskRef,
      state.planning.approvedPlanRef,
    ];
    for (const candidate of [
      state.planning.context.scoutRef,
      state.planning.context.researchRef,
      state.planning.context.clarificationRef,
      state.coding.acceptedFindingsRef,
      state.coding.latestCodeReviewRef,
    ]) {
      if (candidate) requiredInputs.push(candidate);
    }
    const includesInput = (required: ArtifactRef) =>
      attempt.inputRefs.some((candidate) =>
        sameArtifactRef(candidate, required),
      );
    if (
      attempt.workflowId !== state.workflowId ||
      attempt.dispatch.ownerRunId !== state.workflowId ||
      !inputImplementationMatches ||
      !state.planning.approvedPlanRef ||
      !sameArtifactRef(
        attempt.approvedPlanRef,
        state.planning.approvedPlanRef,
      ) ||
      attempt.planVersion !== state.planning.approvedPlanVersion ||
      attempt.inputRevision !== state.coding.implementationRevision ||
      attempt.targetRevision !== state.coding.implementationRevision + 1 ||
      !state.coding.executionRoutingRef ||
      !sameArtifactRef(
        attempt.executionRoutingRef,
        state.coding.executionRoutingRef,
      ) ||
      requiredInputs.some((required) => !includesInput(required)) ||
      (attempt.previousRef &&
        !sameArtifactRef(attempt.previousRef, ref) &&
        attempt.previousRef.path === ref.path)
    ) {
      throw new ReconciliationError(
        "Worker attempt evidence is not bound to the current coding authority",
      );
    }
  }

  private async reconcileWorker(
    state: WorkflowState,
  ): Promise<ReconciliationResult | undefined> {
    let current: Awaited<ReturnType<WorkflowReconciler["readAttempt"]>>;
    try {
      current = await this.readAttempt(state);
    } catch {
      return this.fail(
        state,
        "authoritative-artifact-corrupt",
        state.coding.workerAttemptRef,
      );
    }
    if (!current) return undefined;
    const { ref, attempt } = current;
    try {
      if (
        await validateCompletedWorkerAttempt(
          this.deps.artifactStore,
          state,
          ref,
          attempt,
        )
      )
        return undefined;
    } catch (error) {
      if (!(error instanceof WorkerAttemptAuthorityError)) throw error;
      return this.fail(state, error.reason, error.evidenceRef);
    }
    try {
      this.validateAttemptBinding(state, current.ref, current.attempt);
    } catch {
      return this.fail(state, "authority-inconsistent", current.ref);
    }
    if (attempt.launchStatus === "not-started") {
      const reconciliationRef = await this.record(
        state,
        "advanced",
        [ref],
        "Adapter proved that the Worker request was not emitted",
      );
      const nextState = { ...state, coding: { ...state.coding } };
      delete nextState.coding.workerAttemptRef;
      const next = await this.deps.stateStore.saveState(
        nextState,
        state.stateRevision,
      );
      return {
        status: "advanced",
        state: next,
        phase: next.phase,
        reconciliationRef,
      };
    }
    if (!attempt.runId) {
      return this.block(
        state,
        "agent-execution-ambiguous",
        ref,
        "Worker dispatch identity is unresolved; redispatch is forbidden",
      );
    }
    let status: AgentRunStatus;
    try {
      status = await this.deps.subagentExecutor.status(attempt.runId);
    } catch (error) {
      return this.block(
        state,
        "agent-execution-ambiguous",
        ref,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (status.runId !== attempt.runId) {
      return this.block(
        state,
        "agent-execution-ambiguous",
        ref,
        "Worker status returned a different run identity",
      );
    }
    if (
      status.status === "queued" ||
      status.status === "running" ||
      status.status === "unknown" ||
      status.status === "ambiguous"
    ) {
      return this.block(
        state,
        "agent-execution-ambiguous",
        ref,
        "Worker execution remains unresolved; no duplicate dispatch is allowed",
      );
    }
    if (status.status === "failed") {
      if (status.result?.status === "failed" && status.result.notDispatched) {
        return this.fail(state, "authority-inconsistent", ref);
      }
      return this.block(
        state,
        "agent-execution-ambiguous",
        ref,
        "Worker failed after dispatch; repository mutation cannot be inferred away",
      );
    }
    if (
      status.status === "succeeded" &&
      attempt.status === "succeeded" &&
      attempt.implementationRef
    ) {
      if (
        status.result &&
        (status.result.status !== "succeeded" ||
          status.result.runId !== attempt.runId ||
          (status.result.dispatch &&
            !sameDispatch(status.result.dispatch, attempt.dispatch)))
      ) {
        return this.block(
          state,
          "agent-execution-ambiguous",
          ref,
          "Worker terminal result does not match durable run identity",
        );
      }
      return this.finishKnownWorker(
        state,
        ref,
        attempt,
        attempt.implementationRef,
        attempt.runId,
      );
    }
    const result = status.result;
    if (
      !result ||
      result.status !== "succeeded" ||
      result.runId !== attempt.runId
    ) {
      return this.block(
        state,
        "agent-execution-ambiguous",
        ref,
        "Worker success lacks an exact public result identity",
      );
    }
    if (result.dispatch && !sameDispatch(result.dispatch, attempt.dispatch)) {
      return this.block(
        state,
        "agent-execution-ambiguous",
        ref,
        "Worker result dispatch identity does not match durable intent",
      );
    }
    return this.finishWorkerFromResult(state, ref, attempt, result);
  }

  private async finishKnownWorker(
    state: WorkflowState,
    attemptRef: ArtifactRef<"implementation">,
    attempt: WorkerAttemptEvidence,
    implementationRef: ArtifactRef<"implementation">,
    runId: SubagentRunId,
  ): Promise<ReconciliationResult> {
    if (attempt.after?.status !== "observed") {
      return this.block(
        state,
        "agent-execution-ambiguous",
        attemptRef,
        "Successful Worker evidence lacks a post-run repository observation",
      );
    }
    try {
      const implementation = await readJson(
        this.deps.artifactStore,
        implementationRef,
        parseImplementationArtifact,
        "implementation",
      );
      if (
        implementation.implementationRevision !== attempt.targetRevision ||
        implementation.runId !== runId ||
        !sameArtifactRef(
          implementation.approvedPlanRef,
          state.planning.approvedPlanRef,
        ) ||
        !sameArtifactRef(
          implementation.executionRoutingRef,
          state.coding.executionRoutingRef,
        ) ||
        (implementation.workerAttemptRef &&
          !sameArtifactRef(implementation.workerAttemptRef, attemptRef) &&
          (!attempt.previousRef ||
            !sameArtifactRef(
              implementation.workerAttemptRef,
              attempt.previousRef,
            ))) ||
        calculateSha256(implementation.output) !==
          implementation.repository.outputSha256 ||
        (implementation.acceptedFindingsRef
          ? !sameArtifactRef(
              implementation.acceptedFindingsRef,
              state.coding.acceptedFindingsRef,
            )
          : state.coding.acceptedFindingsRef !== undefined)
      )
        throw new Error("implementation binding mismatch");
    } catch {
      return this.fail(
        state,
        "authoritative-artifact-corrupt",
        implementationRef,
      );
    }
    return this.transition(
      state,
      {
        type: "IMPLEMENTATION_COMPLETE",
        resultRef: implementationRef,
        runId,
      },
      [attemptRef, implementationRef],
    );
  }

  private async finishWorkerFromResult(
    state: WorkflowState,
    attemptRef: ArtifactRef<"implementation">,
    attempt: WorkerAttemptEvidence,
    result: Extract<AgentRunResult, { status: "succeeded" }>,
  ): Promise<ReconciliationResult> {
    if (!result.output.trim())
      return this.block(
        state,
        "agent-execution-ambiguous",
        attemptRef,
        "Worker returned no usable output",
      );
    let after: RepositorySnapshot;
    try {
      after = await captureRepository(
        this.deps.cwd ??
          this.deps.repositoryCwd ??
          state.projectRoot ??
          process.cwd(),
        this.deps.artifactStore.rootDirectory,
      );
      if (after.root !== attempt.before.root)
        throw Error("repository identity changed");
    } catch (error) {
      return this.block(
        state,
        "agent-execution-ambiguous",
        attemptRef,
        error instanceof Error ? error.message : String(error),
      );
    }
    const resultDigest = calculateSha256(JSON.stringify(result));
    const receivedCandidate: WorkerAttemptEvidence = {
      ...attempt,
      previousRef:
        attempt.status === "ambiguous" && attempt.previousRef
          ? attempt.previousRef
          : attemptRef,
      status: "ambiguous",
      runId: result.runId,
      launchStatus: "observed",
      observedAt: this.now(),
      after: { status: "pending" },
      resultDigest,
    };
    let received = receivedCandidate;
    let receivedRef: ArtifactRef<"implementation">;
    if (
      attempt.status === "ambiguous" &&
      attempt.runId === result.runId &&
      attempt.resultDigest === resultDigest &&
      attempt.after?.status === "pending"
    ) {
      receivedRef = attemptRef;
      received = attempt;
    } else {
      try {
        receivedRef = await persistWorkerRecord(
          this.deps.artifactStore,
          `attempt-${attempt.attemptId}-resume-received.json`,
          receivedCandidate,
        );
        received = await readJson(
          this.deps.artifactStore,
          receivedRef,
          parseWorkerAttempt,
          "Worker attempt",
        );
      } catch (error) {
        return this.block(
          state,
          "agent-execution-ambiguous",
          attemptRef,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    let current = state;
    if (!sameArtifactRef(current.coding.workerAttemptRef, receivedRef)) {
      current = await this.deps.stateStore.saveState(
        {
          ...current,
          coding: { ...current.coding, workerAttemptRef: receivedRef },
        },
        current.stateRevision,
      );
    }
    const observedCandidate: WorkerAttemptEvidence = {
      ...received,
      previousRef: receivedRef,
      status: "ambiguous",
      after: { status: "observed", snapshot: after },
      observedAt: this.now(),
    };
    let observed = observedCandidate;
    let observedRef: ArtifactRef<"implementation">;
    if (
      received.after?.status === "observed" &&
      received.runId === result.runId &&
      received.resultDigest === resultDigest
    ) {
      observedRef = receivedRef;
      observed = received;
    } else {
      observedRef = await persistWorkerRecord(
        this.deps.artifactStore,
        `attempt-${attempt.attemptId}-resume-observed.json`,
        observedCandidate,
      );
      observed = await readJson(
        this.deps.artifactStore,
        observedRef,
        parseWorkerAttempt,
        "Worker attempt",
      );
    }
    if (!sameArtifactRef(current.coding.workerAttemptRef, observedRef)) {
      current = await this.deps.stateStore.saveState(
        {
          ...current,
          coding: { ...current.coding, workerAttemptRef: observedRef },
        },
        current.stateRevision,
      );
    }
    const implementation: ImplementationArtifact = {
      schemaVersion: 1,
      workerAttemptRef: observedRef,
      implementationRevision: attempt.targetRevision,
      approvedPlanRef: attempt.approvedPlanRef,
      executionRoutingRef: attempt.executionRoutingRef,
      ...(state.coding.acceptedFindingsRef
        ? { acceptedFindingsRef: state.coding.acceptedFindingsRef }
        : {}),
      executionProfile: attempt.executionProfile,
      repository: {
        cwd: after.cwd,
        outputSha256: calculateSha256(result.output),
      },
      runId: result.runId,
      output: result.output,
    };
    const implementationRef = await persistImplementationRecord(
      this.deps.artifactStore,
      `implementation-${attempt.targetRevision}.json`,
      implementation,
    );
    const completedObservation: WorkerAttemptEvidence = {
      ...observed,
      previousRef: observedRef,
      status: "succeeded",
      implementationRef,
      observedAt: this.now(),
    };
    const completedRef = await persistWorkerRecord(
      this.deps.artifactStore,
      `attempt-${attempt.attemptId}-resume-complete.json`,
      completedObservation,
    );
    if (!sameArtifactRef(current.coding.workerAttemptRef, completedRef)) {
      current = await this.deps.stateStore.saveState(
        {
          ...current,
          coding: { ...current.coding, workerAttemptRef: completedRef },
        },
        current.stateRevision,
      );
    }
    return this.transition(
      current,
      {
        type: "IMPLEMENTATION_COMPLETE",
        resultRef: implementationRef,
        runId: result.runId,
      },
      [completedRef, implementationRef],
    );
  }

  private validationDependencies(): ValidationRunnerDependencies {
    if (!this.deps.validationExecutor)
      throw new ReconciliationError(
        "Validation resume requires ValidationExecutor",
      );
    return {
      artifactStore: this.deps.artifactStore,
      stateStore: this.deps.stateStore,
      validationExecutor: this.deps.validationExecutor,
      configuration: this.deps.configuration,
    };
  }

  private async validationFromState(
    state: WorkflowState,
  ): Promise<
    { ref: ArtifactRef<"validation">; value: ValidationResult } | undefined
  > {
    let ref = state.coding.validationRef;
    if (!ref)
      ref = await discoverArtifact(
        this.deps.artifactStore,
        "validation",
        validationFileName(state.coding.implementationRevision),
      );
    if (!ref) return undefined;
    try {
      const value = await readJson(
        this.deps.artifactStore,
        ref,
        parseValidationResult,
        "validation",
      );
      if (
        !state.planning.approvedPlanRef ||
        !sameArtifactRef(
          value.approvedPlanRef,
          state.planning.approvedPlanRef,
        ) ||
        value.planVersion !== state.planning.approvedPlanVersion ||
        !sameArtifactRef(
          value.implementationRef,
          state.coding.implementationRef,
        ) ||
        value.implementationRevision !== state.coding.implementationRevision
      )
        throw Error("stale validation");
      await assertValidationAuthority(this.deps.artifactStore, state, value);
      return { ref, value };
    } catch {
      return undefined;
    }
  }

  private async reconcileValidation(
    state: WorkflowState,
  ): Promise<ReconciliationResult> {
    const current = await this.validationFromState(state);
    if (current) {
      if (
        current.value.status === "infrastructure-error" &&
        (this.deps.configuration?.validation.stopOnInfrastructureFailure ??
          true)
      ) {
        return this.block(
          state,
          "validation-infrastructure-error",
          current.ref,
          "Validation infrastructure evidence remains unresolved",
        );
      }
      if (current.value.status !== "passed") {
        // Failed validation is not a State transition until Round Decision routes it.
        const withEvidence = state.coding.validationRef
          ? state
          : await this.deps.stateStore.saveState(
              {
                ...state,
                coding: { ...state.coding, validationRef: current.ref },
              },
              state.stateRevision,
            );
        return this.reconcileRound(withEvidence, current.value, current.ref);
      }
      return this.transition(
        state,
        { type: "VALIDATION_PASSED", resultRef: current.ref },
        [current.ref],
      );
    }
    if (state.coding.validationRef) {
      const clearedState = { ...state, coding: { ...state.coding } };
      delete clearedState.coding.validationRef;
      const cleared = await this.deps.stateStore.saveState(
        clearedState,
        state.stateRevision,
      );
      return this.runValidation(cleared);
    }
    return this.runValidation(state);
  }

  private async runValidation(
    state: WorkflowState,
  ): Promise<ReconciliationResult> {
    try {
      const result = await new ValidationRunner(
        this.validationDependencies(),
      ).execute({ state });
      return {
        status: result.state.phase === "blocked" ? "blocked" : "advanced",
        state: result.state,
        phase: result.state.phase,
      };
    } catch (error) {
      const current = await this.loadCurrentState(state);
      if (current.phase === "blocked" || current.phase === "failed")
        return {
          status: current.phase === "blocked" ? "blocked" : "failed",
          state: current,
          phase: current.phase,
        };
      throw error;
    }
  }

  private async reviewRefsFromState(
    state: WorkflowState,
  ): Promise<WorkflowState> {
    let current = state;
    let correctness = current.coding.correctnessReviewRef;
    let ponytail = current.coding.ponytailReviewRef;
    if (!correctness)
      correctness = await discoverArtifact(
        this.deps.artifactStore,
        "correctness-review",
        reviewFileName("correctness-review", current.coding.reviewRound),
      );
    if (!ponytail)
      ponytail = await discoverArtifact(
        this.deps.artifactStore,
        "ponytail-review",
        reviewFileName("ponytail-review", current.coding.reviewRound),
      );
    if (!correctness && !ponytail) return current;
    if (!correctness || !ponytail)
      throw new IncompleteReviewArtifactsError(
        "Automated review round is incomplete; clean completion cannot be inferred",
        correctness ?? ponytail,
      );
    for (const [ref, source] of [
      [correctness, "correctness"],
      [ponytail, "ponytail"],
    ] as const) {
      // Validate each persisted review in fixed reviewer order before advancing.
      // oxlint-disable-next-line eslint/no-await-in-loop
      const review = await readJson(
        this.deps.artifactStore,
        ref,
        parseReviewArtifact,
        "review",
      );
      if (
        review.round !== current.coding.reviewRound ||
        review.source !== source
      )
        throw new ReconciliationError("Automated review artifact is stale");
      assertCodingAuthority(current, review.authority);
    }
    if (
      !current.coding.correctnessReviewRef ||
      !current.coding.ponytailReviewRef
    ) {
      current = await advanceWorkflow(
        current,
        {
          type: "REVIEW_ARTIFACTS_PERSISTED",
          correctnessReviewRef: correctness,
          ponytailReviewRef: ponytail,
        },
        this.deps.stateStore,
      );
    }
    return current;
  }

  private async reconcileReview(
    state: WorkflowState,
  ): Promise<ReconciliationResult> {
    let current: WorkflowState;
    try {
      current = await this.reviewRefsFromState(state);
    } catch (error) {
      if (error instanceof IncompleteReviewArtifactsError)
        return this.fail(
          state,
          "authoritative-artifact-corrupt",
          error.evidenceRef,
        );
      if (
        error instanceof ReconciliationError &&
        !state.coding.correctnessReviewRef &&
        !state.coding.ponytailReviewRef
      ) {
        return this.block(
          state,
          "agent-execution-ambiguous",
          undefined,
          error.message,
        );
      }
      if (
        error instanceof ReconciliationError &&
        (!state.coding.correctnessReviewRef || !state.coding.ponytailReviewRef)
      ) {
        return this.block(
          state,
          "agent-execution-ambiguous",
          state.coding.correctnessReviewRef ?? state.coding.ponytailReviewRef,
          error.message,
        );
      }
      return this.fail(
        state,
        "authoritative-artifact-corrupt",
        state.coding.correctnessReviewRef ?? state.coding.ponytailReviewRef,
      );
    }
    try {
      await this.readCurrentValidation(current);
    } catch {
      return this.fail(
        current,
        "authoritative-artifact-corrupt",
        current.coding.validationRef,
      );
    }
    if (
      !current.coding.correctnessReviewRef ||
      !current.coding.ponytailReviewRef
    ) {
      try {
        const result = await new ReviewRunner({
          artifactStore: this.deps.artifactStore,
          stateStore: this.deps.stateStore,
          subagentExecutor: this.deps.subagentExecutor,
        }).execute({
          state: current,
          cwd: this.deps.cwd ?? this.deps.repositoryCwd,
        });
        return {
          status: result.state.phase === "blocked" ? "blocked" : "advanced",
          state: result.state,
          phase: result.state.phase,
        };
      } catch (error) {
        const persisted = await this.loadCurrentState(current);
        if (persisted.phase === "blocked" || persisted.phase === "failed")
          return {
            status: persisted.phase === "blocked" ? "blocked" : "failed",
            state: persisted,
            phase: persisted.phase,
          };
        throw error;
      }
    }
    if (!this.deps.configuration || !this.deps.jevDecisionClient)
      return this.block(
        current,
        "operator-attention-required",
        undefined,
        "Product Runtime configuration is unavailable",
      );
    const evaluation = await this.evaluationFromState(current);
    if (evaluation === "incomplete")
      return this.block(
        current,
        "agent-execution-ambiguous",
        undefined,
        "Finding evaluation artifacts are incomplete",
      );
    if (evaluation === "stale") {
      const clearedState = { ...current, coding: { ...current.coding } };
      delete clearedState.coding.findingEvaluationRef;
      delete clearedState.coding.acceptedFindingsRef;
      current = await this.deps.stateStore.saveState(
        clearedState,
        current.stateRevision,
      );
    } else if (evaluation) {
      return this.reconcileRound(
        evaluation,
        await this.readCurrentValidation(evaluation),
        evaluation.coding.validationRef!,
      );
    }
    try {
      const result = await new FindingEvaluationRunner(
        this.findingDependencies(),
      ).execute({ state: current });
      return {
        status: result.state.phase === "blocked" ? "blocked" : "advanced",
        state: result.state,
        phase: result.state.phase,
      };
    } catch (error) {
      const persisted = await this.loadCurrentState(current);
      if (persisted.phase === "blocked" || persisted.phase === "failed")
        return {
          status: persisted.phase === "blocked" ? "blocked" : "failed",
          state: persisted,
          phase: persisted.phase,
        };
      throw error;
    }
  }

  private findingDependencies(): FindingEvaluationRunnerDependencies {
    if (!this.deps.configuration || !this.deps.jevDecisionClient)
      throw new ReconciliationError(
        "Finding evaluation resume requires configuration and JevDecisionClient",
      );
    return {
      artifactStore: this.deps.artifactStore,
      stateStore: this.deps.stateStore,
      jevDecisionClient: this.deps.jevDecisionClient,
      configuration: this.deps.configuration,
    };
  }

  private async evaluationFromState(
    state: WorkflowState,
  ): Promise<"incomplete" | "stale" | WorkflowState | undefined> {
    let evaluationRef = state.coding.findingEvaluationRef;
    let acceptedRef = state.coding.acceptedFindingsRef;
    if (!evaluationRef)
      evaluationRef = await discoverArtifact(
        this.deps.artifactStore,
        "finding-evaluation",
        findingEvaluationFileName(state.coding.reviewRound),
      );
    if (!acceptedRef)
      acceptedRef = await discoverArtifact(
        this.deps.artifactStore,
        "accepted-findings",
        acceptedFindingsFileName(state.coding.reviewRound),
      );
    if (!evaluationRef && !acceptedRef) return undefined;
    if (!evaluationRef || !acceptedRef) return "incomplete";
    try {
      const evaluation = await readJson(
        this.deps.artifactStore,
        evaluationRef,
        parseFindingEvaluationArtifact,
        "finding evaluation",
      );
      const accepted = await readJson(
        this.deps.artifactStore,
        acceptedRef,
        parseAcceptedFindingsArtifact,
        "accepted findings",
      );
      if (
        !state.planning.approvedPlanRef ||
        !sameArtifactRef(
          evaluation.approvedPlanRef,
          state.planning.approvedPlanRef,
        ) ||
        !sameArtifactRef(
          accepted.approvedPlanRef,
          state.planning.approvedPlanRef,
        ) ||
        evaluation.round !== state.coding.reviewRound ||
        accepted.round !== state.coding.reviewRound ||
        evaluation.implementationRevision !==
          state.coding.implementationRevision ||
        accepted.implementationRevision !==
          state.coding.implementationRevision ||
        evaluation.planVersion !== state.planning.approvedPlanVersion ||
        accepted.planVersion !== state.planning.approvedPlanVersion
      )
        return "stale";
      assertCodingAuthority(state, evaluation.authority);
      assertCodingAuthority(state, accepted.authority);
      const raw = await persistedFindings(
        asReadable(this.deps.artifactStore),
        state,
      );
      const evidence = await assembleCodingEvidence(
        this.deps.artifactStore,
        state,
      );
      const reviewRefs = reviewEvidenceRefs(state);
      const request = {
        approvedPlanRef: state.planning.approvedPlanRef,
        implementationRevision: state.coding.implementationRevision,
        findings: raw,
        evidence,
        reviewRefs,
      };
      const refs: ArtifactRef[] = [
        request.approvedPlanRef,
        state.coding.implementationRef!,
        reviewRefs.correctness,
        reviewRefs.ponytail,
        ...(evidence.previousDecision ? [evidence.previousDecision.ref] : []),
      ];
      if (
        !evaluation.freshness ||
        !this.deps.configuration ||
        !isDecisionFresh(
          evaluation.freshness,
          decisionFreshness(
            state,
            request,
            refs,
            this.deps.configuration.decision,
          ),
        )
      )
        return "stale";
      const evaluatedIds = evaluation.findings.map((item) => item.findingId);
      if (
        raw.length !== evaluation.findings.length ||
        raw.some(
          (finding, index) =>
            finding.id !== evaluation.findings[index]?.findingId ||
            finding.blocking !== evaluation.findings[index]?.blocking,
        )
      )
        return "stale";
      const acceptedIds = evaluation.findings
        .filter((item) => item.decision === "ACCEPT")
        .map((item) => item.findingId);
      const expectedAccepted = raw.filter((finding) =>
        acceptedIds.includes(finding.id),
      );
      if (
        JSON.stringify(accepted.accepted.map((item) => item.id)) !==
          JSON.stringify(acceptedIds) ||
        JSON.stringify(accepted.accepted) !==
          JSON.stringify(expectedAccepted) ||
        new Set(evaluatedIds).size !== evaluatedIds.length
      )
        return "stale";
      let current = state;
      if (
        !current.coding.findingEvaluationRef ||
        !current.coding.acceptedFindingsRef
      ) {
        current = await advanceWorkflow(
          current,
          {
            type: "FINDING_EVALUATION_PERSISTED",
            findingEvaluationRef: evaluationRef,
            acceptedFindingsRef: acceptedRef,
          },
          this.deps.stateStore,
        );
      }
      return current;
    } catch {
      return "stale";
    }
  }

  private async readCurrentValidation(
    state: WorkflowState,
  ): Promise<ValidationResult> {
    if (!state.coding.validationRef)
      throw new ReconciliationError(
        "Round Decision requires validation authority",
      );
    const validation = await readJson(
      this.deps.artifactStore,
      state.coding.validationRef,
      parseValidationResult,
      "validation",
    );
    await assertValidationAuthority(this.deps.artifactStore, state, validation);
    return validation;
  }

  private async reconcileRound(
    state: WorkflowState,
    validation: ValidationResult,
    validationRef: ArtifactRef<"validation">,
  ): Promise<ReconciliationResult> {
    if (!this.deps.configuration || !this.deps.jevDecisionClient)
      throw new ReconciliationError(
        "Round Decision resume requires configuration and JevDecisionClient",
      );
    const persisted = await this.roundFromState(
      state,
      validation,
      validationRef,
    );
    if (persisted) return this.applyRound(state, persisted, validationRef);
    try {
      const result = await new RoundDecisionRunner(
        this.roundDependencies(),
      ).execute({ state, validation, validationRef });
      return {
        status: result.state.phase === "blocked" ? "blocked" : "advanced",
        state: result.state,
        phase: result.state.phase,
      };
    } catch (error) {
      const current = await this.loadCurrentState(state);
      if (current.phase === "blocked" || current.phase === "failed")
        return {
          status: current.phase === "blocked" ? "blocked" : "failed",
          state: current,
          phase: current.phase,
        };
      throw error;
    }
  }

  private roundDependencies(): RoundDecisionRunnerDependencies {
    if (!this.deps.configuration || !this.deps.jevDecisionClient)
      throw new ReconciliationError(
        "Round Decision resume requires configuration and JevDecisionClient",
      );
    return {
      artifactStore: this.deps.artifactStore,
      stateStore: this.deps.stateStore,
      jevDecisionClient: this.deps.jevDecisionClient,
      configuration: this.deps.configuration,
    };
  }

  private async roundFromState(
    state: WorkflowState,
    validation: ValidationResult,
    validationRef: ArtifactRef<"validation">,
  ): Promise<RoundDecisionArtifact | undefined> {
    let ref = state.coding.roundDecisionRef;
    if (!ref)
      ref = await discoverArtifact(
        this.deps.artifactStore,
        "round-decision",
        roundDecisionFileName(state.coding.implementationRevision),
      );
    if (!ref) return undefined;
    try {
      const artifact = await readJson(
        this.deps.artifactStore,
        ref,
        parseRoundDecisionArtifact,
        "round decision",
      );
      if (
        !state.planning.approvedPlanRef ||
        !sameArtifactRef(
          artifact.approvedPlanRef,
          state.planning.approvedPlanRef,
        ) ||
        artifact.planVersion !== state.planning.approvedPlanVersion ||
        artifact.implementationRevision !==
          state.coding.implementationRevision ||
        artifact.round !== Math.max(1, state.coding.reviewRound)
      )
        return undefined;
      const routingRef = state.coding.executionRoutingRef;
      if (!routingRef) return undefined;
      const routing = await readJson(
        this.deps.artifactStore,
        routingRef,
        parseExecutionRoutingArtifact,
        "execution routing",
      );
      const evidence = await assembleCodingEvidence(
        this.deps.artifactStore,
        state,
      );
      let findings: FindingEvaluationArtifact["findings"] = [];
      let findingSummaries: ReturnType<typeof sourcedFindings> = [];
      if (state.phase === "reviewing") {
        if (!state.coding.findingEvaluationRef) return undefined;
        const evaluation = await readJson(
          this.deps.artifactStore,
          state.coding.findingEvaluationRef,
          parseFindingEvaluationArtifact,
          "finding evaluation",
        );
        findings = evaluation.findings;
        findingSummaries = sourcedFindings(
          await persistedFindings(asReadable(this.deps.artifactStore), state),
          reviewEvidenceRefs(state),
        );
      }
      const inputRefs: ArtifactRef[] = [
        validationRef,
        ...(state.coding.correctnessReviewRef
          ? [state.coding.correctnessReviewRef]
          : []),
        ...(state.coding.ponytailReviewRef
          ? [state.coding.ponytailReviewRef]
          : []),
        ...(state.coding.findingEvaluationRef
          ? [state.coding.findingEvaluationRef]
          : []),
        ...(state.coding.acceptedFindingsRef
          ? [state.coding.acceptedFindingsRef]
          : []),
      ];
      const request = {
        evidence,
        findingSummaries,
        branch:
          state.phase === "reviewing"
            ? ("review-passed" as const)
            : validation.status === "infrastructure-error"
              ? ("infrastructure-attention" as const)
              : ("validation-failed" as const),
        retryLimits: this.deps.configuration!.retries,
        currentProfile: {
          modelTier: routing.modelTier.value,
          reasoningTier: routing.reasoningTier.value,
        },
        inputRefs,
        approvedPlanRef: state.planning.approvedPlanRef,
        implementationRevision: state.coding.implementationRevision,
        validation,
        findings,
      };
      const refs: ArtifactRef[] = [
        request.approvedPlanRef,
        state.coding.implementationRef!,
        ...inputRefs,
        ...(evidence.previousDecision ? [evidence.previousDecision.ref] : []),
      ];
      return artifact.freshness &&
        isDecisionFresh(
          artifact.freshness,
          decisionFreshness(state, request, refs, this.deps.configuration!),
        )
        ? artifact
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async applyRound(
    state: WorkflowState,
    artifact: RoundDecisionArtifact,
    validationRef: ArtifactRef<"validation">,
  ): Promise<ReconciliationResult> {
    const routingRef = state.coding.executionRoutingRef;
    if (!routingRef)
      return this.block(
        state,
        "operator-attention-required",
        state.coding.roundDecisionRef,
        "Round Decision cannot be rebound without current routing authority",
      );
    const routing = await readJson(
      this.deps.artifactStore,
      routingRef,
      parseExecutionRoutingArtifact,
      "execution routing",
    );
    const currentProfile = {
      modelTier: routing.modelTier.value,
      reasoningTier: routing.reasoningTier.value,
    };
    if (state.phase !== "validating" && state.phase !== "reviewing") {
      throw new ReconciliationError(
        "Round Decision can only be applied while validating or reviewing",
      );
    }
    const event = routeRoundDecision({
      phase: state.phase,
      counters: state.counters,
      retries: this.deps.configuration!.retries,
      decision: artifact,
      decisionRef:
        state.coding.roundDecisionRef ??
        createArtifactRef(
          "round-decision",
          artifactRelativePath(
            "round-decision",
            roundDecisionFileName(state.coding.implementationRevision),
          ),
          JSON.stringify(artifact),
        ),
      validationRef,
      ...(state.coding.acceptedFindingsRef
        ? { findingsRef: state.coding.acceptedFindingsRef }
        : {}),
      currentProfile,
    });
    if (event.type === "STRONGER_RETRY_REQUIRED") {
      return this.block(
        state,
        "operator-attention-required",
        state.coding.roundDecisionRef,
        "Persisted stronger retry requires its exact routing artifact before resume",
      );
    }
    return this.transition(
      state,
      event,
      state.coding.roundDecisionRef ? [state.coding.roundDecisionRef] : [],
    );
  }

  private async reconcileCodeGate(
    state: WorkflowState,
  ): Promise<ReconciliationResult> {
    const gate = this.deps.plannotatorGate;
    if (!gate)
      return this.block(
        state,
        "human-gate-unavailable",
        undefined,
        "Code Gate integration is unavailable",
      );
    const current = state.coding.codeReview;
    const identity =
      state.external[
        `plannotator.code-review.r${state.coding.implementationRevision}`
      ];
    if (!current && identity)
      return this.block(
        state,
        "operator-attention-required",
        undefined,
        "Code review identity exists without its exact implementation binding",
      );
    try {
      const orchestrator = new CodingOrchestrator(this.codingDependencies());
      if (!current) {
        const opened = await orchestrator.openCodeReview({ state });
        if (opened.status === "opened")
          return {
            status: "pending",
            state: opened.state,
            phase: opened.state.phase,
          };
        if (opened.status === "blocked")
          return {
            status: "blocked",
            state: opened.state,
            phase: opened.state.phase,
          };
        if (
          opened.outcome.status === "approved" ||
          opened.outcome.status === "feedback"
        )
          return {
            status: "advanced",
            state: opened.state,
            phase: opened.state.phase,
          };
        return {
          status: opened.outcome.status === "blocked" ? "blocked" : "pending",
          state: opened.state,
          phase: opened.state.phase,
          reason:
            opened.outcome.status === "unknown"
              ? opened.outcome.reason
              : undefined,
        };
      }
      const outcome = await orchestrator.reconcileCodeReview({
        state,
        reviewId: current.reviewId,
      });
      if (outcome.status === "approved" || outcome.status === "feedback")
        return {
          status: "advanced",
          state: outcome.state,
          phase: outcome.state.phase,
        };
      if (outcome.status === "blocked")
        return {
          status: "blocked",
          state: outcome.state,
          phase: outcome.state.phase,
        };
      return {
        status: "pending",
        state: outcome.state,
        phase: outcome.state.phase,
        reason: outcome.status === "unknown" ? outcome.reason : undefined,
      };
    } catch (error) {
      if (error instanceof CodeReviewOpenAttemptError)
        return this.block(
          state,
          "operator-attention-required",
          undefined,
          "A Code Review open attempt exists without a durable binding",
        );
      if (error instanceof CodeReviewAuthorityError)
        return this.fail(
          state,
          "authoritative-artifact-corrupt",
          current?.implementationRef ?? state.coding.implementationRef,
        );
      if (error instanceof StaleCodeReviewError)
        return this.fail(
          state,
          "authority-inconsistent",
          current?.implementationRef ?? state.coding.implementationRef,
        );
      return this.block(
        state,
        "operator-attention-required",
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async reconcileBlocked(
    state: WorkflowState,
  ): Promise<ReconciliationResult> {
    const blockedFrom = state.block?.blockedFrom;
    if (
      !blockedFrom ||
      blockedFrom === "blocked" ||
      blockedFrom === "completed" ||
      blockedFrom === "failed"
    )
      return {
        status: "failed",
        state,
        phase: state.phase,
        reason: "authority-inconsistent",
      };
    if (blockedFrom === "gathering-context" || blockedFrom === "planning") {
      const stage =
        blockedFrom === "planning"
          ? `plan-v${state.planning.currentPlanVersion + 1}`
          : state.planning.context.scoutRef
            ? "research"
            : "scout";
      const attempt = state.planning.agentAttempts?.[stage];
      if (
        !state.planning.agentAttempts ||
        (attempt && !attempt.notDispatched && !attempt.receipt)
      ) {
        return {
          status: "blocked",
          state,
          phase: state.phase,
          reason: "No recoverable planning launch identity; do not redispatch",
        };
      }
      if (attempt?.receipt) {
        try {
          const status = await this.deps.subagentExecutor.status(
            subagentRunId(attempt.receipt.runId),
            attempt.receipt,
          );
          if (
            status.runId !== attempt.receipt.runId ||
            !["succeeded", "running", "queued"].includes(status.status)
          ) {
            return {
              status: "blocked",
              state,
              phase: state.phase,
              reason: status.reason ?? "Planning result is unknown",
            };
          }
          if (status.status !== "succeeded")
            return {
              status: "pending",
              state,
              phase: state.phase,
              reason: "Existing planning run is still active",
            };
        } catch {
          return {
            status: "blocked",
            state,
            phase: state.phase,
            reason: "Planning status unavailable",
          };
        }
      }
    }
    if (
      blockedFrom === "awaiting-code-review" &&
      state.block?.reason === "operator-attention-required"
    ) {
      return {
        status: "blocked",
        state,
        phase: state.phase,
        reason: state.block.reason,
      };
    }
    if (
      state.block?.reason === "agent-execution-ambiguous" &&
      (blockedFrom === "implementing" || blockedFrom === "fixing")
    ) {
      let attempt: Awaited<ReturnType<WorkflowReconciler["readAttempt"]>>;
      try {
        attempt = await this.readAttempt(state);
      } catch {
        return {
          status: "blocked",
          state,
          phase: state.phase,
          reason: "authority-inconsistent",
        };
      }
      if (!attempt?.attempt.runId) {
        return {
          status: "blocked",
          state,
          phase: state.phase,
          reason: "agent-execution-ambiguous",
        };
      }
      try {
        const status = await this.deps.subagentExecutor.status(
          attempt.attempt.runId,
        );
        if (
          status.runId !== attempt.attempt.runId ||
          ["queued", "running", "unknown", "ambiguous"].includes(status.status)
        ) {
          return {
            status: "blocked",
            state,
            phase: state.phase,
            reason: "agent-execution-ambiguous",
          };
        }
      } catch {
        return {
          status: "blocked",
          state,
          phase: state.phase,
          reason: "agent-execution-ambiguous",
        };
      }
    }
    const ref = await this.record(
      state,
      "advanced",
      state.block?.evidenceRef ? [state.block.evidenceRef] : [],
      "Blocked dependency reconciliation succeeded",
    );
    const resolved = await advanceWorkflow(
      state,
      { type: "BLOCK_RESOLVED", evidenceRef: ref },
      this.deps.stateStore,
    );
    return this.reconcile(resolved);
  }
}
