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

export interface FindingEvaluationInput {
  approvedPlanRef: ArtifactRef<"plan">;
  implementationRevision: number;
  findings: readonly ReviewFinding[];
}

export interface RoundDecisionInput {
  approvedPlanRef: ArtifactRef<"plan">;
  implementationRevision: number;
  validation: ValidationResult;
  findings: readonly FindingEvaluation[];
}

export type ExecutionRoutingRawDecision = NormalizedExecutionRoutingDecision;
export type FindingEvaluationRawDecision = NormalizedFindingEvaluationDecision;
export type RoundDecisionRawDecision = NormalizedRoundDecision;

export interface JevDecisionClient {
  routeExecution(
    input: ExecutionRoutingInput,
  ): Promise<ExecutionRoutingRawDecision>;
  evaluateFindings(
    input: FindingEvaluationInput,
  ): Promise<FindingEvaluationRawDecision[]>;
  decideRound(input: RoundDecisionInput): Promise<RoundDecisionRawDecision>;
}
