import { rm, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { VERSION } from "@earendil-works/pi-coding-agent";
import {
  resolveSubagentLaunchContract,
  SUBAGENT_LAUNCH_CONTRACT_VERSION,
} from "pi-subagents/preflight";
import { expect, test, vi } from "vitest";
import { platformFixture } from "./fixtures.ts";

test("host peers use wildcard ranges and released baseline no longer installs the direct classifier client", async () => {
  const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  expect(manifest.peerDependencies["@earendil-works/pi-coding-agent"]).toBe(
    "*",
  );
  expect(manifest.devDependencies["@earendil-works/pi-coding-agent"]).toBe(
    "^0.99.1",
  );
  expect(
    manifest.dependencies["@earendil-works/pi-coding-agent"],
  ).toBeUndefined();
  expect(manifest.dependencies["pi-subagents"]).toBe("0.74.0");
  expect(manifest.dependencies["pi-typesafe"]).toBeUndefined();
  expect(VERSION).toBe("0.99.1");
  const lock = await readFile(resolve("pnpm-lock.yaml"), "utf8");
  expect(lock).not.toContain("pi-typesafe");
  expect(lock).not.toContain("pi-coding-agent@0.87.1");
  expect(lock).not.toContain("pi-ai@0.87.1");
});

test("0.74 public preflight binds identity, explicit skills, tools, model and protocol without dispatch", async () => {
  const fixture = await platformFixture();
  vi.stubEnv("PI_CODING_AGENT_DIR", fixture.agentDir);
  try {
    const input = {
      agent: "platform-isolated",
      cwd: fixture.cwd,
      context: "fresh" as const,
      agentScope: "user" as const,
      task: "platform contract",
      model: "platform-smoke/probe:off",
      output: false,
      availableModels: [
        { provider: "platform-smoke", id: "probe", reasoning: false },
      ],
      intercomBridge: { mode: "off" as const },
    };
    const result = await resolveSubagentLaunchContract(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(result.message);
    const contract = result.contract;
    expect(SUBAGENT_LAUNCH_CONTRACT_VERSION).toBe(3);
    expect(contract).toMatchObject({
      version: 3,
      context: "fresh",
      model: "platform-smoke/probe:off",
      thinking: "off",
      inheritProjectContext: false,
      inheritSkills: false,
      agent: { name: "platform-isolated", source: "user" },
      skills: {
        requested: ["platform-selected"],
        resolved: [{ name: "platform-selected" }],
        missing: [],
      },
      tools: { effectiveAllowlist: ["read"] },
      protocol: { lifecycleArtifactVersion: 3, packageVersion: "0.74.0" },
    });
    expect(contract.agent.definitionDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(contract.launchContractDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(contract.tools.effectiveAllowlist).not.toContain("codemode");
    const changed = await resolveSubagentLaunchContract({
      ...input,
      model: "platform-smoke/other:off",
      availableModels: [
        { provider: "platform-smoke", id: "other", reasoning: false },
      ],
    });
    expect(changed.ok).toBe(true);
    if (changed.ok)
      expect(changed.contract.launchContractDigest).not.toBe(
        contract.launchContractDigest,
      );
    expect(
      await resolveSubagentLaunchContract({
        ...input,
        skill: "missing-platform-skill",
      }),
    ).toMatchObject({ ok: false, code: "missing_skill" });
    expect(await readdir(fixture.root)).toEqual(["agent", "project"]);
    expect(await readdir(join(fixture.cwd, ".pi"))).not.toContain("subagents");
  } finally {
    vi.unstubAllEnvs();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
