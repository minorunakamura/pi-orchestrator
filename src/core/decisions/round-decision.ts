import type { ArtifactRef } from "../artifacts/references.ts";
import type { RetryConfiguration } from "../configuration.ts";
import { isConfidence } from "../schema.ts";
import type { WorkflowEvent, RetryCounters } from "../workflow/state.ts";
import type { ConfidencePolicy } from "./confidence-policy.ts";
import {
  strongerModelTier,
  strongerReasoningTier,
} from "./execution-routing.ts";
import { escalationReasons } from "./types.ts";
import { applyConfidencePolicy } from "./confidence-policy.ts";
import type {
  EvaluatedFinding,
  ModelTier,
  NormalizedRoundDecision,
  ReasoningTier,
  RoundDecision,
  ValidationResult,
} from "./types.ts";

export type RoundDecisionFinding = EvaluatedFinding;

export interface LogicalExecutionProfile {
  modelTier: ModelTier;
  reasoningTier: ReasoningTier;
}

export interface RoundDecisionRoutingInput {
  phase: "validating" | "reviewing";
  counters: RetryCounters;
  retries: Pick<
    RetryConfiguration,
    "maxAutomatedFixRounds" | "maxStrongerRetries"
  >;
  decision: RoundDecision;
  decisionRef: ArtifactRef<"round-decision">;
  findingsRef?: ArtifactRef<"accepted-findings">;
  validationRef?: ArtifactRef<"validation">;
  currentProfile?: LogicalExecutionProfile;
}

export interface RoundDecisionPolicyInput {
  rawDecision: NormalizedRoundDecision;
  validation: Pick<ValidationResult, "status">;
  findings: readonly RoundDecisionFinding[];
  /** IDs read from the accepted-findings artifact after semantic evaluation. */
  acceptedBlockingFindingIds?: readonly string[];
}

function rawReason(raw: NormalizedRoundDecision): string | undefined {
  return raw.reason === undefined ? undefined : raw.reason;
}

function retry(raw: NormalizedRoundDecision, reason: string): RoundDecision {
  return { decision: "RETRY", confidence: raw.confidence, reason };
}

function escalate(
  raw: NormalizedRoundDecision,
  reason:
    | "implementation-capability"
    | "plan-conflict"
    | "human-decision"
    | "uncertain",
): RoundDecision {
  return {
    decision: "ESCALATE",
    confidence: raw.confidence,
    escalationReason: reason,
  };
}

type AcceptedBlockingStatus = "none" | "blocking" | "invalid";

function acceptedBlockingStatus(
  input: RoundDecisionPolicyInput,
): AcceptedBlockingStatus {
  const accepted = new Map(
    input.findings
      .filter((finding) => finding.decision === "ACCEPT")
      .map((finding) => [finding.findingId, finding]),
  );
  if (
    input.findings.some(
      (finding) =>
        finding.decision === "ACCEPT" && typeof finding.blocking !== "boolean",
    )
  ) {
    return "invalid";
  }

  const blockingIds = input.acceptedBlockingFindingIds ?? [];
  if (new Set(blockingIds).size !== blockingIds.length) return "invalid";
  if (
    blockingIds.some((findingId) => accepted.get(findingId)?.blocking !== true)
  ) {
    return "invalid";
  }
  if (
    blockingIds.length > 0 ||
    [...accepted.values()].some((finding) => finding.blocking)
  ) {
    return "blocking";
  }
  return "none";
}

function findingEscalationReason(
  findings: readonly RoundDecisionFinding[],
): "human-decision" | "uncertain" | undefined {
  if (findings.some((finding) => finding.reasonCode === "human-decision")) {
    return "human-decision";
  }
  if (findings.some((finding) => finding.decision === "ESCALATE")) {
    return "uncertain";
  }
  return undefined;
}

export function strongerExecutionProfile(
  profile: LogicalExecutionProfile,
): LogicalExecutionProfile {
  return {
    modelTier: strongerModelTier(profile.modelTier),
    reasoningTier: strongerReasoningTier(profile.reasoningTier),
  };
}

function isStrongestProfile(profile: LogicalExecutionProfile): boolean {
  const stronger = strongerExecutionProfile(profile);
  return (
    stronger.modelTier === profile.modelTier &&
    stronger.reasoningTier === profile.reasoningTier
  );
}

function retryBudgetAvailable(
  input: RoundDecisionRoutingInput,
  stronger: boolean,
): boolean {
  if (
    input.counters.automatedFixRoundsUsed >= input.retries.maxAutomatedFixRounds
  ) {
    return false;
  }
  return (
    !stronger ||
    input.counters.strongerRetriesUsed < input.retries.maxStrongerRetries
  );
}

function blockedForBudget(
  input: RoundDecisionRoutingInput,
): Extract<WorkflowEvent, { type: "BLOCK" }> {
  return {
    type: "BLOCK",
    reason: "retry-budget-exhausted",
    evidenceRef: input.decisionRef,
  };
}

function retryEvent(input: RoundDecisionRoutingInput): WorkflowEvent {
  if (!retryBudgetAvailable(input, false)) return blockedForBudget(input);
  if (input.phase === "validating") {
    return {
      type: "RETRY_REQUIRED",
      decisionRef: input.decisionRef,
      ...(input.findingsRef ? { findingsRef: input.findingsRef } : {}),
      ...(input.validationRef ? { validationRef: input.validationRef } : {}),
    };
  }
  return {
    type: "REVIEW_RETRY_REQUIRED",
    decisionRef: input.decisionRef,
    ...(input.findingsRef ? { findingsRef: input.findingsRef } : {}),
  };
}

export function routeRoundDecision(
  input: RoundDecisionRoutingInput,
): WorkflowEvent {
  if (
    !Number.isSafeInteger(input.retries.maxAutomatedFixRounds) ||
    input.retries.maxAutomatedFixRounds <= 0
  ) {
    throw new Error("maxAutomatedFixRounds must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(input.retries.maxStrongerRetries) ||
    input.retries.maxStrongerRetries <= 0
  ) {
    throw new Error("maxStrongerRetries must be a positive safe integer");
  }

  if (input.decision.decision === "COMPLETE") {
    if (input.phase !== "reviewing") {
      throw new Error("COMPLETE can only route from reviewing");
    }
    return { type: "REVIEW_COMPLETE", decisionRef: input.decisionRef };
  }

  if (input.decision.decision === "RETRY") {
    return retryEvent(input);
  }
  if (input.decision.decision !== "ESCALATE") {
    throw new Error("Unsupported round decision");
  }

  switch (input.decision.escalationReason) {
    case "implementation-capability":
      if (input.currentProfile && isStrongestProfile(input.currentProfile)) {
        return {
          type: "BLOCK",
          reason: "stronger-profile-unavailable",
          evidenceRef: input.decisionRef,
        };
      }
      if (!retryBudgetAvailable(input, true)) return blockedForBudget(input);
      return {
        type: "STRONGER_RETRY_REQUIRED",
        decisionRef: input.decisionRef,
        ...(input.findingsRef ? { findingsRef: input.findingsRef } : {}),
      };
    case "plan-conflict":
      return { type: "REPLAN_REQUIRED", decisionRef: input.decisionRef };
    case "human-decision":
    case "uncertain":
      return {
        type: "CLARIFICATION_REQUIRED",
        reasonRef: input.decisionRef,
      };
    default:
      throw new Error("ESCALATE requires a valid escalation reason");
  }
}

export function decideRound(
  input: RoundDecisionPolicyInput,
  policy: ConfidencePolicy,
): RoundDecision {
  if (!isConfidence(input.rawDecision.confidence)) {
    throw new Error("Round decision confidence must be between 0 and 1");
  }

  const raw = input.rawDecision;
  if (raw.decision === "ESCALATE") {
    if (
      raw.escalationReason === undefined ||
      !escalationReasons.includes(raw.escalationReason) ||
      !isConfidence(raw.escalationReasonConfidence)
    ) {
      throw new Error("ESCALATE requires a valid escalation reason");
    }
  }

  const findingReason = findingEscalationReason(input.findings);
  if (findingReason) return escalate(raw, findingReason);
  if (
    applyConfidencePolicy(raw.confidence, policy) !== "auto" ||
    (raw.decision === "ESCALATE" &&
      applyConfidencePolicy(raw.escalationReasonConfidence, policy) !== "auto")
  ) {
    return escalate(raw, "uncertain");
  }
  if (raw.decision === "ESCALATE") return escalate(raw, raw.escalationReason);

  if (raw.decision === "RETRY") {
    return {
      decision: "RETRY",
      confidence: raw.confidence,
      ...(rawReason(raw) ? { reason: rawReason(raw) } : {}),
    };
  }
  if (raw.decision !== "COMPLETE") {
    throw new Error("Unsupported normalized round decision");
  }

  if (input.validation.status === "failed") {
    return retry(raw, "validation-failed");
  }
  if (input.validation.status === "infrastructure-error") {
    return escalate(raw, "uncertain");
  }
  const blockingStatus = acceptedBlockingStatus(input);
  if (blockingStatus === "invalid") return escalate(raw, "uncertain");
  if (blockingStatus === "blocking") {
    return retry(raw, "accepted-blocking-findings");
  }

  return {
    decision: "COMPLETE",
    confidence: raw.confidence,
    ...(rawReason(raw) ? { reason: rawReason(raw) } : {}),
  };
}
