import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";

/** Inspect the released owner's public registered tools, not hand-written fake schemas. */
test.each(["dynamic", "eager"])(
  "Pi 0.99.1 loads the independent 0.74.0 owner with %s activation and the released single-agent schema",
  async (toolActivation) => {
    const root = await mkdtemp(join(tmpdir(), "issue12-owner-contract-"));
    try {
      vi.stubEnv("PI_CODING_AGENT_DIR", root);
      await mkdir(join(root, "extensions/subagent"), { recursive: true });
      await writeFile(
        join(root, "extensions/subagent/config.json"),
        JSON.stringify({ toolActivation }),
      );
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        settingsManager: SettingsManager.create(root, root, {
          projectTrusted: false,
        }),
        additionalExtensionPaths: [resolve("node_modules/pi-subagents")],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await loader.reload();
      const loaded = loader.getExtensions();
      expect(loaded.errors).toEqual([]);
      const owner = loaded.extensions.find((extension) =>
        extension.tools.has("subagent"),
      );
      expect(owner).toBeDefined();
      const tool = owner!.tools.get("subagent")!;
      expect(tool.definition.exposure).toBe("model-only");
      const schema = JSON.stringify(tool.definition.parameters);
      expect(schema).toContain('"agent"');
      expect(schema).toContain('"task"');
      // script is a public RPC field, not a model-facing tool parameter.
      expect(schema).not.toContain('"script"');
      expect(schema).toContain('"workflow"');
      expect(schema).not.toContain('"workflowScript"');
      expect(schema).not.toContain('"workflowScriptPath"');
      expect(owner!.tools.has("bg_wait")).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);
