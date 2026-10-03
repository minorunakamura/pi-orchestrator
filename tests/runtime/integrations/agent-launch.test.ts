import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
