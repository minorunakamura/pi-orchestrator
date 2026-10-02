import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  getAgentDir,
  VERSION,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { resolveSubagentLaunchContract } from "pi-subagents/preflight";
import { SubagentsIntegration } from "../../src/runtime/integrations/subagents.ts";
import { ArtifactStore } from "../../src/runtime/persistence/artifact-store.ts";
import type { AgentRunReceipt } from "../../src/runtime/ports/subagent-executor.ts";

/** Opt-in command, loaded explicitly in a fresh Herdr tab, not a product extension. */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("platform-smoke", {
    description: "Offline released-platform child trust/isolation/RPC smoke",
    async handler(reportPath, ctx) {
      const root = dirname(getAgentDir());
      const cwd = join(root, "project");
      const report: Record<string, unknown> = {
        status: "failed",
        pi: VERSION,
        node: process.version,
        recordedAt: new Date().toISOString(),
        network: "offline model provider; no live Jev call",
        results: [],
      };
      try {
        assert.equal(process.env.HERDR_ENV, "1");
        assert.equal(VERSION, "0.99.1");
        assert.equal(ctx.isProjectTrusted(), false);
        const store = new ArtifactStore(join(root, "artifacts", randomUUID()));
        await store.writeText(
          "task",
          "probe.md",
          "Platform probe; no workflow authority.",
        );
        const integration = new SubagentsIntegration(pi.events, {
          cwd,
          projectTrusted: ctx.isProjectTrusted(),
          artifactReader: store,
          timeoutMs: 60_000,
        });
        const results: unknown[] = [];
        for (const inherited of [true, false]) {
          const agent = `platform-${inherited ? "inherited" : "isolated"}`;
          // Host snapshots are supplied to the released public preflight, not inferred.
          // oxlint-disable-next-line eslint/no-await-in-loop
          const preflight = await resolveSubagentLaunchContract({
            agent,
            cwd,
            agentScope: "user",
            context: "fresh",
            availableModels: ctx.modelRegistry.getAvailable(),
            model: "platform-smoke/probe:off",
            intercomBridge: { mode: "off" },
            runtimeSnapshotHost: pi,
          });
          assert.equal(preflight.ok, true);
          assert.equal(preflight.contract.protocol.packageVersion, "0.74.0");
          assert.equal(preflight.contract.protocol.lifecycleArtifactVersion, 3);
          assert.equal(preflight.contract.inheritSkills, inherited);
          assert(
            !preflight.contract.tools.effectiveAllowlist.includes("codemode"),
          );
          let receipt: AgentRunReceipt | undefined;
          // oxlint-disable-next-line eslint/no-await-in-loop
          const result = await integration.run({
            agent,
            cwd,
            // An untrusted project template must not expand this task.
            task: "/project-prompt",
            executionProfile: {
              provider: "platform-smoke",
              model: "probe",
              thinking: "off",
            },
            onStarted: async (value) => {
              receipt = value;
              await writeFile(
                join(root, `${agent}-receipt.json`),
                JSON.stringify(value),
              );
            },
          });
          assert.equal(result.status, "succeeded", JSON.stringify(result));
          assert(receipt);
          if (result.status !== "succeeded")
            throw Error("Missing canonical child output");
          const evidence = JSON.parse(result.output);
          assert.equal(evidence.projectTrusted, false);
          assert.equal(evidence.selectedSkill, true);
          assert.equal(evidence.ambientSkill, inherited);
          assert.equal(evidence.extensionSkill, inherited);
          assert.equal(evidence.projectSkill, false);
          assert.equal(evidence.projectPrompt, false);
          assert.equal(evidence.model, "platform-smoke/probe");
          for (const forbidden of [
            "write",
            "edit",
            "bash",
            "codemode",
            "subagent",
          ])
            assert(!evidence.tools.includes(forbidden));
          // oxlint-disable-next-line eslint/no-await-in-loop
          const recovered = await integration.status(result.runId, receipt);
          assert.equal(
            recovered.status,
            "succeeded",
            JSON.stringify(recovered),
          );
          assert.deepEqual(recovered.result, {
            runId: result.runId,
            status: "succeeded",
            output: result.output,
          });
          results.push({
            agent,
            evidence,
            receipt,
            recovery: "exact canonical output matched",
          });
        }
        await assert.rejects(access(join(root, "project-extension-loaded")));
        Object.assign(report, {
          status: "passed",
          subagents: "0.74.0",
          lifecycleArtifactVersion: 3,
          results,
          herdrTab: process.env.HERDR_TAB_ID,
          herdrPane: process.env.HERDR_PANE_ID,
        });
      } catch (error) {
        report.error = error instanceof Error ? error.message : String(error);
      }
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      ctx.ui.notify(
        `Platform smoke ${String(report.status)}: ${reportPath}`,
        report.status === "passed" ? "info" : "error",
      );
    },
  });
}
