import type { ArtifactRef } from "../artifacts/references.ts";
import { isArtifactRef } from "../artifacts/references.ts";
import { isReviewFinding, type ReviewFinding } from "../coding/finding.ts";
import {
  hasKey,
  hasOnlyKeys,
  isConfidence,
  isNonEmptyString,
  isNonNegativeInteger,
  isOneOf,
  isRecord,
  isSchemaVersion,
  optional,
  parseSchema,
} from "../schema.ts";

export interface Decision<T> {
  value: T;
  confidence: number;
}

export type DecisionResult<T> =
  | { status: "decided"; decision: Decision<T> }
  | { status: "uncertain"; reason: string };

export function isDecision<T>(
  value: unknown,
  valuePredicate: (candidate: unknown) => candidate is T,
): value is Decision<T> {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["value", "confidence"]) &&
    valuePredicate(value.value) &&
    isConfidence(value.confidence)
  );
}

export function parseDecision<T>(
  value: unknown,
  valuePredicate: (candidate: unknown) => candidate is T,
): Decision<T> {
  return parseSchema(
    value,
    (candidate): candidate is Decision<T> =>
      isDecision(candidate, valuePredicate),
    "Decision",
  );
}

export const modelTiers = ["ECONOMY", "STANDARD", "STRONG"] as const;
export type ModelTier = (typeof modelTiers)[number];

export const reasoningTiers = ["LOW", "MEDIUM", "HIGH"] as const;
export type ReasoningTier = (typeof reasoningTiers)[number];

export function isModelTier(value: unknown): value is ModelTier {
  return isOneOf(modelTiers, value);
}

export function isReasoningTier(value: unknown): value is ReasoningTier {
  return isOneOf(reasoningTiers, value);
}

export interface ExecutionRoutingDecision {
  modelTier: Decision<ModelTier>;
  reasoningTier: Decision<ReasoningTier>;
  effectiveConfidence: number;
}

export function isExecutionRoutingDecision(
  value: unknown,
): value is ExecutionRoutingDecision {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["modelTier", "reasoningTier", "effectiveConfidence"]) &&
    isDecision(value.modelTier, isModelTier) &&
    isDecision(value.reasoningTier, isReasoningTier) &&
    isConfidence(value.effectiveConfidence)
  );
}

export function parseExecutionRoutingDecision(
  value: unknown,
): ExecutionRoutingDecision {
  return parseSchema(
    value,
    isExecutionRoutingDecision,
    "ExecutionRoutingDecision",
  );
}

export const findingDecisions = ["ACCEPT", "REJECT", "ESCALATE"] as const;
export type FindingDecision = (typeof findingDecisions)[number];

export interface FindingEvaluation {
  findingId: string;
  /** Optional for legacy normalized evidence; policy outputs always carry it. */
  blocking?: boolean;
  evidenceSupported: Decision<boolean>;
  conflictsWithApprovedPlan: Decision<boolean>;
  conflictsWithArchitecture: Decision<boolean>;
  inScope: Decision<boolean>;
  requiresHumanDecision: Decision<boolean>;
  decision: FindingDecision;
  reasonCode: string;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function isFindingEvaluation(
  value: unknown,
): value is FindingEvaluation {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "findingId",
      "blocking",
      "evidenceSupported",
      "conflictsWithApprovedPlan",
      "conflictsWithArchitecture",
      "inScope",
      "requiresHumanDecision",
      "decision",
      "reasonCode",
    ]) &&
    isNonEmptyString(value.findingId) &&
    (value.blocking === undefined || typeof value.blocking === "boolean") &&
    isDecision(value.evidenceSupported, isBoolean) &&
    isDecision(value.conflictsWithApprovedPlan, isBoolean) &&
    isDecision(value.conflictsWithArchitecture, isBoolean) &&
    isDecision(value.inScope, isBoolean) &&
    isDecision(value.requiresHumanDecision, isBoolean) &&
    isOneOf(findingDecisions, value.decision) &&
    isNonEmptyString(value.reasonCode)
  );
}

export function parseFindingEvaluation(value: unknown): FindingEvaluation {
  return parseSchema(value, isFindingEvaluation, "FindingEvaluation");
}

export const roundActions = ["COMPLETE", "RETRY", "ESCALATE"] as const;
export type RoundAction = (typeof roundActions)[number];

export type EscalationReason =
  | "implementation-capability"
  | "plan-conflict"
  | "human-decision"
  | "uncertain";

export const escalationReasons: readonly EscalationReason[] = [
  "implementation-capability",
  "plan-conflict",
  "human-decision",
  "uncertain",
];

/** Normalized Jev results consumed by pure core policy. */
export interface NormalizedExecutionRoutingDecision {
  modelTier: Decision<ModelTier>;
  reasoningTier: Decision<ReasoningTier>;
}

export interface NormalizedFindingEvaluationDecision {
  findingId: string;
  evidenceSupported: Decision<boolean>;
  conflictsWithApprovedPlan: Decision<boolean>;
  conflictsWithArchitecture: Decision<boolean>;
  inScope: Decision<boolean>;
  requiresHumanDecision: Decision<boolean>;
}

export type NormalizedRoundDecision =
  | {
      decision: "COMPLETE" | "RETRY";
      confidence: number;
      reason?: string;
    }
  | {
      decision: "ESCALATE";
      confidence: number;
      reason?: string;
      escalationReason: EscalationReason;
    };

export type EvaluatedFinding = FindingEvaluation & { blocking: boolean };

export interface FindingEvaluationArtifact {
  schemaVersion: 1;
  round: number;
  planVersion: number;
  implementationRevision: number;
  approvedPlanRef: ArtifactRef<"plan">;
  findings: EvaluatedFinding[];
}

export interface AcceptedFindingsArtifact {
  schemaVersion: 1;
  round: number;
  planVersion: number;
  implementationRevision: number;
  approvedPlanRef: ArtifactRef<"plan">;
  /** The only findings that may be supplied to a Fix Worker. */
  accepted: ReviewFinding[];
}

function hasUniqueFindingIds(
  findings: readonly { findingId?: string; id?: string }[],
): boolean {
  const ids = findings.map((finding) => finding.findingId ?? finding.id);
  return new Set(ids).size === ids.length;
}

export function isFindingEvaluationArtifact(
  value: unknown,
): value is FindingEvaluationArtifact {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "schemaVersion",
      "round",
      "planVersion",
      "implementationRevision",
      "approvedPlanRef",
      "findings",
    ]) &&
    isSchemaVersion(value.schemaVersion) &&
    isNonNegativeInteger(value.round) &&
    value.round > 0 &&
    isNonNegativeInteger(value.planVersion) &&
    value.planVersion > 0 &&
    isNonNegativeInteger(value.implementationRevision) &&
    isArtifactRef(value.approvedPlanRef) &&
    value.approvedPlanRef.kind === "plan" &&
    Array.isArray(value.findings) &&
    value.findings.every(
      (finding) =>
        isFindingEvaluation(finding) && typeof finding.blocking === "boolean",
    ) &&
    hasUniqueFindingIds(value.findings)
  );
}

export function parseFindingEvaluationArtifact(
  value: unknown,
): FindingEvaluationArtifact {
  return parseSchema(
    value,
    isFindingEvaluationArtifact,
    "FindingEvaluationArtifact",
  );
}

export function isAcceptedFindingsArtifact(
  value: unknown,
): value is AcceptedFindingsArtifact {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "schemaVersion",
      "round",
      "planVersion",
      "implementationRevision",
      "approvedPlanRef",
      "accepted",
    ]) &&
    isSchemaVersion(value.schemaVersion) &&
    isNonNegativeInteger(value.round) &&
    value.round > 0 &&
    isNonNegativeInteger(value.planVersion) &&
    value.planVersion > 0 &&
    isNonNegativeInteger(value.implementationRevision) &&
    isArtifactRef(value.approvedPlanRef) &&
    value.approvedPlanRef.kind === "plan" &&
    Array.isArray(value.accepted) &&
    value.accepted.every((finding) => isReviewFinding(finding)) &&
    hasUniqueFindingIds(value.accepted)
  );
}

export function parseAcceptedFindingsArtifact(
  value: unknown,
): AcceptedFindingsArtifact {
  return parseSchema(
    value,
    isAcceptedFindingsArtifact,
    "AcceptedFindingsArtifact",
  );
}

export type RoundDecision =
  | {
      decision: "COMPLETE" | "RETRY";
      confidence: number;
      reason?: string;
    }
  | {
      decision: "ESCALATE";
      confidence: number;
      reason?: string;
      escalationReason: EscalationReason;
    };

export function isRoundDecision(value: unknown): value is RoundDecision {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "decision",
      "confidence",
      "reason",
      "escalationReason",
    ]) ||
    !isOneOf(roundActions, value.decision) ||
    !isConfidence(value.confidence) ||
    !optional(value, "reason", isNonEmptyString)
  ) {
    return false;
  }

  return value.decision !== "ESCALATE"
    ? !hasKey(value, "escalationReason")
    : isOneOf(escalationReasons, value.escalationReason);
}

export function parseRoundDecision(value: unknown): RoundDecision {
  return parseSchema(value, isRoundDecision, "RoundDecision");
}

export type RoundDecisionArtifact = {
  schemaVersion: 1;
  round: number;
  planVersion: number;
  implementationRevision: number;
  approvedPlanRef: ArtifactRef<"plan">;
} & RoundDecision;

export function isRoundDecisionArtifact(
  value: unknown,
): value is RoundDecisionArtifact {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "round",
      "planVersion",
      "implementationRevision",
      "approvedPlanRef",
      "decision",
      "confidence",
      "reason",
      "escalationReason",
    ]) ||
    !isSchemaVersion(value.schemaVersion) ||
    !isNonNegativeInteger(value.round) ||
    value.round <= 0 ||
    !isNonNegativeInteger(value.planVersion) ||
    value.planVersion <= 0 ||
    !isNonNegativeInteger(value.implementationRevision) ||
    !isArtifactRef(value.approvedPlanRef) ||
    value.approvedPlanRef.kind !== "plan"
  ) {
    return false;
  }

  return isRoundDecision({
    decision: value.decision,
    confidence: value.confidence,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
    ...(value.escalationReason === undefined
      ? {}
      : { escalationReason: value.escalationReason }),
  });
}

export function parseRoundDecisionArtifact(
  value: unknown,
): RoundDecisionArtifact {
  return parseSchema(value, isRoundDecisionArtifact, "RoundDecisionArtifact");
}

export interface ValidationContract {
  schemaVersion: 1;
  checks: ValidationCheck[];
}

export interface ValidationCheck {
  id: string;
  type: "command";
  command: string;
  cwd: string;
  required: boolean;
  timeoutMs?: number;
}

export function isValidationCheck(value: unknown): value is ValidationCheck {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "id",
      "type",
      "command",
      "cwd",
      "required",
      "timeoutMs",
    ]) &&
    isNonEmptyString(value.id) &&
    value.type === "command" &&
    isNonEmptyString(value.command) &&
    isNonEmptyString(value.cwd) &&
    typeof value.required === "boolean" &&
    optional(
      value,
      "timeoutMs",
      (candidate) => isNonNegativeInteger(candidate) && candidate > 0,
    )
  );
}

export function isValidationContract(
  value: unknown,
): value is ValidationContract {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["schemaVersion", "checks"]) ||
    !isSchemaVersion(value.schemaVersion) ||
    !Array.isArray(value.checks) ||
    value.checks.length === 0 ||
    !value.checks.every(isValidationCheck)
  ) {
    return false;
  }

  const ids = value.checks.map((check) => check.id);
  return new Set(ids).size === ids.length;
}

export function parseValidationContract(value: unknown): ValidationContract {
  return parseSchema(value, isValidationContract, "ValidationContract");
}

export type ValidationCheckStatus =
  | "passed"
  | "failed"
  | "infrastructure-error";

export const validationCheckStatuses = [
  "passed",
  "failed",
  "infrastructure-error",
] as const;

export interface ValidationCheckResult {
  id: string;
  status: ValidationCheckStatus;
  exitCode?: number;
  evidence?: string;
}

export function isValidationCheckResult(
  value: unknown,
): value is ValidationCheckResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["id", "status", "exitCode", "evidence"]) &&
    isNonEmptyString(value.id) &&
    isOneOf(validationCheckStatuses, value.status) &&
    optional(value, "exitCode", isNonNegativeInteger) &&
    optional(value, "evidence", isNonEmptyString)
  );
}

export interface ValidationExecutionResult {
  status: ValidationCheckStatus;
  checks: ValidationCheckResult[];
}

export function isValidationExecutionResult(
  value: unknown,
): value is ValidationExecutionResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["status", "checks"]) &&
    isOneOf(validationCheckStatuses, value.status) &&
    Array.isArray(value.checks) &&
    value.checks.length > 0 &&
    value.checks.every(isValidationCheckResult)
  );
}

export function parseValidationExecutionResult(
  value: unknown,
): ValidationExecutionResult {
  return parseSchema(
    value,
    isValidationExecutionResult,
    "ValidationExecutionResult",
  );
}

export interface ValidationResult extends ValidationExecutionResult {
  schemaVersion: 1;
  implementationRevision: number;
}

export function isValidationResult(value: unknown): value is ValidationResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "schemaVersion",
      "implementationRevision",
      "status",
      "checks",
    ]) &&
    isSchemaVersion(value.schemaVersion) &&
    isNonNegativeInteger(value.implementationRevision) &&
    isOneOf(validationCheckStatuses, value.status) &&
    Array.isArray(value.checks) &&
    value.checks.length > 0 &&
    value.checks.every(isValidationCheckResult)
  );
}

export function parseValidationResult(value: unknown): ValidationResult {
  return parseSchema(value, isValidationResult, "ValidationResult");
}
