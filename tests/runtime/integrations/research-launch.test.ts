import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { registerSubagentCapabilityCeiling } from "pi-subagents/capability-ceiling";
import { agentLaunchPolicy } from "../../../src/core/agent-launch.ts";
import { SubagentsIntegration } from "../../../src/runtime/integrations/subagents.ts";
import { ArtifactStore } from "../../../src/runtime/persistence/artifact-store.ts";
import { FakeSubagentRpc } from "../../fakes/subagent-rpc.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(
  tools = "ketch_search, ketch_scrape, ketch_code, ketch_docs, contact_supervisor",
  inheritProjectContext = false,
) {
  const root = await mkdtemp(join(tmpdir(), "research-launch-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const source = join(root, "pi-ketch");
  await mkdir(agentDir);
  await mkdir(join(source, "agents"), { recursive: true });
  await mkdir(join(source, "src"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  // Public manifest/frontmatter contract from minorunakamura/pi-ketch@e49fd9ea48b675eef2ede729c9f13f7e12d44c20.
  // This fixture does not pretend to execute Ketch; the opt-in Herdr smoke loads the unmodified Git source.
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      name: "pi-ketch",
      pi: { subagents: { agents: ["./agents"] } },
    }),
  );
  await writeFile(
    join(source, "agents/researcher.md"),
    `---
name: researcher
package: pi-ketch
description: External evidence researcher
thinking: medium
tools: ${tools}
extensions:
subagentOnlyExtensions: ../src/researcher-tools.ts
systemPromptMode: replace
inheritProjectContext: ${inheritProjectContext}
inheritGlobalContext: false
inheritSkills: false
defaultContext: fresh
acceptanceRole: read-only
---
Return external facts only.
`,
  );
  await writeFile(
    join(source, "src/researcher-tools.ts"),
    "export default function () {}\n",
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      packages: [source],
      subagents: {
        defaultModel: "test/model",
        intercomBridge: { mode: "off" },
      },
    }),
  );
  const store = new ArtifactStore(join(root, "artifacts"));
  const taskRef = await store.writeText(
    "task",
    "task.md",
    "Inspect the known public source",
  );
  const events = new FakeSubagentRpc();
  const adapter = new SubagentsIntegration(events, {
    cwd: root,
    artifactReader: store,
    launchHost: {
      sessionId: root,
      projectTrusted: false,
      availableModels: [
        {
          provider: "test",
          id: "model",
          api: "openai-responses",
          reasoning: true,
        },
      ],
    },
  });
  const request = {
    agent: "pi-ketch.researcher",
    task: "External facts only",
    cwd: root,
    launchPolicy: agentLaunchPolicy("pi-ketch.researcher"),
    inputRefs: [taskRef],
    dispatch: {
      requestId: "research",
      ownerRunId: "workflow",
      nodeId: "research",
      deadline: new Date(Date.now() + 60000).toISOString(),
    },
    onStarted: async () => {},
  };
  return { adapter, request, events };
}

test("public package discovery and preflight accept the external-only Research contract without granting local or nested tools", async () => {
  const f = await fixture(
    "ketch_search, ketch_scrape, ketch_code, ketch_docs, contact_supervisor, read, write, bash, subagent",
  );
  const launch = await f.adapter.preflight(f.request);
  expect(launch).toMatchObject({
    agent: "pi-ketch.researcher",
    source: "package",
    thinking: "medium",
    tools: ["ketch_code", "ketch_docs", "ketch_scrape", "ketch_search"],
    inheritProjectContext: false,
    inheritGlobalContext: false,
    inheritSkills: false,
    policy: {
      authorityRole: "evidence",
      context: "fresh",
      denyExtensions: false,
    },
  });
  expect(f.events.emitted).toEqual([]);
});

test.each(["missing-tool", "context-drift", "denied-extension"])(
  "Research %s fails before any dispatch",
  async (fault) => {
    const f = await fixture(
      fault === "missing-tool"
        ? "ketch_search, ketch_docs, ketch_code"
        : undefined,
      fault === "context-drift",
    );
    const restriction =
      fault === "denied-extension"
        ? registerSubagentCapabilityCeiling({
            sessionId: f.request.cwd,
            source: "test",
            ceiling: { denyExtensions: true },
          })
        : undefined;
    try {
      await expect(
        f.adapter.run({
          ...f.request,
          onPrepared: async () => {
            throw Error("Should not prepare an invalid launch");
          },
        }),
      ).rejects.toMatchObject({ name: "SubagentNotDispatchedError" });
      expect(f.events.emitted).toEqual([]);
    } finally {
      restriction?.dispose();
    }
  },
);
