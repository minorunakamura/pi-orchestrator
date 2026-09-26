import {
  isConfidence,
  isNonEmptyString,
  isNonNegativeInteger,
  isRecord,
  hasOnlyKeys,
  parseSchema,
} from "./schema.ts";
import {
  modelTiers,
  reasoningTiers,
  type ModelTier,
  type ReasoningTier,
} from "./decisions/types.ts";

export interface ExecutionProfile {
  provider: string;
  model: string;
}

export type ReasoningMapping = Record<ReasoningTier, string>;

export interface RetryConfiguration {
  maxAutomatedFixRounds: number;
  maxStrongerRetries: number;
}

export interface ValidationConfiguration {
  stopOnInfrastructureFailure: boolean;
}

export interface JevConfiguration {
  endpoint?: string;
  timeoutMs?: number;
  maxTransportRetries?: number;
}

export interface OrchestratorConfiguration {
  decision: {
    autoDecisionThreshold: number;
    escalationThreshold: number;
  };
  executionProfiles: Record<ModelTier, ExecutionProfile>;
  reasoningMapping: ReasoningMapping;
  retries: RetryConfiguration;
  validation: ValidationConfiguration;
  jev: JevConfiguration;
}

export interface ResolvedExecutionProfile extends ExecutionProfile {
  thinking: string;
}

export const DEFAULT_RETRY_LIMITS = {
  maxAutomatedFixRounds: 3,
  maxStrongerRetries: 1,
} as const;

function hasRequiredKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => Object.hasOwn(value, key));
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function isExecutionProfile(value: unknown): value is ExecutionProfile {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["provider", "model"]) &&
    hasRequiredKeys(value, ["provider", "model"]) &&
    isNonEmptyString(value.provider) &&
    isNonEmptyString(value.model)
  );
}

function isReasoningMapping(value: unknown): value is ReasoningMapping {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, reasoningTiers) &&
    hasRequiredKeys(value, reasoningTiers) &&
    reasoningTiers.every((tier) => isNonEmptyString(value[tier]))
  );
}

function isDecisionConfiguration(
  value: unknown,
): value is OrchestratorConfiguration["decision"] {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["autoDecisionThreshold", "escalationThreshold"]) &&
    hasRequiredKeys(value, ["autoDecisionThreshold", "escalationThreshold"]) &&
    isConfidence(value.autoDecisionThreshold) &&
    isConfidence(value.escalationThreshold)
  );
}

function isRetryConfiguration(value: unknown): value is RetryConfiguration {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["maxAutomatedFixRounds", "maxStrongerRetries"]) &&
    hasRequiredKeys(value, ["maxAutomatedFixRounds", "maxStrongerRetries"]) &&
    isPositiveInteger(value.maxAutomatedFixRounds) &&
    isPositiveInteger(value.maxStrongerRetries)
  );
}

function isValidationConfiguration(
  value: unknown,
): value is ValidationConfiguration {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["stopOnInfrastructureFailure"]) &&
    hasRequiredKeys(value, ["stopOnInfrastructureFailure"]) &&
    typeof value.stopOnInfrastructureFailure === "boolean"
  );
}

function isJevConfiguration(value: unknown): value is JevConfiguration {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["endpoint", "timeoutMs", "maxTransportRetries"]) &&
    (!Object.hasOwn(value, "endpoint") || isNonEmptyString(value.endpoint)) &&
    (!Object.hasOwn(value, "timeoutMs") ||
      (isNonNegativeInteger(value.timeoutMs) && value.timeoutMs > 0)) &&
    (!Object.hasOwn(value, "maxTransportRetries") ||
      isNonNegativeInteger(value.maxTransportRetries))
  );
}

export function isOrchestratorConfiguration(
  value: unknown,
): value is OrchestratorConfiguration {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "decision",
      "executionProfiles",
      "reasoningMapping",
      "retries",
      "validation",
      "jev",
    ]) ||
    !hasRequiredKeys(value, [
      "decision",
      "executionProfiles",
      "reasoningMapping",
      "retries",
      "validation",
      "jev",
    ]) ||
    !isDecisionConfiguration(value.decision) ||
    !isReasoningMapping(value.reasoningMapping) ||
    !isRetryConfiguration(value.retries) ||
    !isValidationConfiguration(value.validation) ||
    !isJevConfiguration(value.jev)
  ) {
    return false;
  }

  const executionProfiles = value.executionProfiles;
  if (
    !isRecord(executionProfiles) ||
    !hasOnlyKeys(executionProfiles, modelTiers) ||
    !hasRequiredKeys(executionProfiles, modelTiers)
  ) {
    return false;
  }

  return modelTiers.every((tier) =>
    isExecutionProfile(executionProfiles[tier]),
  );
}

export function parseConfiguration(value: unknown): OrchestratorConfiguration {
  return parseSchema(
    value,
    isOrchestratorConfiguration,
    "OrchestratorConfiguration",
  );
}

export function resolveExecutionProfile(
  configuration: OrchestratorConfiguration,
  modelTier: ModelTier,
  reasoningTier: ReasoningTier,
): ResolvedExecutionProfile {
  const profile = configuration.executionProfiles[modelTier];
  return {
    provider: profile.provider,
    model: profile.model,
    thinking: configuration.reasoningMapping[reasoningTier],
  };
}

export function toConfigurationSnapshot(
  configuration: OrchestratorConfiguration,
): OrchestratorConfiguration {
  return {
    decision: {
      autoDecisionThreshold: configuration.decision.autoDecisionThreshold,
      escalationThreshold: configuration.decision.escalationThreshold,
    },
    executionProfiles: {
      ECONOMY: {
        provider: configuration.executionProfiles.ECONOMY.provider,
        model: configuration.executionProfiles.ECONOMY.model,
      },
      STANDARD: {
        provider: configuration.executionProfiles.STANDARD.provider,
        model: configuration.executionProfiles.STANDARD.model,
      },
      STRONG: {
        provider: configuration.executionProfiles.STRONG.provider,
        model: configuration.executionProfiles.STRONG.model,
      },
    },
    reasoningMapping: {
      LOW: configuration.reasoningMapping.LOW,
      MEDIUM: configuration.reasoningMapping.MEDIUM,
      HIGH: configuration.reasoningMapping.HIGH,
    },
    retries: {
      maxAutomatedFixRounds: configuration.retries.maxAutomatedFixRounds,
      maxStrongerRetries: configuration.retries.maxStrongerRetries,
    },
    validation: {
      stopOnInfrastructureFailure:
        configuration.validation.stopOnInfrastructureFailure,
    },
    jev: {
      ...(configuration.jev.endpoint
        ? { endpoint: configuration.jev.endpoint }
        : {}),
      ...(configuration.jev.timeoutMs !== undefined
        ? { timeoutMs: configuration.jev.timeoutMs }
        : {}),
      ...(configuration.jev.maxTransportRetries !== undefined
        ? { maxTransportRetries: configuration.jev.maxTransportRetries }
        : {}),
    },
  };
}

export function serializeConfiguration(
  configuration: OrchestratorConfiguration,
): string {
  return JSON.stringify(toConfigurationSnapshot(configuration));
}
