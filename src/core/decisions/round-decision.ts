import { isConfidence } from "../schema.ts";
import type { ConfidencePolicy } from "./confidence-policy.ts";
import { escalationReasons } from "./types.ts";
import { applyConfidencePolicy } from "./confidence-policy.ts";
import type {
  EvaluatedFinding,
  NormalizedRoundDecision,
  RoundDecision,
  ValidationResult,
} from "./types.ts";

export type RoundDecisionFinding = EvaluatedFinding;

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
      !escalationReasons.includes(raw.escalationReason)
    ) {
      throw new Error("ESCALATE requires a valid escalation reason");
    }
    return escalate(raw, raw.escalationReason);
  }

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

  const findingReason = findingEscalationReason(input.findings);
  if (findingReason) return escalate(raw, findingReason);

  if (applyConfidencePolicy(raw.confidence, policy) !== "auto") {
    return escalate(raw, "uncertain");
  }

  return {
    decision: "COMPLETE",
    confidence: raw.confidence,
    ...(rawReason(raw) ? { reason: rawReason(raw) } : {}),
  };
}
