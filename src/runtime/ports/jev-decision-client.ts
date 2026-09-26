import type { ArtifactRef } from "../../core/artifacts/references.ts";
import type {
  Decision,
  EscalationReason,
  FindingEvaluation,
  ModelTier,
  ReasoningTier,
  RoundAction,
  ValidationResult,
} from "../../core/decisions/types.ts";
import type { PlaybookKind } from "../../types.ts";
import type { ReviewFinding } from "../../core/coding/finding.ts";

export interface ExecutionRoutingInput {
  approvedPlanRef: ArtifactRef<"plan">;
  playbook: PlaybookKind;
  changeScope: string;
  contextRefs: readonly ArtifactRef[];
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

export interface ExecutionRoutingRawDecision {
  modelTier: Decision<ModelTier>;
  reasoningTier: Decision<ReasoningTier>;
}

export interface FindingEvaluationRawDecision {
  findingId: string;
  evidenceSupported: Decision<boolean>;
  conflictsWithApprovedPlan: Decision<boolean>;
  conflictsWithArchitecture: Decision<boolean>;
  inScope: Decision<boolean>;
  requiresHumanDecision: Decision<boolean>;
}

export interface RoundDecisionRawDecision {
  decision: RoundAction;
  confidence: number;
  reason?: string;
  escalationReason?: EscalationReason;
}

export interface JevDecisionClient {
  routeExecution(
    input: ExecutionRoutingInput,
  ): Promise<ExecutionRoutingRawDecision>;
  evaluateFindings(
    input: FindingEvaluationInput,
  ): Promise<FindingEvaluationRawDecision[]>;
  decideRound(input: RoundDecisionInput): Promise<RoundDecisionRawDecision>;
}
