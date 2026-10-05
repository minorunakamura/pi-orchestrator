import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  loadConfiguration,
  loadProductionConfiguration,
} from "../../../src/runtime/configuration/load-configuration.ts";
import { resolveStageProfile } from "../../../src/core/configuration.ts";

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
    classifier: { provider: "typesafe", model: "jev-latest" },
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
    classifier: { provider: "typesafe", model: "jev-latest" },
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

test("loads the production configuration through Pi global then project settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-orchestrator-config-"));
  const agentDir = join(root, "agent");
  try {
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        piOrchestrator: {
          ...settings,
          stageProfiles: {
            scout: { modelTier: "STANDARD", reasoningTier: "MEDIUM" },
            diagnosis: { modelTier: "STRONG", reasoningTier: "HIGH" },
          },
        },
      }),
    );
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(
      join(root, ".pi", "settings.json"),
      JSON.stringify({
        piOrchestrator: {
          executionProfiles: {
            STANDARD: { model: "project-model" },
          },
          stageProfiles: { scout: { reasoningTier: "LOW" } },
        },
      }),
    );

    const configuration = loadProductionConfiguration(root, {
      agentDir,
      projectTrusted: true,
    });

    expect(configuration.executionProfiles.STANDARD).toEqual({
      provider: "provider-a",
      model: "project-model",
    });
    expect(configuration.executionProfiles.ECONOMY).toEqual(
      settings.executionProfiles.ECONOMY,
    );
    expect(resolveStageProfile(configuration, "scout")).toEqual({
      provider: "provider-a",
      model: "project-model",
      thinking: "low",
    });
    expect(resolveStageProfile(configuration, "diagnosis")).toEqual({
      provider: "provider-b",
      model: "model-large",
      thinking: "high",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("untrusted project settings cannot supply classifier grants", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-orchestrator-grant-trust-"));
  const agentDir = join(root, "agent");
  try {
    await mkdir(agentDir);
    await mkdir(join(root, ".pi"));
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ piOrchestrator: settings }),
    );
    await writeFile(
      join(root, ".pi", "settings.json"),
      JSON.stringify({
        piOrchestrator: {
          jev: {
            runtimePolicy: {
              maxRequests: 1,
              grant: {
                id: "project-grant",
                policyVersion: "1",
                active: true,
                projectRoot: root,
                destination: "typesafe/jev-latest",
                evidenceCategories: ["task"],
              },
            },
          },
        },
      }),
    );
    expect(
      loadProductionConfiguration(root, { agentDir, projectTrusted: false }).jev
        .runtimePolicy,
    ).toBeUndefined();
    expect(
      loadProductionConfiguration(root, { agentDir, projectTrusted: true }).jev
        .runtimePolicy?.grant.id,
    ).toBe("project-grant");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed when production configuration is missing or invalid", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-orchestrator-config-"));
  const agentDir = join(root, "agent");
  try {
    await mkdir(agentDir, { recursive: true });
    expect(() =>
      loadProductionConfiguration(root, { agentDir, projectTrusted: true }),
    ).toThrow();

    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ piOrchestrator: { contextRouting: { enabled: true } } }),
    );
    expect(() =>
      loadProductionConfiguration(root, { agentDir, projectTrusted: true }),
    ).toThrow();

    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ piOrchestrator: settings }),
    );
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(
      join(root, ".pi", "settings.json"),
      JSON.stringify({ piOrchestrator: null }),
    );
    expect(() =>
      loadProductionConfiguration(root, { agentDir, projectTrusted: true }),
    ).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
