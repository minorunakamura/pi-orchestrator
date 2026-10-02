import { expect, test } from "vitest";
import {
  agentLaunchPolicy,
  parseAgentLaunchEvidence,
} from "../../src/core/agent-launch.ts";
import { fakeLaunchResolver } from "../fakes/agent-launch.ts";

async function evidence() {
  return fakeLaunchResolver(
    { agent: "workflow-scout", task: "private prompt" },
    { task: "private prompt", cwd: "/private/root", output: false },
  );
}
test("launch evidence rejects extra secrets, unbounded projection and role escalation", async () => {
  const launch = await evidence();
  expect(() =>
    parseAgentLaunchEvidence({ ...launch, apiKey: "credential" }),
  ).toThrow();
  expect(() =>
    parseAgentLaunchEvidence({ ...launch, model: "https://user:secret@host" }),
  ).toThrow();
  expect(() =>
    parseAgentLaunchEvidence({
      ...launch,
      requestedSkills: Array(129).fill("skill"),
    }),
  ).toThrow();
  expect(() =>
    parseAgentLaunchEvidence({
      ...launch,
      policy: { ...launch.policy, authorityRole: "implementation" },
    }),
  ).toThrow();
  expect(() =>
    parseAgentLaunchEvidence({
      ...launch,
      tools: ["write"],
      policy: {
        ...launch.policy,
        allowedTools: ["read", "write"],
        forbiddenTools: [],
      },
    }),
  ).toThrow();
});
test.each([
  "workflow-scout",
  "plan-simplicity-reviewer",
  "reviewer",
  "ponytail-reviewer",
])(
  "%s supports an explicit read-only Codemode inspection policy, not a caller isolation claim",
  async (agent) => {
    const base = agentLaunchPolicy(agent);
    const policy = {
      ...base,
      allowedTools: [...base.allowedTools, "codemode"],
      requiredTools: ["read", "codemode"],
      forbiddenTools: base.forbiddenTools.filter((tool) => tool !== "codemode"),
      denyExtensions: false,
    };
    const launch = await fakeLaunchResolver(
      { agent, task: "inspect", launchPolicy: policy },
      { task: "inspect", cwd: "/repo", output: false },
    );
    expect(parseAgentLaunchEvidence(launch)).toEqual(launch);
    for (const changed of [
      { ...policy, requiredTools: ["read"] },
      { ...policy, denyExtensions: true },
      { ...policy, allowedTools: [...policy.allowedTools, "powershell"] },
      { ...policy, codemodeIsolationVerified: true },
    ])
      expect(() =>
        parseAgentLaunchEvidence({ ...launch, policy: changed }),
      ).toThrow();
  },
);

test.each(["worker", "oracle", "planner", "pi-ketch.researcher"])(
  "%s does not gain Codemode through the inspection contract",
  async (agent) => {
    const profile = { provider: "test", model: "model", thinking: "off" };
    const base = agentLaunchPolicy(agent, profile);
    const policy = {
      ...base,
      allowedTools: ["read", "codemode"],
      requiredTools: ["read", "codemode"],
      forbiddenTools: [],
      denyExtensions: false,
    };
    const launch = await fakeLaunchResolver(
      {
        agent,
        task: "inspect",
        executionProfile: profile,
        launchPolicy: policy,
      },
      { task: "inspect", cwd: "/repo", output: false },
    );
    expect(() => parseAgentLaunchEvidence(launch)).toThrow();
  },
);

test("required tools, explicit skills, inheritance and approved Worker profile remain binding", async () => {
  const launch = await evidence();
  expect(() => parseAgentLaunchEvidence({ ...launch, tools: [] })).toThrow();
  expect(() =>
    parseAgentLaunchEvidence({ ...launch, inheritSkills: true }),
  ).toThrow();
  expect(() =>
    parseAgentLaunchEvidence({
      ...launch,
      policy: { ...launch.policy, skills: ["tdd"] },
    }),
  ).toThrow();
  const profile = { provider: "test", model: "worker", thinking: "high" };
  const worker = await fakeLaunchResolver(
    {
      agent: "worker",
      task: "approved",
      executionProfile: profile,
      launchPolicy: agentLaunchPolicy("worker", profile),
    },
    { task: "approved", cwd: "/repo", output: false },
  );
  expect(parseAgentLaunchEvidence(worker)).toEqual(worker);
  expect(() =>
    parseAgentLaunchEvidence({ ...worker, model: "test/other" }),
  ).toThrow();
});
