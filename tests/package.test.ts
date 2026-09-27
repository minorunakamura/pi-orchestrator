import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  DefaultResourceLoader,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";

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
    const host = {
      events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
      registerCommand: vi.fn((name: string, options: unknown) => {
        commands.set(name, options);
      }),
    } as unknown as ExtensionAPI;
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

test("package declares existing Pi extension and three product Agent resources", async () => {
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  expect(manifest.pi?.extensions).toEqual(["./src/index.ts"]);
  expect(manifest.main).toBeUndefined();
  expect(manifest["pi-subagents"]?.agents).toEqual(["./agents"]);
  for (const entry of manifest.pi.extensions)
    expect((await stat(resolve(root, entry))).isFile()).toBe(true);
  const agentsDirectory = resolve(root, manifest["pi-subagents"].agents[0]);
  const files = (await readdir(agentsDirectory)).sort();
  expect(files).toEqual([
    "planner.md",
    "ponytail-reviewer.md",
    "workflow-scout.md",
  ]);
  for (const file of files) {
    const definition = await readFile(join(agentsDirectory, file), "utf8");
    expect(definition.match(/^name: (.+)$/mu)?.[1]).toBe(file.slice(0, -3));
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
      const extension = result.extensions[0]!;
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
      expect(extension.tools.size).toBe(0);
      expect(extension.handlers.size).toBe(0);
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  },
  15_000,
);
