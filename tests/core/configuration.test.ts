import { expect, test } from "vitest";
import {
  DEFAULT_RETRY_LIMITS,
  isOrchestratorConfiguration,
  parseConfiguration,
  resolveExecutionProfile,
  serializeConfiguration,
  type OrchestratorConfiguration,
} from "../../src/core/configuration.ts";
import { SchemaValidationError } from "../../src/core/workflow/errors.ts";

function validConfiguration(): OrchestratorConfiguration {
  return {
    decision: {
      autoDecisionThreshold: 0.8,
      escalationThreshold: 0.5,
    },
    executionProfiles: {
      ECONOMY: { provider: "provider-a", model: "model-small" },
      STANDARD: { provider: "provider-a", model: "model-medium" },
      STRONG: { provider: "provider-b", model: "model-large" },
    },
    reasoningMapping: {
      LOW: "low",
      MEDIUM: "medium",
      HIGH: "high",
    },
    retries: {
      maxAutomatedFixRounds: 3,
      maxStrongerRetries: 1,
    },
    validation: {
      stopOnInfrastructureFailure: true,
    },
    jev: {
      endpoint: "https://api.typesafe.ai",
      timeoutMs: 30_000,
      maxTransportRetries: 1,
    },
  };
}

test("validates the v1 configuration and resolves logical tiers", () => {
  const configuration = parseConfiguration(validConfiguration());

  expect(isOrchestratorConfiguration(configuration)).toBe(true);
  expect(resolveExecutionProfile(configuration, "STANDARD", "HIGH")).toEqual({
    provider: "provider-a",
    model: "model-medium",
    thinking: "high",
  });
});

test.each([
  "https://jev.example.test",
  "https://api.typesafe.ai/custom",
  "http://api.typesafe.ai",
])("rejects unsupported direct-Jev endpoint configuration: %s", (endpoint) => {
  const configuration = validConfiguration();
  expect(() =>
    parseConfiguration({ ...configuration, jev: { endpoint } }),
  ).toThrow(SchemaValidationError);
});

test("rejects invalid retry limits and missing execution profile mappings", () => {
  const configuration = validConfiguration();

  expect(() =>
    parseConfiguration({
      ...configuration,
      retries: { ...configuration.retries, maxAutomatedFixRounds: 0 },
    }),
  ).toThrow(SchemaValidationError);
  expect(() =>
    parseConfiguration({
      ...configuration,
      retries: { ...configuration.retries, maxStrongerRetries: 1.5 },
    }),
  ).toThrow(SchemaValidationError);
  expect(() =>
    parseConfiguration({
      ...configuration,
      executionProfiles: {
        ECONOMY: configuration.executionProfiles.ECONOMY,
        STANDARD: configuration.executionProfiles.STANDARD,
      },
    }),
  ).toThrow(SchemaValidationError);
});

test("does not expose configuration switches for safety invariants or Human Gates", () => {
  const configuration = validConfiguration();

  expect(() =>
    parseConfiguration({
      ...configuration,
      humanGates: { plan: false, code: false },
    }),
  ).toThrow(SchemaValidationError);
  expect(() =>
    parseConfiguration({
      ...configuration,
      safety: { allowValidationBypass: true },
    }),
  ).toThrow(SchemaValidationError);
  expect(() =>
    parseConfiguration({
      ...configuration,
      validation: {
        ...configuration.validation,
        allowHumanGateBypass: true,
      },
    }),
  ).toThrow(SchemaValidationError);
});

test("keeps secrets out of the durable configuration snapshot", () => {
  const configuration = validConfiguration();
  const snapshot = serializeConfiguration(configuration);

  expect(snapshot).not.toContain("apiKey");
  expect(snapshot).not.toContain("secret");
  expect(JSON.parse(snapshot)).toEqual(configuration);
  expect(DEFAULT_RETRY_LIMITS).toEqual({
    maxAutomatedFixRounds: 3,
    maxStrongerRetries: 1,
  });
});

test("does not copy runtime-only profile properties into a snapshot", () => {
  const configuration = validConfiguration();
  Object.assign(configuration.executionProfiles.ECONOMY, {
    apiKey: "runtime-only-secret",
  });

  const snapshot = serializeConfiguration(configuration);

  expect(snapshot).not.toContain("runtime-only-secret");
  expect(JSON.parse(snapshot).executionProfiles.ECONOMY).toEqual({
    provider: "provider-a",
    model: "model-small",
  });
});
