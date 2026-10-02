import type { ArtifactRef } from "../../core/artifacts/references.ts";
import type { PlanSection } from "../../core/planning/policy.ts";
import type {
  FindingEvaluation,
  NormalizedExecutionRoutingDecision,
  NormalizedFindingEvaluationDecision,
  NormalizedRoundDecision,
  ValidationResult,
} from "../../core/decisions/types.ts";
import type { PlaybookKind } from "../../types.ts";
import type { ReviewFinding } from "../../core/coding/finding.ts";

export interface ExecutionRoutingPlanSectionEvidence {
  title: PlanSection;
  content: string;
}

export interface ExecutionRoutingPlanEvidence {
  /** Bounded summary assembled by the runtime before the Jev port call. */
  summary: string;
  /** Only the sections relevant to execution routing are included. */
  relevantSections: readonly ExecutionRoutingPlanSectionEvidence[];
}

export interface ExecutionRoutingContextEvidence {
  /** The immutable artifact from which this bounded excerpt was read. */
  ref: ArtifactRef;
  /** Bounded repository/context excerpt assembled by the runtime. */
  content: string;
}

export interface ExecutionRoutingInput {
  approvedPlanRef: ArtifactRef<"plan">;
  planEvidence: ExecutionRoutingPlanEvidence;
  playbook: PlaybookKind;
  changeScope: string;
  contextRefs: readonly ArtifactRef[];
  contextEvidence: readonly ExecutionRoutingContextEvidence[];
  priorRetryCount: number;
}

export interface CodingDecisionEvidence {
  plan: { ref: ArtifactRef<"plan">; content: string };
  architecture: "included-in-plan" | "not-required";
  implementation: { ref: ArtifactRef<"implementation">; content: string };
  counters: {
    automatedFixRoundsUsed: number;
    strongerRetriesUsed: number;
    humanCodeFeedbackRounds: number;
  };
  previousDecision: {
    ref: ArtifactRef<"round-decision">;
    content: string;
  } | null;
}

export interface ReviewEvidenceRefs {
  correctness: ArtifactRef<"correctness-review">;
  ponytail: ArtifactRef<"ponytail-review">;
}

export interface SourcedFinding {
  finding: ReviewFinding;
  sourceRef: ArtifactRef<"correctness-review" | "ponytail-review">;
}

export interface FindingEvaluationInput {
  evidence: CodingDecisionEvidence;
  reviewRefs: ReviewEvidenceRefs;
  approvedPlanRef: ArtifactRef<"plan">;
  implementationRevision: number;
  findings: readonly ReviewFinding[];
}

export interface RoundDecisionInput {
  evidence: CodingDecisionEvidence;
  findingSummaries: readonly SourcedFinding[];
  branch: "validation-failed" | "review-passed" | "infrastructure-attention";
  retryLimits: { maxAutomatedFixRounds: number; maxStrongerRetries: number };
  currentProfile: {
    modelTier: import("../../core/decisions/types.ts").ModelTier;
    reasoningTier: import("../../core/decisions/types.ts").ReasoningTier;
  };
  inputRefs: readonly ArtifactRef[];
  approvedPlanRef: ArtifactRef<"plan">;
  implementationRevision: number;
  validation: ValidationResult;
  findings: readonly FindingEvaluation[];
}

export type ExecutionRoutingRawDecision = NormalizedExecutionRoutingDecision;
export type FindingEvaluationRawDecision = NormalizedFindingEvaluationDecision;
export type RoundDecisionRawDecision = NormalizedRoundDecision;

export type JevRequestFamily =
  | "stage"
  | "clarification"
  | "method"
  | "routing"
  | "finding"
  | "round";

export interface ClassifierChoiceEvidence {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}
export interface JevAttempt {
  family: JevRequestFamily;
  destination: string;
  retryIndex: number;
  findingId?: string;
  requestDigest: string;
  configurationDigest: string;
  decisionSchemaVersion: 1;
}
export interface JevCallAuthorization {
  destination: string;
  authorizeAttempt(attempt: JevAttempt): Promise<void>;
  recordUsage(usage: {
    inputTokens?: number;
    outputTokens?: number;
    answers?: Record<string, ClassifierChoiceEvidence>;
  }): Promise<void>;
}

export interface PlanningClassifierInput {
  playbook: PlaybookKind;
  inputRefs: readonly ArtifactRef[];
  /** Exact, bounded evidence assembled by the runtime; no inferred approval. */
  evidence: Readonly<Record<string, unknown>>;
}
export interface ConditionalStageRoutingInput extends PlanningClassifierInput {
  stage: "research" | "clarification" | "architecture";
  policy: "conditional";
}
export interface DecisionClassifierPort extends JevDecisionClient {
  routeStage(
    input: ConditionalStageRoutingInput,
    authorization?: JevCallAuthorization,
  ): Promise<
    import("../../core/decisions/types.ts").Decision<
      "RUN" | "SKIP" | "ESCALATE"
    >
  >;
  routeClarification(
    input: PlanningClassifierInput,
    authorization?: JevCallAuthorization,
  ): Promise<
    import("../../core/decisions/types.ts").Decision<
      "SKIP" | "GRILL_ME" | "GRILL_WITH_DOCS" | "ESCALATE"
    >
  >;
  routeDevelopmentMethod(
    input: PlanningClassifierInput,
    authorization?: JevCallAuthorization,
  ): Promise<
    import("../../core/decisions/types.ts").Decision<
      "STANDARD" | "TDD" | "ESCALATE"
    >
  >;
}

export interface JevDecisionClient {
  routeExecution(
    input: ExecutionRoutingInput,
    authorization?: JevCallAuthorization,
  ): Promise<ExecutionRoutingRawDecision>;
  evaluateFindings(
    input: FindingEvaluationInput,
    authorization?: JevCallAuthorization,
  ): Promise<FindingEvaluationRawDecision[]>;
  decideRound(
    input: RoundDecisionInput,
    authorization?: JevCallAuthorization,
  ): Promise<RoundDecisionRawDecision>;
}
