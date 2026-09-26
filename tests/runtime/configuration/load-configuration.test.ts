import { expect, test } from "vitest";
import { loadConfiguration } from "../../../src/runtime/configuration/load-configuration.ts";

const settings = {
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
  validation: {
    stopOnInfrastructureFailure: true,
  },
  jev: {
    endpoint: "https://jev.example.test",
    apiKey: "do-not-persist",
  },
};

test("loads safe defaults and removes runtime secrets from domain configuration", () => {
  const configuration = loadConfiguration(settings);

  expect(configuration.retries).toEqual({
    maxAutomatedFixRounds: 3,
    maxStrongerRetries: 1,
  });
  expect(configuration.jev).toEqual({
    endpoint: "https://jev.example.test",
  });
  expect(JSON.stringify(configuration)).not.toContain("do-not-persist");
});

test("rejects v1.1 routing settings instead of accepting placeholders", () => {
  expect(() =>
    loadConfiguration({
      ...settings,
      contextRouting: { enabled: true },
    }),
  ).toThrow();
});
