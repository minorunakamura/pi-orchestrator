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
] as const;
export type JevEvidenceCategory = (typeof jevEvidenceCategories)[number];
export interface JevRuntimePolicy {
  maxRequests: number;
  consent: {
    id: string;
    policyVersion: string;
    active: boolean;
    workflowId: string;
    projectRoot: string;
    destination: string;
    evidenceCategories: readonly JevEvidenceCategory[];
  };
}
export const DEFAULT_JEV_DESTINATION = "https://api.typesafe.ai";
export function jevDestination(
  value: string = DEFAULT_JEV_DESTINATION,
): string {
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Jev destination must not contain credentials, query or fragment",
    );
  const destination = url.href.replace(/\/$/u, "");
  if (destination !== DEFAULT_JEV_DESTINATION)
    throw new Error("Direct Jev supports only the default TypeSafe backend");
  return destination;
}
export function isJevRuntimePolicy(value: unknown): value is JevRuntimePolicy {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["maxRequests", "consent"]) ||
    !isNonNegativeInteger(value.maxRequests) ||
    !isRecord(value.consent)
  )
    return false;
  const consent = value.consent;
  return (
    hasOnlyKeys(consent, [
      "id",
      "policyVersion",
      "active",
      "workflowId",
      "projectRoot",
      "destination",
      "evidenceCategories",
    ]) &&
    [
      consent.id,
      consent.policyVersion,
      consent.workflowId,
      consent.projectRoot,
      consent.destination,
    ].every(isNonEmptyString) &&
    typeof consent.active === "boolean" &&
    isSafeJevEndpoint(consent.destination) &&
    Array.isArray(consent.evidenceCategories) &&
    consent.evidenceCategories.every(
      (item) =>
        typeof item === "string" &&
        jevEvidenceCategories.some((category) => category === item),
    )
  );
}
export interface JevConfiguration {
  runtimePolicy?: JevRuntimePolicy;
  /** Transitional: only https://api.typesafe.ai is supported until #19. */
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

function isSafeJevEndpoint(value: unknown): boolean {
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
      "endpoint",
      "timeoutMs",
      "maxTransportRetries",
      "runtimePolicy",
    ]) &&
    (!Object.hasOwn(value, "runtimePolicy") ||
      isJevRuntimePolicy(value.runtimePolicy)) &&
    (!Object.hasOwn(value, "endpoint") || isSafeJevEndpoint(value.endpoint)) &&
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
