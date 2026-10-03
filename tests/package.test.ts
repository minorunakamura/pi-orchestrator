import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { makeExtensionApiFixture } from "./fakes/typed-boundaries.ts";

const root = resolve(import.meta.dirname, "..");

test("entry exports integrations and registers commands without activating runtime work", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(() => {
    throw Error("Unexpected external request");
  });
  vi.stubGlobal("fetch", fetch);
  try {
    const entry = await import("../src/index.ts");
    const { SubagentsIntegration } = await import(
      "../src/runtime/integrations/subagents.ts"
    );
    const { JevIntegration } = await import(
      "../src/runtime/integrations/jev.ts"
    );
    const { PlannotatorIntegration } = await import(
      "../src/runtime/integrations/plannotator.ts"
    );
    expect(entry.SubagentsIntegration).toBe(SubagentsIntegration);
    expect(entry.JevIntegration).toBe(JevIntegration);
    expect(entry.PlannotatorIntegration).toBe(PlannotatorIntegration);
    const commands = new Map<string, unknown>();
    const host = makeExtensionApiFixture({
      events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
      on: vi.fn(() => () => {}),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, options: unknown) => {
        commands.set(name, options);
      }),
    });
    entry.default(host);
    expect([...commands.keys()]).toEqual([
      "wf-new",
      "wf-feature",
      "wf-bugfix",
      "wf-hotfix",
      "wf-chore",
      "wf-resume",
      "wf-status",
    ]);
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

test("package declares existing Pi extension and four product Agent resources", async () => {
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  expect(manifest.pi?.extensions).toEqual(["./src/index.ts"]);
  expect(manifest.main).toBeUndefined();
  expect(manifest["pi-subagents"]?.agents).toEqual(["./agents"]);
  for (const result of await Promise.all(
    manifest.pi.extensions.map((entry: string) => stat(resolve(root, entry))),
  ))
    expect(result.isFile()).toBe(true);
  const agentsDirectory = resolve(root, manifest["pi-subagents"].agents[0]);
  const files = (await readdir(agentsDirectory)).toSorted();
  expect(files).toEqual([
    "plan-simplicity-reviewer.md",
    "planner.md",
    "ponytail-reviewer.md",
    "workflow-scout.md",
  ]);
  const definitions = await Promise.all(
    files.map((file) => readFile(join(agentsDirectory, file), "utf8")),
  );
  for (const [index, file] of files.entries()) {
    expect(definitions[index].match(/^name: (.+)$/mu)?.[1]).toBe(
      file.slice(0, -3),
    );
    // #20 owns verified read-only child Codemode; the baseline does not enable it.
    expect(definitions[index].match(/^tools: (.+)$/mu)?.[1]).not.toContain(
      "codemode",
    );
  }
});

test.each(["explicit", "installed"])(
  "Pi resource loader accepts %s local package without commands",
  async (source) => {
    const isolated = await mkdtemp(join(tmpdir(), "pi-orchestrator-package-"));
    try {
      const loader = new DefaultResourceLoader({
        cwd: isolated,
        agentDir: isolated,
        settingsManager: SettingsManager.inMemory(
          source === "installed" ? { packages: [root] } : {},
        ),
        additionalExtensionPaths: source === "explicit" ? [root] : [],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await loader.reload();
      const result = loader.getExtensions();
      expect(result.errors).toEqual([]);
      expect(result.extensions).toHaveLength(1);
      const extension = result.extensions[0];
      expect(extension.resolvedPath).toBe(join(root, "src/index.ts"));
      expect([...extension.commands.keys()]).toEqual([
        "wf-new",
        "wf-feature",
        "wf-bugfix",
        "wf-hotfix",
        "wf-chore",
        "wf-resume",
        "wf-status",
      ]);
      expect([...extension.tools.keys()]).toEqual([
        "wf_clarification_round",
        "wf_clarification_complete",
      ]);
      expect([...extension.handlers.keys()]).toEqual([
        "session_shutdown",
        "session_start",
        "before_agent_start",
        "tool_call",
      ]);
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  },
  15_000,
);
