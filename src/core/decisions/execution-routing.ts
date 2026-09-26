import type {
  Decision,
  ExecutionRoutingDecision,
  ModelTier,
  NormalizedExecutionRoutingDecision,
  ReasoningTier,
} from "./types.ts";
import {
  applyConfidencePolicy,
  type ConfidencePolicy,
} from "./confidence-policy.ts";

const strongerModels: Record<ModelTier, ModelTier> = {
  ECONOMY: "STANDARD",
  STANDARD: "STRONG",
  STRONG: "STRONG",
};

const strongerReasoning: Record<ReasoningTier, ReasoningTier> = {
  LOW: "MEDIUM",
  MEDIUM: "HIGH",
  HIGH: "HIGH",
};

export function strongerModelTier(tier: ModelTier): ModelTier {
  return strongerModels[tier];
}

export function strongerReasoningTier(tier: ReasoningTier): ReasoningTier {
  return strongerReasoning[tier];
}

export function resolveExecutionRouting(
  raw: NormalizedExecutionRoutingDecision,
  policy: ConfidencePolicy,
): ExecutionRoutingDecision {
  const effectiveConfidence = Math.min(
    raw.modelTier.confidence,
    raw.reasoningTier.confidence,
  );
  const modelTier: Decision<ModelTier> = { ...raw.modelTier };
  const reasoningTier: Decision<ReasoningTier> = { ...raw.reasoningTier };

  if (applyConfidencePolicy(effectiveConfidence, policy) !== "auto") {
    modelTier.value = strongerModelTier(modelTier.value);
    reasoningTier.value = strongerReasoningTier(reasoningTier.value);
  }

  return { modelTier, reasoningTier, effectiveConfidence };
}
