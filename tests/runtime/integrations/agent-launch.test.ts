import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { registerSubagentCapabilityCeiling } from "pi-subagents/capability-ceiling";
import {
  agentLaunchPolicy,
  parseAgentLaunchEvidence,
} from "../../../src/core/agent-launch.ts";
import { SubagentsIntegration } from "../../../src/runtime/integrations/subagents.ts";
import { ArtifactStore } from "../../../src/runtime/persistence/artifact-store.ts";
import type { AgentRunRequest } from "../../../src/runtime/ports/subagent-executor.ts";
import type { AgentLaunchHost } from "../../../src/runtime/integrations/subagent-launch.ts";
import { FakeSubagentRpc, childRequest } from "../../fakes/subagent-rpc.ts";
import { configuration as baseConfiguration } from "../../fakes/coding-scenario.ts";
import { fakeLaunchResolver } from "../../fakes/agent-launch.ts";
import {
  resolveStageProfile,
  type OrchestratorConfiguration,
} from "../../../src/core/configuration.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "issue21-launch-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(join(agentDir, "agents"), { recursive: true });
  await mkdir(cwd);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      subagents: {
        defaultModel: "test/model",
        defaultThinking: "off",
        intercomBridge: { mode: "off" },
      },
    }),
  );
  const definition = join(agentDir, "agents/workflow-scout.md");
  await writeFile(
    definition,
    `---\nname: workflow-scout\ndescription: Launch probe\nmodel: test/model\nthinking: off\ntools: read, write, bash\ninheritSkills: false\ninheritProjectContext: true\n---\nEvidence only.\n`,
  );
  const host: AgentLaunchHost = {
    sessionId: root,
    projectTrusted: false,
    availableModels: [
      {
        provider: "test",
        id: "model",
        api: "openai-completions",
        reasoning: false,
      },
      {
        provider: "test",
        id: "other",
        api: "openai-completions",
        reasoning: true,
      },
    ],
  };
  const events = new FakeSubagentRpc();
  const store = new ArtifactStore(join(root, "artifacts"));
  await store.writeText("task", "task.md", "safe input");
  const adapter = new SubagentsIntegration(events, {
    cwd,
    launchHost: host,
    artifactReader: store,
  });
  const request: AgentRunRequest = {
    agent: "workflow-scout",
    task: "secret prompt never saved",
    cwd,
    launchPolicy: agentLaunchPolicy("workflow-scout"),
    dispatch: {
      requestId: "request-1",
      ownerRunId: "workflow",
      nodeId: "scout",
      deadline: new Date(Date.now() + 60_000).toISOString(),
    },
    onStarted: async () => {},
  };
  return { root, definition, host, events, store, adapter, request };
}

test("production preflight uses the loaded extension's public API instead of the dependency copy", async () => {
  const f = await fixture();
  const owner = join(f.root, "installed-owner");
  await mkdir(owner);
  await writeFile(
    join(owner, "package.json"),
    JSON.stringify({
      name: "pi-subagents",
      version: "0.74.0",
      type: "module",
      exports: { "./preflight": "./preflight.js" },
    }),
  );
  await writeFile(join(owner, "index.js"), "export default function () {}\n");
  await writeFile(
    join(owner, "preflight.js"),
    `export async function resolveSubagentLaunchContract(input) {
    if (input.capabilityCeiling?.denyExtensions !== true || input.model !== 'test/model:off') throw Error('Lost policy binding');
    return { ok: false, code: 'invalid_cwd', message: 'Loaded-owner probe' };
  }`,
  );
  f.request.executionProfile = {
    provider: "test",
    model: "model",
    thinking: "off",
  };
  f.request.launchPolicy = agentLaunchPolicy(
    "workflow-scout",
    f.request.executionProfile,
  );
  f.host.runtimeSnapshotHost = {
    events: f.events,
    getAllTools: () => [
      {
        name: "subagents_enable",
        sourceInfo: { path: join(owner, "index.js"), baseDir: owner },
      },
    ],
  };
  await expect(
    f.adapter.run({ ...f.request, onPrepared: async () => {} }),
  ).rejects.toMatchObject({ diagnosticCode: "invalid_cwd" });
  expect(f.events.emitted).toHaveLength(0);
});

test("Pi source metadata binds both public preflight resolutions to the loaded owner", async () => {
  const f = await fixture();
  const sourceInfo = {
    path: fileURLToPath(import.meta.resolve("pi-subagents")),
    baseDir: dirname(fileURLToPath(import.meta.resolve("pi-subagents"))),
  };
  f.host.runtimeSnapshotHost = {
    events: f.events,
    getAllTools: () =>
      ["subagent", "subagents_enable"].map((name) => ({ name, sourceInfo })),
  };
  const launch = await f.adapter.preflight(f.request);
  expect(launch).toMatchObject({
    tools: ["read"],
    policy: { denyExtensions: true },
  });
  expect(launch).toEqual(
    await new SubagentsIntegration(f.events, {
      cwd: f.request.cwd,
      artifactReader: f.store,
      launchHost: { ...f.host, runtimeSnapshotHost: undefined },
    }).preflight(f.request),
  );
  expect(f.events.emitted).toHaveLength(0);
});

test.each(["missing", "synthetic", "conflicting", "missing-export"])(
  "unverifiable loaded owner (%s) never falls back to the dependency copy",
  async (scenario) => {
    const f = await fixture();
    const sourceInfo = {
      path: fileURLToPath(import.meta.resolve("pi-subagents")),
      baseDir: dirname(fileURLToPath(import.meta.resolve("pi-subagents"))),
    };
    const missing = join(f.root, "missing-export");
    if (scenario === "missing-export") {
      await mkdir(missing);
      await writeFile(
        join(missing, "package.json"),
        JSON.stringify({
          name: "pi-subagents",
          version: "0.74.0",
          exports: {},
        }),
      );
    }
    f.host.runtimeSnapshotHost = {
      events: f.events,
      getAllTools: () =>
        scenario === "missing"
          ? []
          : [
              {
                name: "subagent",
                sourceInfo:
                  scenario === "synthetic"
                    ? { path: "<inline:owner>", baseDir: sourceInfo.baseDir }
                    : scenario === "missing-export"
                      ? { path: join(missing, "index.js"), baseDir: missing }
                      : sourceInfo,
              },
              ...(scenario === "conflicting"
                ? [
                    {
                      name: "subagents_enable",
                      sourceInfo: {
                        path: join(f.root, "other/index.js"),
                        baseDir: join(f.root, "other"),
                      },
                    },
                  ]
                : []),
            ],
    };
    await expect(
      f.adapter.run({ ...f.request, onPrepared: async () => {} }),
    ).rejects.toMatchObject({ name: "SubagentNotDispatchedError" });
    expect(f.events.emitted).toHaveLength(0);
  },
);

test.each([
  ["scout", "workflow-scout"],
  ["diagnosis", "workflow-scout"],
  ["research", "pi-ketch.researcher"],
  ["planning", "planner"],
  ["plan-simplicity", "plan-simplicity-reviewer"],
  ["correctness-review", "reviewer"],
  ["ponytail-review", "ponytail-reviewer"],
  ["oracle", "oracle"],
] as const)(
  "%s applies the configured stage policy without weakening the role ceiling",
  async (stage, agent) => {
    const f = await fixture();
    const resolver = vi.fn(fakeLaunchResolver);
    const adapter = new SubagentsIntegration(f.events, {
      cwd: f.root,
      artifactReader: f.store,
      configuration: baseConfiguration,
      launchResolver: resolver,
    });
    const policy = agentLaunchPolicy(agent);
    const request = {
      ...f.request,
      agent,
      profileStage: stage,
      launchPolicy: policy,
    };
    const launch = await adapter.preflight(request);
    expect(launch.policy).toEqual({
      ...policy,
      executionProfile: resolveStageProfile(baseConfiguration, stage),
    });
    expect(resolver.mock.calls[0][0].executionProfile).toEqual(
      launch.policy.executionProfile,
    );
    expect(f.events.emitted).toHaveLength(0);
  },
);

async function stageFixture() {
  const f = await fixture();
  f.host.availableModels = f.host.availableModels.map((model) => ({
    ...model,
    reasoning: true,
  }));
  // Reproduce the product Scout: neither definition nor subagents.defaultThinking pins thinking.
  await writeFile(
    f.definition,
    `---\nname: workflow-scout\ndescription: Stage profile probe\ntools: read\ninheritSkills: false\ninheritProjectContext: true\n---\nEvidence only.\n`,
  );
  await writeFile(
    join(f.root, "agent/settings.json"),
    JSON.stringify({ subagents: { defaultModel: "test/other" } }),
  );
  const configuration: OrchestratorConfiguration = {
    ...structuredClone(baseConfiguration),
    executionProfiles: {
      ECONOMY: { provider: "test", model: "model" },
      STANDARD: { provider: "test", model: "other" },
      STRONG: { provider: "test", model: "other" },
    },
  };
  const adapter = (config = configuration) =>
    new SubagentsIntegration(f.events, {
      cwd: f.root,
      artifactReader: f.store,
      launchHost: f.host,
      configuration: config,
    });
  const request = { ...f.request, profileStage: "scout" as const };
  return { ...f, configuration, adapter, request };
}

test("released preflight resolves Scout and Diagnosis independently without ambient thinking defaults", async () => {
  const f = await stageFixture();
  expect(await f.adapter().preflight(f.request)).toMatchObject({
    model: "test/model",
    thinking: "low",
  });
  expect(
    await f.adapter().preflight({ ...f.request, profileStage: "diagnosis" }),
  ).toMatchObject({ model: "test/other", thinking: "high" });
  f.configuration.stageProfiles = {
    scout: { modelTier: "STRONG", reasoningTier: "MEDIUM" },
  };
  const launch = await f.adapter().preflight(f.request);
  expect(launch).toMatchObject({ model: "test/other", thinking: "medium" });
  const prepared = vi.fn(async () => {});
  await f.adapter().run({ ...f.request, launch, onPrepared: prepared });
  expect(prepared).toHaveBeenCalledWith(launch);
  expect(childRequest(f.events.emitted[0].payload)).toMatchObject({
    model: "test/other:medium",
  });
});

test.each(["stage-override", "model-mapping", "reasoning-mapping"])(
  "%s drift cannot replace a historical stage launch",
  async (dimension) => {
    const f = await stageFixture();
    const launch = await f.adapter().preflight(f.request);
    if (dimension === "stage-override")
      f.configuration.stageProfiles = {
        scout: { modelTier: "STANDARD", reasoningTier: "HIGH" },
      };
    if (dimension === "model-mapping")
      f.configuration.executionProfiles.ECONOMY.model = "other";
    if (dimension === "reasoning-mapping")
      f.configuration.reasoningMapping.LOW = "medium";
    const prepared = vi.fn(async () => {});
    await expect(
      f.adapter().run({ ...f.request, launch, onPrepared: prepared }),
    ).rejects.toThrow("changed after durable preflight");
    expect(prepared).not.toHaveBeenCalled();
    expect(f.events.emitted).toHaveLength(0);
  },
);

test("configured stage failures never fall back to an ambient model", async () => {
  const f = await stageFixture();
  f.configuration.executionProfiles.ECONOMY.model = "missing-model";
  await expect(
    f.adapter().run({ ...f.request, onPrepared: async () => {} }),
  ).rejects.toMatchObject({ name: "SubagentNotDispatchedError" });
  expect(f.events.emitted).toHaveLength(0);
});

test.each([undefined, "research"] as const)(
  "missing or mismatched stage %s is rejected before resolution",
  async (profileStage) => {
    const f = await stageFixture();
    await expect(
      f
        .adapter()
        .run({ ...f.request, profileStage, onPrepared: async () => {} }),
    ).rejects.toMatchObject({ diagnosticCode: "invalid-launch-policy" });
    expect(f.events.emitted).toHaveLength(0);
  },
);

test("stage defaults and overrides never replace a Worker's routed profile", async () => {
  const f = await stageFixture();
  const executionProfile = {
    provider: "test",
    model: "model",
    thinking: "off",
  };
  const launch = await f.adapter().preflight({
    ...f.request,
    agent: "worker",
    executionProfile,
    launchPolicy: agentLaunchPolicy("worker", executionProfile),
  });
  expect(launch.policy.executionProfile).toEqual(executionProfile);
  expect(launch).toMatchObject({ model: "test/model", thinking: "off" });
});

test("released preflight proves a read-only ceiling, physical identity and bounded secret-free projection", async () => {
  const f = await fixture();
  const launch = await f.adapter.preflight(f.request);
  expect(launch).toMatchObject({
    source: "user",
    model: "test/model",
    thinking: "off",
    tools: ["read"],
    inheritSkills: false,
    packageVersion: "0.74.0",
  });
  expect(JSON.stringify(launch)).not.toContain(f.request.task);
  expect(JSON.stringify(launch)).not.toContain(f.root);
  expect(parseAgentLaunchEvidence(launch)).toEqual(launch);
  expect(f.events.emitted).toHaveLength(0);
});

test("released preflight rejection exposes only its stable reason code", async () => {
  const f = await fixture();
  await rm(f.definition);
  await expect(f.adapter.run(f.request)).rejects.toMatchObject({
    name: "SubagentNotDispatchedError",
    diagnosticCode: "missing_agent",
  });
  expect(f.events.emitted).toHaveLength(0);
});

test("failed persistence creates zero child side effects", async () => {
  const f = await fixture();
  await expect(
    f.adapter.run({
      ...f.request,
      onPrepared: async () => {
        throw Error("save failed");
      },
    }),
  ).rejects.toThrow("persist launch");
  expect(f.events.emitted).toHaveLength(0);
});

test.each(["model", "thinking", "definition", "skills", "tools"])(
  "%s drift cannot reuse a persisted launch",
  async (dimension) => {
    const f = await fixture();
    const launch = await f.adapter.preflight(f.request);
    const request = { ...f.request, launch, onPrepared: async () => {} };
    if (dimension === "model" || dimension === "thinking") {
      request.executionProfile = {
        provider: "test",
        model: dimension === "model" ? "other" : "model",
        thinking: dimension === "thinking" ? "high" : "off",
      };
      request.launchPolicy = agentLaunchPolicy(
        "workflow-scout",
        request.executionProfile,
      );
    } else if (dimension === "definition") {
      await writeFile(
        f.definition,
        `---\nname: workflow-scout\ndescription: Launch probe\nmodel: test/model\nthinking: off\ntools: read\ninheritSkills: false\ninheritProjectContext: true\n---\nDifferent instructions.\n`,
      );
    } else if (dimension === "skills") {
      request.launchPolicy = agentLaunchPolicy("workflow-scout", undefined, [
        "missing-tdd",
      ]);
    } else {
      request.launchPolicy = {
        ...launch.policy,
        requiredTools: ["grep"],
      };
    }
    await expect(f.adapter.run(request)).rejects.toMatchObject({
      name: "SubagentNotDispatchedError",
    });
    expect(f.events.emitted).toHaveLength(0);
  },
);

test("actual receipt mismatch is ambiguous, never successful or safe-to-retry", async () => {
  const f = await fixture();
  let prepared = false,
    started = false;
  const result = await f.adapter.run({
    ...f.request,
    onPrepared: async () => {
      prepared = true;
    },
    onStarted: async () => {
      started = true;
    },
  });
  expect(prepared).toBe(true);
  expect(started).toBe(true);
  expect(result.status).toBe("ambiguous");
  const params = childRequest(f.events.emitted[0].payload);
  expect(params).toMatchObject({
    model: "test/model:off",
    reads: false,
    progress: false,
    intercomBridge: { mode: "off" },
  });
});

test("Worker explicitly requests TDD, while Oracle must be builtin and advisory/read-only", async () => {
  const f = await fixture();
  const worker = agentLaunchPolicy(
    "worker",
    { provider: "test", model: "model", thinking: "off" },
    ["tdd"],
  );
  await mkdir(join(f.root, "agent/skills/tdd"), { recursive: true });
  await writeFile(
    join(f.root, "agent/skills/tdd/SKILL.md"),
    "---\nname: tdd\ndescription: Test skill\n---\nRED then GREEN\n",
  );
  await expect(
    f.adapter.preflight({
      ...f.request,
      agent: "worker",
      launchPolicy: { ...worker, skills: ["missing-tdd"] },
      executionProfile: worker.executionProfile,
    }),
  ).rejects.toMatchObject({ name: "SubagentNotDispatchedError" });
  const tdd = await f.adapter.preflight({
    ...f.request,
    agent: "worker",
    launchPolicy: worker,
    executionProfile: worker.executionProfile,
  });
  expect(tdd).toMatchObject({
    source: "builtin",
    requestedSkills: ["tdd"],
    inheritSkills: false,
    skills: [{ name: "tdd" }],
  });
  await writeFile(
    join(f.root, "agent/skills/tdd/SKILL.md"),
    "---\nname: tdd\ndescription: Changed skill\n---\nChanged instructions\n",
  );
  await expect(
    f.adapter.run({
      ...f.request,
      agent: "worker",
      launchPolicy: worker,
      executionProfile: worker.executionProfile,
      launch: tdd,
      onPrepared: async () => {},
    }),
  ).rejects.toThrow("changed after durable preflight");
  expect(f.events.emitted).toHaveLength(0);
  const oraclePolicy = agentLaunchPolicy("oracle", worker.executionProfile);
  const oracle = await f.adapter.preflight({
    ...f.request,
    agent: "oracle",
    launchPolicy: oraclePolicy,
    executionProfile: worker.executionProfile,
  });
  expect(oracle).toMatchObject({
    source: "builtin",
    policy: { authorityRole: "advisory", context: "fresh" },
  });
  expect(oracle.tools).not.toContain("bash");
  await writeFile(
    join(f.root, "agent/agents/oracle.md"),
    `---\nname: oracle\ndescription: Shadow probe\nmodel: test/model\nthinking: off\ntools: read\ninheritSkills: false\ninheritProjectContext: true\n---\nShadowed Oracle\n`,
  );
  await expect(
    f.adapter.preflight({
      ...f.request,
      agent: "oracle",
      launchPolicy: agentLaunchPolicy("oracle"),
    }),
  ).rejects.toMatchObject({ name: "SubagentNotDispatchedError" });
  expect(agentLaunchPolicy("oracle").authorityRole).toBe("advisory");
  expect(agentLaunchPolicy("oracle").forbiddenTools).toContain("bash");
});

test("released Worker skill selection isolates STANDARD and explicitly resolves optional codebase-design", async () => {
  const f = await fixture();
  await Promise.all(
    ["tdd", "codebase-design"].map(async (name) => {
      await mkdir(join(f.root, "agent/skills", name), { recursive: true });
      await writeFile(
        join(f.root, "agent/skills", name, "SKILL.md"),
        `---\nname: ${name}\ndescription: Skill selection contract probe\n---\n${name}\n`,
      );
    }),
  );
  const profile = { provider: "test", model: "model", thinking: "off" };
  const standard = {
    ...f.request,
    agent: "worker",
    executionProfile: profile,
    launchPolicy: agentLaunchPolicy("worker", profile),
  };
  const launch = await f.adapter.preflight(standard);
  expect(launch.skills).toEqual([]);
  expect(launch.requestedSkills).toEqual([]);
  expect(launch.inheritSkills).toBe(false);
  const tdd = {
    ...standard,
    launchPolicy: agentLaunchPolicy("worker", profile, [
      "tdd",
      "codebase-design",
    ]),
  };
  expect(
    (await f.adapter.preflight(tdd)).skills.map((skill) => skill.name),
  ).toEqual(["codebase-design", "tdd"]);
  await rm(join(f.root, "agent/skills/codebase-design"), { recursive: true });
  await expect(
    f.adapter.run({ ...tdd, onPrepared: async () => {} }),
  ).rejects.toMatchObject({ name: "SubagentNotDispatchedError" });
  expect(f.events.emitted).toHaveLength(0);
});

test("definition drift while saving launch evidence still starts zero children", async () => {
  const f = await fixture();
  await expect(
    f.adapter.run({
      ...f.request,
      onPrepared: async () => {
        await writeFile(
          f.definition,
          `---\nname: workflow-scout\ndescription: Changed\nmodel: test/model\nthinking: off\ntools: read\ninheritSkills: false\ninheritProjectContext: true\n---\nChanged after durable intent\n`,
        );
      },
    }),
  ).rejects.toThrow("Launch drift");
  expect(f.events.emitted).toHaveLength(0);
});

test("missing physical model fails before dispatch", async () => {
  const f = await fixture();
  f.host.availableModels = [
    { provider: "other", id: "unknown", api: "openai-completions" },
  ];
  await expect(
    f.adapter.run({ ...f.request, onPrepared: async () => {} }),
  ).rejects.toMatchObject({ name: "SubagentNotDispatchedError" });
  expect(f.events.emitted).toHaveLength(0);
});

async function codemodeFixture(tools = "read, codemode, write, edit, bash") {
  const f = await fixture();
  await writeFile(
    f.definition,
    `---\nname: workflow-scout\ndescription: Codemode contract probe\nmodel: test/model\nthinking: off\ntools: ${tools}\nextensions:\ninheritSkills: false\ninheritProjectContext: true\n---\nRead-only evidence.\n`,
  );
  const base = agentLaunchPolicy("workflow-scout");
  f.request.launchPolicy = {
    ...base,
    requiredTools: ["read", "codemode"],
    allowedTools: [...base.allowedTools, "codemode"],
    forbiddenTools: base.forbiddenTools.filter((tool) => tool !== "codemode"),
    denyExtensions: false,
  };
  return f;
}

test("public Codemode inspection resolves the read-only ceiling without output preparation or dispatch", async () => {
  const f = await codemodeFixture();
  const launch = await f.adapter.preflight(f.request);
  expect(launch.tools).toEqual(["codemode", "read"]);
  expect(launch.policy.requiredTools).toContain("codemode");
  expect(parseAgentLaunchEvidence(launch)).toEqual(launch);
  expect(JSON.stringify(launch)).not.toContain(f.root);
  expect(f.events.emitted).toHaveLength(0);
  expect(await readdir(f.store.rootDirectory)).toEqual(["context"]);
});

test.each([
  "missing-codemode",
  "missing-read",
  "mutation",
  "extensions-denied",
])("Codemode inspection rejects %s capability", async (scenario) => {
  const f = await codemodeFixture(
    scenario === "missing-codemode"
      ? "read"
      : scenario === "missing-read"
        ? "codemode"
        : undefined,
  );
  const policy = f.request.launchPolicy!;
  if (scenario === "mutation")
    f.request.launchPolicy = {
      ...policy,
      allowedTools: [...policy.allowedTools, "write"],
      forbiddenTools: policy.forbiddenTools.filter((tool) => tool !== "write"),
    };
  if (scenario === "extensions-denied")
    f.request.launchPolicy = { ...policy, denyExtensions: true };
  await expect(f.adapter.preflight(f.request)).rejects.toMatchObject({
    name: "SubagentNotDispatchedError",
  });
  expect(f.events.emitted).toHaveLength(0);
});

test("inherited extension denial prevents Codemode availability proof", async () => {
  const f = await codemodeFixture();
  const restriction = registerSubagentCapabilityCeiling({
    sessionId: f.host.sessionId,
    source: "other-owner",
    ceiling: { denyExtensions: true },
  });
  try {
    await expect(f.adapter.preflight(f.request)).rejects.toMatchObject({
      name: "SubagentNotDispatchedError",
    });
    expect(f.events.emitted).toHaveLength(0);
  } finally {
    restriction.dispose();
  }
});

test("successful Codemode inspection is not permission to dispatch an unverified runtime", async () => {
  const f = await codemodeFixture();
  const launch = await f.adapter.preflight(f.request);
  const onPrepared = vi.fn(async () => {});
  const onStarted = vi.fn(async () => {});
  await expect(
    f.adapter.run({ ...f.request, launch, onPrepared, onStarted }),
  ).rejects.toThrow(/runtime isolation/iu);
  expect(onPrepared).not.toHaveBeenCalled();
  expect(onStarted).not.toHaveBeenCalled();
  expect(f.events.emitted).toHaveLength(0);
  expect(await readdir(f.store.rootDirectory)).toEqual(["context"]);
});

async function adoptedCodemodeFixture(
  extensionLine = `subagentOnlyExtensions: ${resolve("src/runtime/integrations/readonly-codemode.ts")}`,
  ambient = false,
) {
  const f = await fixture();
  await writeFile(
    join(f.root, "agent/agents/plan-simplicity-reviewer.md"),
    `---\nname: plan-simplicity-reviewer\ndescription: Adopted Codemode probe\nmodel: test/model\nthinking: off\ntools: read, codemode, edit, write, bash\n${ambient ? "" : "extensions:\n"}${extensionLine}\ninheritSkills: false\ninheritProjectContext: true\n---\nRead-only findings.\n`,
  );
  f.request.agent = "plan-simplicity-reviewer";
  f.request.launchPolicy = agentLaunchPolicy("plan-simplicity-reviewer");
  return f;
}

test("adopted Codemode goes through common durable launch and finite child/tool RPC bounds", async () => {
  const f = await adoptedCodemodeFixture();
  const launch = await f.adapter.preflight(f.request);
  expect(launch.tools).toEqual(["codemode", "read"]);
  const onPrepared = vi.fn(async () => {});
  await f.adapter.run({ ...f.request, launch, onPrepared });
  expect(onPrepared).toHaveBeenCalledWith(launch);
  expect(childRequest(f.events.emitted[0].payload)).toMatchObject({
    agent: "plan-simplicity-reviewer",
    toolTimeoutMs: 30000,
    reads: false,
    progress: false,
  });
});

test.each(["missing", "ambient", "extra", "wrong"])(
  "adopted Codemode %s replacement is rejected before persistence/dispatch",
  async (scenario) => {
    const path = resolve("src/runtime/integrations/readonly-codemode.ts");
    const f = await adoptedCodemodeFixture(
      scenario === "missing"
        ? ""
        : scenario === "wrong"
          ? `subagentOnlyExtensions: ${resolve("tests/platform/probe-provider.ts")}`
          : `subagentOnlyExtensions: ${path}${scenario === "extra" ? `, ${resolve("tests/platform/probe-provider.ts")}` : ""}`,
      scenario === "ambient",
    );
    await expect(
      f.adapter.run({ ...f.request, onPrepared: async () => {} }),
    ).rejects.toMatchObject({ name: "SubagentNotDispatchedError" });
    expect(f.events.emitted).toHaveLength(0);
  },
);

test.each(["tool-set", "definition"])(
  "adopted Codemode %s drift rejects historical launch before dispatch",
  async (dimension) => {
    const f = await adoptedCodemodeFixture();
    const previous = await f.adapter.preflight(f.request);
    if (dimension === "tool-set") {
      f.request.launchPolicy = {
        ...f.request.launchPolicy!,
        allowedTools: ["read", "codemode", "grep"],
      };
      await writeFile(
        join(f.root, "agent/agents/plan-simplicity-reviewer.md"),
        `---\nname: plan-simplicity-reviewer\ndescription: Changed\nmodel: test/model\nthinking: off\ntools: read, codemode, grep\nextensions:\nsubagentOnlyExtensions: ${resolve("src/runtime/integrations/readonly-codemode.ts")}\ninheritSkills: false\ninheritProjectContext: true\n---\nChanged source.\n`,
      );
    } else {
      await writeFile(
        join(f.root, "agent/agents/plan-simplicity-reviewer.md"),
        `---\nname: plan-simplicity-reviewer\ndescription: Changed\nmodel: test/model\nthinking: off\ntools: read, codemode\nextensions:\nsubagentOnlyExtensions: ${resolve("src/runtime/integrations/readonly-codemode.ts")}\ninheritSkills: false\ninheritProjectContext: true\n---\nDifferent evidence instructions.\n`,
      );
    }
    await expect(
      f.adapter.run({
        ...f.request,
        launch: previous,
        onPrepared: async () => {},
      }),
    ).rejects.toThrow("changed after durable preflight");
    expect(f.events.emitted).toHaveLength(0);
  },
);

test.each(["tool-set", "definition"])(
  "Codemode %s drift changes durable identity without dispatch",
  async (dimension) => {
    const f = await codemodeFixture("read, codemode, grep");
    const previous = await f.adapter.preflight(f.request);
    if (dimension === "tool-set") {
      const policy = f.request.launchPolicy!;
      f.request.launchPolicy = {
        ...policy,
        allowedTools: policy.allowedTools.filter((tool) => tool !== "grep"),
      };
    } else {
      await writeFile(
        f.definition,
        `---\nname: workflow-scout\ndescription: Changed Codemode definition\nmodel: test/model\nthinking: off\ntools: read, codemode, grep\nextensions:\ninheritSkills: false\ninheritProjectContext: true\n---\nDifferent read-only instructions.\n`,
      );
    }
    const current = await f.adapter.preflight(f.request);
    expect(current.launchContractDigest).not.toBe(
      previous.launchContractDigest,
    );
    if (dimension === "tool-set")
      expect(current.tools).not.toEqual(previous.tools);
    else expect(current.definitionDigest).not.toBe(previous.definitionDigest);
    expect(f.events.emitted).toHaveLength(0);
  },
);
