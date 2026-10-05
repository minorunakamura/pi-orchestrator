import { expect, test } from "vitest";
import {
  DEFAULT_RETRY_LIMITS,
  defaultStageProfiles,
  resolveStageProfile,
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
      classifier: { provider: "typesafe", model: "jev-latest" },
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
  "scout",
  "diagnosis",
  "research",
  "planning",
  "plan-simplicity",
  "correctness-review",
  "ponytail-review",
  "oracle",
] as const)(
  "%s resolves its default tiers through the existing mappings",
  (stage) => {
    const configuration = validConfiguration();
    const { modelTier, reasoningTier } = defaultStageProfiles[stage];
    expect(resolveStageProfile(configuration, stage)).toEqual(
      resolveExecutionProfile(configuration, modelTier, reasoningTier),
    );
  },
);

test("partial stage overrides preserve other defaults and safe serialization", () => {
  const configuration = parseConfiguration({
    ...validConfiguration(),
    stageProfiles: { scout: { modelTier: "STRONG", reasoningTier: "MEDIUM" } },
  });
  expect(resolveStageProfile(configuration, "scout")).toEqual({
    provider: "provider-b",
    model: "model-large",
    thinking: "medium",
  });
  expect(resolveStageProfile(configuration, "diagnosis")).toEqual({
    provider: "provider-a",
    model: "model-medium",
    thinking: "high",
  });
  expect(JSON.parse(serializeConfiguration(configuration))).toEqual(
    configuration,
  );
  Object.assign(configuration.stageProfiles!.scout!, {
    apiKey: "runtime-secret",
  });
  expect(serializeConfiguration(configuration)).not.toContain("runtime-secret");
});

test.each([
  null,
  [],
  { worker: { modelTier: "STANDARD", reasoningTier: "HIGH" } },
  { scout: {} },
  { scout: { modelTier: "ECONOMY" } },
  { scout: { modelTier: "UNKNOWN", reasoningTier: "LOW" } },
  { scout: { modelTier: "ECONOMY", reasoningTier: "max" } },
  { scout: { modelTier: "ECONOMY", reasoningTier: "LOW", thinking: "low" } },
])("rejects malformed or unknown stage profiles: %j", (stageProfiles) => {
  expect(() =>
    parseConfiguration({ ...validConfiguration(), stageProfiles }),
  ).toThrow(SchemaValidationError);
});

test.each([
  "https://jev.example.test",
  "https://api.typesafe.ai/custom",
  "http://api.typesafe.ai",
])("rejects obsolete direct-Jev endpoint configuration: %s", (endpoint) => {
  const configuration = validConfiguration();
  expect(() =>
    parseConfiguration({ ...configuration, jev: { endpoint } }),
  ).toThrow(SchemaValidationError);
});

test.each([
  { provider: "https://api.typesafe.ai", model: "jev-latest" },
  { provider: "typesafe", model: "jev-latest?secret=value" },
  { provider: "typesafe", model: "" },
  { provider: "typesafe", model: "../other" },
])("rejects invalid native classifier identity: %j", (classifier) => {
  expect(() =>
    parseConfiguration({ ...validConfiguration(), jev: { classifier } }),
  ).toThrow(SchemaValidationError);
});

test("operator grant is configurable without a future workflow ID; legacy consent is rejected", () => {
  const configuration = validConfiguration();
  const runtimePolicy = {
    maxRequests: 10,
    grant: {
      id: "operator-grant",
      policyVersion: "1",
      active: true,
      projectRoot: "/project",
      destination: "typesafe/jev-latest",
      evidenceCategories: ["task"],
    },
  };
  expect(
    parseConfiguration({ ...configuration, jev: { runtimePolicy } }).jev
      .runtimePolicy,
  ).toEqual(runtimePolicy);
  expect(() =>
    parseConfiguration({
      ...configuration,
      jev: {
        runtimePolicy: {
          maxRequests: 10,
          consent: { ...runtimePolicy.grant, workflowId: "old-id" },
        },
      },
    }),
  ).toThrow(SchemaValidationError);
  expect(() =>
    parseConfiguration({
      ...configuration,
      jev: {
        runtimePolicy: {
          ...runtimePolicy,
          grant: { ...runtimePolicy.grant, workflowId: "*" },
        },
      },
    }),
  ).toThrow(SchemaValidationError);
  for (const maxRequests of [
    Infinity,
    NaN,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    expect(() =>
      parseConfiguration({
        ...configuration,
        jev: { runtimePolicy: { ...runtimePolicy, maxRequests } },
      }),
    ).toThrow(SchemaValidationError);
  expect(() =>
    parseConfiguration({
      ...configuration,
      jev: {
        runtimePolicy: {
          ...runtimePolicy,
          grant: { ...runtimePolicy.grant, evidenceCategories: ["*"] },
        },
      },
    }),
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
