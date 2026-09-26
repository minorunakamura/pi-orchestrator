import { isConfidence, isRecord } from "../schema.ts";

export interface ConfidencePolicy {
  autoDecisionThreshold: number;
  escalationThreshold: number;
}

export type ConfidenceDisposition = "auto" | "stronger" | "escalate";

export function isConfidencePolicy(value: unknown): value is ConfidencePolicy {
  if (!isRecord(value)) return false;
  return (
    isConfidence(value.autoDecisionThreshold) &&
    isConfidence(value.escalationThreshold) &&
    value.escalationThreshold <= value.autoDecisionThreshold
  );
}

function assertConfidencePolicy(policy: ConfidencePolicy): void {
  if (!isConfidencePolicy(policy)) {
    throw new Error(
      "Confidence policy requires 0 <= escalationThreshold <= autoDecisionThreshold <= 1",
    );
  }
}

export function applyConfidencePolicy(
  confidence: number,
  policy: ConfidencePolicy,
): ConfidenceDisposition {
  assertConfidencePolicy(policy);
  if (!isConfidence(confidence)) {
    throw new Error("Decision confidence must be between 0 and 1");
  }
  if (confidence >= policy.autoDecisionThreshold) return "auto";
  if (confidence >= policy.escalationThreshold) return "stronger";
  return "escalate";
}
