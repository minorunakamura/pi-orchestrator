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

export const jevEvidenceCategories = [
  "plan",
  "context",
  "implementation",
  "review",
  "validation",
  "history",
  "task",
  "scout",
  "diagnosis",
  "research",
  "clarification",
  "design",
] as const;
export type JevEvidenceCategory = (typeof jevEvidenceCategories)[number];
export interface JevRuntimePolicy {
  maxRequests: number;
  grant: {
    id: string;
    policyVersion: string;
    active: boolean;
    projectRoot: string;
    destination: string;
    evidenceCategories: readonly JevEvidenceCategory[];
  };
}
export interface ClassifierIdentity {
  provider: string;
  model: string;
}
export const DEFAULT_JEV_CLASSIFIER: Readonly<ClassifierIdentity> = {
  provider: "typesafe",
  model: "jev-latest",
};
export const DEFAULT_JEV_DESTINATION = "typesafe/jev-latest";
export function jevDestination(value = DEFAULT_JEV_DESTINATION): string {
  if (
    !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_~./-]+$/u.test(value) ||
    value.includes("..")
  )
    throw new Error(
      "Jev destination must be a non-secret provider/model identity",
    );
  return value;
}
export function classifierIdentity(
  configuration?: JevConfiguration,
): ClassifierIdentity {
  const identity = configuration?.classifier ?? DEFAULT_JEV_CLASSIFIER;
  if (!isClassifierIdentity(identity))
    throw new Error("Invalid classifier identity");
  return { ...identity };
}
export function isClassifierIdentity(
  value: unknown,
): value is ClassifierIdentity {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["provider", "model"]) ||
    !isNonEmptyString(value.provider) ||
    !isNonEmptyString(value.model)
  )
    return false;
  try {
    return (
      !value.provider.includes("/") &&
      Boolean(jevDestination(`${value.provider}/${value.model}`))
    );
  } catch {
    return false;
  }
}
export function isJevRuntimePolicy(value: unknown): value is JevRuntimePolicy {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["maxRequests", "grant"]) ||
    !isNonNegativeInteger(value.maxRequests) ||
    !Number.isSafeInteger(value.maxRequests) ||
    !isRecord(value.grant)
  )
    return false;
  const grant = value.grant;
  return (
    hasOnlyKeys(grant, [
      "id",
      "policyVersion",
      "active",
      "projectRoot",
      "destination",
      "evidenceCategories",
    ]) &&
    [grant.id, grant.policyVersion, grant.projectRoot, grant.destination].every(
      isNonEmptyString,
    ) &&
    typeof grant.active === "boolean" &&
    isSafeJevDestination(grant.destination) &&
    Array.isArray(grant.evidenceCategories) &&
    grant.evidenceCategories.every(
      (item) =>
        typeof item === "string" &&
        jevEvidenceCategories.some((category) => category === item),
    )
  );
}
export interface JevConfiguration {
  runtimePolicy?: JevRuntimePolicy;
  /** Pi owns credentials and provider transport. */
  classifier?: ClassifierIdentity;
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

function isSafeJevDestination(value: unknown): boolean {
  try {
    return isNonEmptyString(value) && Boolean(jevDestination(value));
  } catch {
    return false;
  }
}
function isJevConfiguration(value: unknown): value is JevConfiguration {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "classifier",
      "timeoutMs",
      "maxTransportRetries",
      "runtimePolicy",
    ]) &&
    (!Object.hasOwn(value, "runtimePolicy") ||
      isJevRuntimePolicy(value.runtimePolicy)) &&
    (!Object.hasOwn(value, "classifier") ||
      isClassifierIdentity(value.classifier)) &&
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
      ...(configuration.jev.runtimePolicy
        ? { runtimePolicy: structuredClone(configuration.jev.runtimePolicy) }
        : {}),
      classifier: classifierIdentity(configuration.jev),
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
