import {
  isSubagentRunId,
  isWorkflowId,
  type PlaybookKind,
  type PlannotatorReviewId,
  type SubagentRunId,
  type WorkflowId,
} from "../../types.ts";
import {
  conditionalStages,
  developmentIntents,
  type DevelopmentIntent,
  type ConditionalStage,
} from "../decisions/planning-routing.ts";
import type { ArtifactRef } from "../artifacts/references.ts";
import { isArtifactRef } from "../artifacts/references.ts";
import {
  isPlanningAgentAttempts,
  type PlanningAgentAttempt,
} from "../planning/agent-attempt.ts";
import {
  hasOnlyKeys,
  isNonEmptyString,
  isNonNegativeInteger,
  isOneOf,
  isRecord,
  isSchemaVersion,
  optional,
  parseSchema,
} from "../schema.ts";
import { isOracleState, type OracleState } from "../oracle.ts";
import type { WorkflowPhase } from "./phase.ts";
import { isWorkflowPhase } from "./phase.ts";

const playbookKinds = [
  "new-project",
  "feature",
  "bugfix",
  "hotfix",
  "chore",
] as const;

export type BlockedReason =
  | "integration-unavailable"
  | "agent-infrastructure-unavailable"
  | "agent-execution-ambiguous"
  | "human-gate-unavailable"
  | "validation-infrastructure-error"
  | "retry-budget-exhausted"
  | "stronger-profile-unavailable"
  | "operator-attention-required";

export const blockedReasons: readonly BlockedReason[] = [
  "integration-unavailable",
  "agent-infrastructure-unavailable",
  "agent-execution-ambiguous",
  "human-gate-unavailable",
  "validation-infrastructure-error",
  "retry-budget-exhausted",
  "stronger-profile-unavailable",
  "operator-attention-required",
];

export type FailureReason =
  | "state-corrupt"
  | "authoritative-artifact-missing"
  | "authoritative-artifact-corrupt"
  | "invalid-transition"
  | "authority-inconsistent"
  | "persistence-consistency-failure";

export const failureReasons: readonly FailureReason[] = [
  "state-corrupt",
  "authoritative-artifact-missing",
  "authoritative-artifact-corrupt",
  "invalid-transition",
  "authority-inconsistent",
  "persistence-consistency-failure",
];

export interface PlanReviewBinding {
  reviewId: PlannotatorReviewId;
  planRef: ArtifactRef<"plan">;
  planVersion: number;
}

export interface PlanningState {
  /** Captured Human intent; missing legacy intent is never inferred on resume. */
  developmentIntent?: DevelopmentIntent;
  developmentMethodRef?: ArtifactRef<"development-method">;
  clarificationRequestRef?: ArtifactRef<"clarification">;
  clarificationProgressRef?: ArtifactRef<"clarification">;
  domainDocumentWriteRef?: ArtifactRef<"domain-document-write">;
  /** Absence marks legacy state whose in-flight planning work cannot be inferred. */
  agentAttempts?: Record<string, PlanningAgentAttempt>;
  context: {
    scoutRef?: ArtifactRef<"scout">;
    diagnosisRef?: ArtifactRef<"diagnosis">;
    researchRef?: ArtifactRef<"research">;
    clarificationRef?: ArtifactRef<"clarification">;
  };
  /** Missing in legacy State; legacy flags cannot establish routing authority. */
  stageDecisionRefs?: Partial<
    Record<ConditionalStage, ArtifactRef<"conditional-stage">>
  >;
  clarificationModeRef?: ArtifactRef<"clarification-mode">;
  /** Derived projections for Plan parsing, never conditional decision authority. */
  researchRequired?: boolean;
  clarificationRequired?: boolean;
  architectureRequired?: boolean;
  planReview?: PlanReviewBinding;
  currentPlanRef?: ArtifactRef<"plan">;
  currentPlanVersion: number;
  approvedPlanRef?: ArtifactRef<"plan">;
  approvedPlanVersion?: number;
  latestPlanReviewRef?: ArtifactRef<"plan-review">;
}

export interface CodeReviewBinding {
  reviewId: PlannotatorReviewId;
  implementationRef: ArtifactRef<"implementation">;
  implementationRevision: number;
}

export function isCodeReviewBinding(
  value: unknown,
): value is CodeReviewBinding {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "reviewId",
      "implementationRef",
      "implementationRevision",
    ]) &&
    isNonEmptyString(value.reviewId) &&
    isArtifactOfKind(value.implementationRef, "implementation") &&
    isNonNegativeInteger(value.implementationRevision) &&
    value.implementationRevision > 0
  );
}

export interface CodingState {
  workerAttemptRef?: ArtifactRef<"implementation">;
  codeReview?: CodeReviewBinding;
  previousRoundDecisionRef?: ArtifactRef<"round-decision">;
  implementationRevision: number;
  reviewRound: number;
  executionRoutingRef?: ArtifactRef<"execution-routing">;
  implementationRef?: ArtifactRef<"implementation">;
  validationRef?: ArtifactRef<"validation">;
  correctnessReviewRef?: ArtifactRef<"correctness-review">;
  ponytailReviewRef?: ArtifactRef<"ponytail-review">;
  findingEvaluationRef?: ArtifactRef<"finding-evaluation">;
  acceptedFindingsRef?: ArtifactRef<"accepted-findings">;
  roundDecisionRef?: ArtifactRef<"round-decision">;
  latestCodeReviewRef?: ArtifactRef<"code-review">;
}

export interface RetryCounters {
  automatedFixRoundsUsed: number;
  strongerRetriesUsed: number;
  humanCodeFeedbackRounds: number;
}

export type ExternalIdentities = Record<string, string>;

export interface BlockState {
  blockedFrom: WorkflowPhase;
  reason: BlockedReason;
  evidenceRef?: ArtifactRef;
}

export interface FailureState {
  reason: FailureReason;
  evidenceRef?: ArtifactRef;
}

export interface JevUsageState {
  authorizationRef?: ArtifactRef<"jev-request">;
  attemptsReserved: number;
  latestRequestRef?: ArtifactRef<"jev-request">;
  latestUsageRef?: ArtifactRef<"jev-request">;
}
function isJevUsage(value: unknown): value is JevUsageState {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "authorizationRef",
      "attemptsReserved",
      "latestRequestRef",
      "latestUsageRef",
    ]) &&
    isNonNegativeInteger(value.attemptsReserved) &&
    optional(value, "authorizationRef", (ref) =>
      isArtifactOfKind(ref, "jev-request"),
    ) &&
    optional(value, "latestRequestRef", (ref) =>
      isArtifactOfKind(ref, "jev-request"),
    ) &&
    optional(value, "latestUsageRef", (ref) =>
      isArtifactOfKind(ref, "jev-request"),
    ) &&
    (value.attemptsReserved === 0
      ? value.latestRequestRef === undefined
      : value.latestRequestRef !== undefined)
  );
}
export interface WorkflowState {
  /** Missing legacy scope/accounting is diagnosable, never permission to send. */
  projectRoot?: string;
  jevUsage?: JevUsageState;
  oracle?: OracleState;
  schemaVersion: 1;
  workflowId: WorkflowId;
  stateRevision: number;
  playbook: PlaybookKind;
  phase: WorkflowPhase;
  taskRef: ArtifactRef<"task">;
  planning: PlanningState;
  coding: CodingState;
  counters: RetryCounters;
  external: ExternalIdentities;
  block?: BlockState;
  failure?: FailureState;
  createdAt: string;
  updatedAt: string;
}

export type WorkflowEvent =
  | {
      type: "DEVELOPMENT_METHOD_RESOLVED";
      methodRef: ArtifactRef<"development-method">;
    }
  | { type: "DIAGNOSIS_PERSISTED"; diagnosisRef: ArtifactRef<"diagnosis"> }
  | {
      type: "STAGE_RESOLVED";
      stage: ConditionalStage;
      decisionRef: ArtifactRef<"conditional-stage">;
      required: boolean;
    }
  | {
      type: "CLARIFICATION_MODE_RESOLVED";
      decisionRef: ArtifactRef<"clarification-mode">;
    }
  | {
      type: "CONTEXT_EVIDENCE_PERSISTED";
      scoutRef?: ArtifactRef<"scout">;
      researchRef?: ArtifactRef<"research">;
    }
  | {
      type: "CONTEXT_READY";
      scoutRef?: ArtifactRef<"scout">;
      researchRef?: ArtifactRef<"research">;
    }
  | {
      type: "CLARIFICATION_REQUIRED";
      reasonRef?: ArtifactRef;
      scoutRef?: ArtifactRef<"scout">;
      researchRef?: ArtifactRef<"research">;
    }
  | {
      type: "CLARIFICATION_COMPLETE";
      clarificationRef: ArtifactRef<"clarification">;
    }
  | { type: "PLAN_CREATED"; planRef: ArtifactRef<"plan">; version: number }
  | {
      type: "PLAN_APPROVED";
      planRef: ArtifactRef<"plan">;
      version: number;
      reviewRef: ArtifactRef<"plan-review">;
    }
  | { type: "PLAN_FEEDBACK"; feedbackRef: ArtifactRef<"plan-review"> }
  | { type: "REPLAN_REQUIRED"; decisionRef: ArtifactRef<"round-decision"> }
  | {
      type: "EXECUTION_ROUTED";
      decisionRef: ArtifactRef<"execution-routing">;
    }
  | {
      type: "IMPLEMENTATION_COMPLETE";
      resultRef: ArtifactRef<"implementation">;
      runId?: SubagentRunId;
    }
  | { type: "VALIDATION_PASSED"; resultRef: ArtifactRef<"validation"> }
  | {
      type: "REVIEW_ARTIFACTS_PERSISTED";
      correctnessReviewRef: ArtifactRef<"correctness-review">;
      ponytailReviewRef: ArtifactRef<"ponytail-review">;
    }
  | {
      type: "FINDING_EVALUATION_PERSISTED";
      findingEvaluationRef: ArtifactRef<"finding-evaluation">;
      acceptedFindingsRef: ArtifactRef<"accepted-findings">;
    }
  | {
      type: "RETRY_REQUIRED";
      decisionRef: ArtifactRef<"round-decision">;
      findingsRef?: ArtifactRef<"accepted-findings">;
      validationRef?: ArtifactRef<"validation">;
    }
  | {
      type: "REVIEW_RETRY_REQUIRED";
      decisionRef: ArtifactRef<"round-decision">;
      findingsRef?: ArtifactRef<"accepted-findings">;
    }
  | {
      type: "STRONGER_RETRY_REQUIRED";
      decisionRef: ArtifactRef<"round-decision">;
      findingsRef?: ArtifactRef<"accepted-findings">;
      executionRoutingRef?: ArtifactRef<"execution-routing">;
    }
  | { type: "REVIEW_COMPLETE"; decisionRef: ArtifactRef<"round-decision"> }
  | { type: "CODE_APPROVED"; reviewRef: ArtifactRef<"code-review"> }
  | { type: "CODE_FEEDBACK"; feedbackRef: ArtifactRef<"code-review"> }
  | { type: "BLOCK"; reason: BlockedReason; evidenceRef?: ArtifactRef }
  | {
      type: "BLOCK_RESOLVED";
      evidenceRef?: ArtifactRef<"reconciliation">;
    }
  | { type: "FAIL"; reason: FailureReason; evidenceRef?: ArtifactRef };

function isArtifactOfKind<K extends ArtifactRef["kind"]>(
  value: unknown,
  kind: K,
): value is ArtifactRef<K> {
  return isArtifactRef(value) && value.kind === kind;
}

function isPlaybookKind(value: unknown): value is PlaybookKind {
  return isOneOf(playbookKinds, value);
}

function isExternalIdentities(value: unknown): value is ExternalIdentities {
  return (
    isRecord(value) &&
    Object.values(value).every((identity) => isNonEmptyString(identity))
  );
}

export function isPlanReviewBinding(
  value: unknown,
): value is PlanReviewBinding {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["reviewId", "planRef", "planVersion"]) &&
    isNonEmptyString(value.reviewId) &&
    isArtifactOfKind(value.planRef, "plan") &&
    Number.isSafeInteger(value.planVersion) &&
    typeof value.planVersion === "number" &&
    value.planVersion > 0
  );
}

function isPlanningState(value: unknown): value is PlanningState {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "context",
      "developmentIntent",
      "developmentMethodRef",
      "clarificationRequestRef",
      "clarificationProgressRef",
      "domainDocumentWriteRef",
      "agentAttempts",
      "stageDecisionRefs",
      "clarificationModeRef",
      "architectureRequired",
      "researchRequired",
      "clarificationRequired",
      "planReview",
      "currentPlanRef",
      "currentPlanVersion",
      "approvedPlanRef",
      "approvedPlanVersion",
      "latestPlanReviewRef",
    ]) ||
    ![
      "architectureRequired",
      "researchRequired",
      "clarificationRequired",
    ].every((key) =>
      optional(value, key, (candidate) => typeof candidate === "boolean"),
    ) ||
    !optional(
      value,
      "stageDecisionRefs",
      (refs) =>
        isRecord(refs) &&
        hasOnlyKeys(refs, conditionalStages) &&
        Object.values(refs).every((ref) =>
          isArtifactOfKind(ref, "conditional-stage"),
        ),
    ) ||
    !optional(value, "developmentIntent", (intent) =>
      isOneOf(developmentIntents, intent),
    ) ||
    !optional(value, "developmentMethodRef", (ref) =>
      isArtifactOfKind(ref, "development-method"),
    ) ||
    !optional(value, "clarificationModeRef", (ref) =>
      isArtifactOfKind(ref, "clarification-mode"),
    ) ||
    !optional(value, "clarificationRequestRef", (ref) =>
      isArtifactOfKind(ref, "clarification"),
    ) ||
    !optional(value, "clarificationProgressRef", (ref) =>
      isArtifactOfKind(ref, "clarification"),
    ) ||
    !optional(value, "domainDocumentWriteRef", (ref) =>
      isArtifactOfKind(ref, "domain-document-write"),
    ) ||
    !optional(value, "agentAttempts", isPlanningAgentAttempts) ||
    !optional(value, "planReview", isPlanReviewBinding) ||
    !isNonNegativeInteger(value.currentPlanVersion) ||
    !optional(value, "currentPlanRef", (candidate) =>
      isArtifactOfKind(candidate, "plan"),
    ) ||
    !optional(value, "approvedPlanRef", (candidate) =>
      isArtifactOfKind(candidate, "plan"),
    ) ||
    !optional(value, "approvedPlanVersion", isNonNegativeInteger) ||
    !optional(value, "latestPlanReviewRef", (candidate) =>
      isArtifactOfKind(candidate, "plan-review"),
    )
  ) {
    return false;
  }

  if (
    !isRecord(value.context) ||
    !hasOnlyKeys(value.context, [
      "scoutRef",
      "diagnosisRef",
      "researchRef",
      "clarificationRef",
    ])
  ) {
    return false;
  }

  return (
    optional(value.context, "scoutRef", (candidate) =>
      isArtifactOfKind(candidate, "scout"),
    ) &&
    optional(value.context, "diagnosisRef", (candidate) =>
      isArtifactOfKind(candidate, "diagnosis"),
    ) &&
    optional(value.context, "researchRef", (candidate) =>
      isArtifactOfKind(candidate, "research"),
    ) &&
    optional(value.context, "clarificationRef", (candidate) =>
      isArtifactOfKind(candidate, "clarification"),
    )
  );
}

function isCodingState(value: unknown): value is CodingState {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "implementationRevision",
      "reviewRound",
      "executionRoutingRef",
      "implementationRef",
      "validationRef",
      "correctnessReviewRef",
      "ponytailReviewRef",
      "findingEvaluationRef",
      "acceptedFindingsRef",
      "roundDecisionRef",
      "latestCodeReviewRef",
      "codeReview",
      "workerAttemptRef",
      "previousRoundDecisionRef",
    ]) ||
    !optional(value, "codeReview", isCodeReviewBinding) ||
    !isNonNegativeInteger(value.implementationRevision) ||
    !isNonNegativeInteger(value.reviewRound)
  ) {
    return false;
  }

  const refs: [string, ArtifactRef["kind"]][] = [
    ["executionRoutingRef", "execution-routing"],
    ["implementationRef", "implementation"],
    ["workerAttemptRef", "implementation"],
    ["validationRef", "validation"],
    ["correctnessReviewRef", "correctness-review"],
    ["ponytailReviewRef", "ponytail-review"],
    ["findingEvaluationRef", "finding-evaluation"],
    ["acceptedFindingsRef", "accepted-findings"],
    ["roundDecisionRef", "round-decision"],
    ["previousRoundDecisionRef", "round-decision"],
    ["latestCodeReviewRef", "code-review"],
  ];

  return refs.every(([key, kind]) =>
    optional(value, key, (candidate) => isArtifactOfKind(candidate, kind)),
  );
}

function isRetryCounters(value: unknown): value is RetryCounters {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "automatedFixRoundsUsed",
      "strongerRetriesUsed",
      "humanCodeFeedbackRounds",
    ]) &&
    isNonNegativeInteger(value.automatedFixRoundsUsed) &&
    isNonNegativeInteger(value.strongerRetriesUsed) &&
    isNonNegativeInteger(value.humanCodeFeedbackRounds)
  );
}

function isBlockState(value: unknown): value is BlockState {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["blockedFrom", "reason", "evidenceRef"]) &&
    isWorkflowPhase(value.blockedFrom) &&
    isOneOf(blockedReasons, value.reason) &&
    optional(value, "evidenceRef", isArtifactRef)
  );
}

function isFailureState(value: unknown): value is FailureState {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["reason", "evidenceRef"]) &&
    isOneOf(failureReasons, value.reason) &&
    optional(value, "evidenceRef", isArtifactRef)
  );
}

export function isWorkflowState(value: unknown): value is WorkflowState {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "schemaVersion",
      "workflowId",
      "stateRevision",
      "projectRoot",
      "jevUsage",
      "oracle",
      "playbook",
      "phase",
      "taskRef",
      "planning",
      "coding",
      "counters",
      "external",
      "block",
      "failure",
      "createdAt",
      "updatedAt",
    ]) &&
    isSchemaVersion(value.schemaVersion) &&
    isWorkflowId(value.workflowId) &&
    isNonNegativeInteger(value.stateRevision) &&
    optional(value, "projectRoot", isNonEmptyString) &&
    optional(value, "jevUsage", isJevUsage) &&
    optional(value, "oracle", isOracleState) &&
    isPlaybookKind(value.playbook) &&
    isWorkflowPhase(value.phase) &&
    isArtifactOfKind(value.taskRef, "task") &&
    isPlanningState(value.planning) &&
    isCodingState(value.coding) &&
    isRetryCounters(value.counters) &&
    isExternalIdentities(value.external) &&
    optional(value, "block", isBlockState) &&
    optional(value, "failure", isFailureState) &&
    isNonEmptyString(value.createdAt) &&
    isNonEmptyString(value.updatedAt)
  );
}

export function parseWorkflowState(value: unknown): WorkflowState {
  return parseSchema(value, isWorkflowState, "WorkflowState");
}

function isEvent(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return isRecord(value) && hasOnlyKeys(value, keys);
}

export function isWorkflowEvent(value: unknown): value is WorkflowEvent {
  if (!isRecord(value) || !isNonEmptyString(value.type)) {
    return false;
  }

  switch (value.type) {
    case "DIAGNOSIS_PERSISTED":
      return (
        isEvent(value, ["type", "diagnosisRef"]) &&
        isArtifactOfKind(value.diagnosisRef, "diagnosis")
      );
    case "STAGE_RESOLVED":
      return (
        isEvent(value, ["type", "stage", "decisionRef", "required"]) &&
        isOneOf(conditionalStages, value.stage) &&
        isArtifactOfKind(value.decisionRef, "conditional-stage") &&
        typeof value.required === "boolean"
      );
    case "DEVELOPMENT_METHOD_RESOLVED":
      return (
        isEvent(value, ["type", "methodRef"]) &&
        isArtifactOfKind(value.methodRef, "development-method")
      );
    case "CLARIFICATION_MODE_RESOLVED":
      return (
        isEvent(value, ["type", "decisionRef"]) &&
        isArtifactOfKind(value.decisionRef, "clarification-mode")
      );
    case "CONTEXT_EVIDENCE_PERSISTED":
      return (
        isEvent(value, ["type", "scoutRef", "researchRef"]) &&
        optional(value, "scoutRef", (candidate) =>
          isArtifactOfKind(candidate, "scout"),
        ) &&
        optional(value, "researchRef", (candidate) =>
          isArtifactOfKind(candidate, "research"),
        )
      );
    case "CONTEXT_READY":
      return (
        isEvent(value, ["type", "scoutRef", "researchRef"]) &&
        optional(value, "scoutRef", (candidate) =>
          isArtifactOfKind(candidate, "scout"),
        ) &&
        optional(value, "researchRef", (candidate) =>
          isArtifactOfKind(candidate, "research"),
        )
      );
    case "CLARIFICATION_REQUIRED":
      return (
        isEvent(value, ["type", "reasonRef", "scoutRef", "researchRef"]) &&
        optional(value, "reasonRef", isArtifactRef) &&
        optional(value, "scoutRef", (candidate) =>
          isArtifactOfKind(candidate, "scout"),
        ) &&
        optional(value, "researchRef", (candidate) =>
          isArtifactOfKind(candidate, "research"),
        )
      );
    case "CLARIFICATION_COMPLETE":
      return (
        isEvent(value, ["type", "clarificationRef"]) &&
        isArtifactOfKind(value.clarificationRef, "clarification")
      );
    case "PLAN_CREATED":
      return (
        isEvent(value, ["type", "planRef", "version"]) &&
        isArtifactOfKind(value.planRef, "plan") &&
        isNonNegativeInteger(value.version)
      );
    case "PLAN_APPROVED":
      return (
        isEvent(value, ["type", "planRef", "version", "reviewRef"]) &&
        isArtifactOfKind(value.planRef, "plan") &&
        isNonNegativeInteger(value.version) &&
        isArtifactOfKind(value.reviewRef, "plan-review")
      );
    case "PLAN_FEEDBACK":
      return (
        isEvent(value, ["type", "feedbackRef"]) &&
        isArtifactOfKind(value.feedbackRef, "plan-review")
      );
    case "REPLAN_REQUIRED":
      return (
        isEvent(value, ["type", "decisionRef"]) &&
        isArtifactOfKind(value.decisionRef, "round-decision")
      );
    case "EXECUTION_ROUTED":
      return (
        isEvent(value, ["type", "decisionRef"]) &&
        isArtifactOfKind(value.decisionRef, "execution-routing")
      );
    case "IMPLEMENTATION_COMPLETE":
      return (
        isEvent(value, ["type", "resultRef", "runId"]) &&
        isArtifactOfKind(value.resultRef, "implementation") &&
        optional(value, "runId", isSubagentRunId)
      );
    case "VALIDATION_PASSED":
      return (
        isEvent(value, ["type", "resultRef"]) &&
        isArtifactOfKind(value.resultRef, "validation")
      );
    case "REVIEW_ARTIFACTS_PERSISTED":
      return (
        isEvent(value, ["type", "correctnessReviewRef", "ponytailReviewRef"]) &&
        isArtifactOfKind(value.correctnessReviewRef, "correctness-review") &&
        isArtifactOfKind(value.ponytailReviewRef, "ponytail-review")
      );
    case "FINDING_EVALUATION_PERSISTED":
      return (
        isEvent(value, [
          "type",
          "findingEvaluationRef",
          "acceptedFindingsRef",
        ]) &&
        isArtifactOfKind(value.findingEvaluationRef, "finding-evaluation") &&
        isArtifactOfKind(value.acceptedFindingsRef, "accepted-findings")
      );
    case "RETRY_REQUIRED":
      return (
        isEvent(value, [
          "type",
          "decisionRef",
          "findingsRef",
          "validationRef",
        ]) &&
        isArtifactOfKind(value.decisionRef, "round-decision") &&
        optional(value, "findingsRef", (candidate) =>
          isArtifactOfKind(candidate, "accepted-findings"),
        ) &&
        optional(value, "validationRef", (candidate) =>
          isArtifactOfKind(candidate, "validation"),
        )
      );
    case "REVIEW_RETRY_REQUIRED":
      return (
        isEvent(value, ["type", "decisionRef", "findingsRef"]) &&
        isArtifactOfKind(value.decisionRef, "round-decision") &&
        optional(value, "findingsRef", (candidate) =>
          isArtifactOfKind(candidate, "accepted-findings"),
        )
      );
    case "STRONGER_RETRY_REQUIRED":
      return (
        isEvent(value, [
          "type",
          "decisionRef",
          "findingsRef",
          "executionRoutingRef",
        ]) &&
        isArtifactOfKind(value.decisionRef, "round-decision") &&
        optional(value, "findingsRef", (candidate) =>
          isArtifactOfKind(candidate, "accepted-findings"),
        ) &&
        optional(value, "executionRoutingRef", (candidate) =>
          isArtifactOfKind(candidate, "execution-routing"),
        )
      );
    case "REVIEW_COMPLETE":
      return (
        isEvent(value, ["type", "decisionRef"]) &&
        isArtifactOfKind(value.decisionRef, "round-decision")
      );
    case "CODE_APPROVED":
      return (
        isEvent(value, ["type", "reviewRef"]) &&
        isArtifactOfKind(value.reviewRef, "code-review")
      );
    case "CODE_FEEDBACK":
      return (
        isEvent(value, ["type", "feedbackRef"]) &&
        isArtifactOfKind(value.feedbackRef, "code-review")
      );
    case "BLOCK":
      return (
        isEvent(value, ["type", "reason", "evidenceRef"]) &&
        isOneOf(blockedReasons, value.reason) &&
        optional(value, "evidenceRef", isArtifactRef)
      );
    case "BLOCK_RESOLVED":
      return (
        isEvent(value, ["type", "evidenceRef"]) &&
        optional(value, "evidenceRef", (candidate) =>
          isArtifactOfKind(candidate, "reconciliation"),
        )
      );
    case "FAIL":
      return (
        isEvent(value, ["type", "reason", "evidenceRef"]) &&
        isOneOf(failureReasons, value.reason) &&
        optional(value, "evidenceRef", isArtifactRef)
      );
    default:
      return false;
  }
}

export function parseWorkflowEvent(value: unknown): WorkflowEvent {
  return parseSchema(value, isWorkflowEvent, "WorkflowEvent");
}
