import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  getAgentDir,
  VERSION,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../src/core/schema.ts";
import { subagentRunId } from "../../src/types.ts";
import { ArtifactStore } from "../../src/runtime/persistence/artifact-store.ts";
import { StateStore } from "../../src/runtime/persistence/state-store.ts";
import {
  SubagentsIntegration,
  SUBAGENT_RPC_REQUEST_EVENT,
} from "../../src/runtime/integrations/subagents.ts";

/** Observer only: run /wf-new through the unmodified production entry first. */
export default function (pi: ExtensionAPI) {
  let spawns = 0;
  let ownershipContext: string | undefined;
  pi.on("context_with_system", (event) => {
    const ownership = event.messages.find(
      (message) =>
        message.role === "custom" &&
        message.customType === "orchestrator-ownership-context",
    );
    if (ownership?.role === "custom" && typeof ownership.content === "string")
      ownershipContext = ownership.content;
  });
  pi.events.on(SUBAGENT_RPC_REQUEST_EVENT, (value) => {
    if (isRecord(value) && value.method === "spawn") spawns += 1;
  });
  pi.registerCommand("launch-ownership-audit", {
    description: "Read-only persisted-session Scout/ownership launch audit",
    async handler(reportPath, ctx) {
      const report: Record<string, unknown> = {
        status: "failed",
        recordedAt: new Date().toISOString(),
        pi: VERSION,
        herdrTab: process.env.HERDR_TAB_ID,
        herdrPane: process.env.HERDR_PANE_ID,
      };
      try {
        assert.equal(process.env.HERDR_ENV, "1");
        assert.equal(VERSION, "0.99.1");
        assert(
          basename(dirname(getAgentDir())).startsWith(
            "pi-orchestrator-diagnosis-",
          ),
        );
        const sessionFile = ctx.sessionManager.getSessionFile();
        assert(
          sessionFile,
          "Persisted session required; --no-session would hide the bug",
        );
        const sessionId = ctx.sessionManager.getSessionId();
        assert.notEqual(sessionFile, sessionId);
        const runs = join(ctx.cwd, ".pi/orchestrator/runs");
        const names = await readdir(runs);
        assert.equal(names.length, 1);
        const directory = join(runs, names[0]);
        const state = await new StateStore(directory).loadState();
        const artifacts = new ArtifactStore(directory);
        assert(state.ownershipRef);
        const ownership = JSON.parse(
          await artifacts.readText(state.ownershipRef),
        );
        assert.equal(ownership.rootSessionId, sessionId);
        const scout = state.planning.agentAttempts?.scout;
        assert(scout?.launch);
        assert(scout.receipt);
        assert(
          state.planning.context.scoutRef,
          "Scout output must be authoritative before classifier block",
        );
        assert.equal(scout.launch.policy.denyExtensions, true);
        assert.equal(scout.launch.packageVersion, "0.74.0");
        assert.equal(scout.receipt.sessionId, sessionFile);
        assert.equal(
          scout.receipt.launchContractDigest,
          scout.launch.launchContractDigest,
        );
        const status = JSON.parse(
          await readFile(join(scout.receipt.asyncDir, "status.json"), "utf8"),
        );
        assert.equal(status.state, "complete");
        assert.equal(status.processTerminal.state, "observed");
        assert(
          status.processTerminal.instances.every(
            (instance: { exitCode: number }) => instance.exitCode === 0,
          ),
        );
        assert.equal(
          status.launchResolvedExtensions.disableAmbientExtensions,
          true,
        );
        const transcript = await readFile(status.steps[0].sessionFile, "utf8");
        assert(!transcript.includes("Active workflow owns this workspace"));
        assert(
          transcript.includes('"toolName":"read"'),
          "Scout must actually read a repository file",
        );
        const output = await artifacts.readText(
          state.planning.context.scoutRef,
        );
        assert(output.includes("cache.ts"));
        assert(!output.includes("Active workflow owns this workspace"));
        assert.equal(spawns, 1);
        const mainToolCalls = ctx.sessionManager
          .getEntries()
          .flatMap((entry) =>
            entry.type === "message" && entry.message.role === "assistant"
              ? entry.message.content.filter(
                  (content) => content.type === "toolCall",
                )
              : [],
          );
        assert.equal(
          mainToolCalls.length,
          0,
          "Completion wake must not cause Main tools or clarification retries",
        );
        assert(
          ownershipContext?.includes(`"workflowId":"${state.workflowId}"`),
        );
        assert(
          ownershipContext?.includes('"phase":"gathering-context"') ||
            ownershipContext?.includes('"phase":"blocked"'),
        );
        assert(ownershipContext?.includes("not a request to implement"));
        const ownerSource = pi
          .getAllTools()
          .find((tool) =>
            ["subagent", "subagents_enable"].includes(tool.name),
          )?.sourceInfo;
        assert(ownerSource);
        const recovered = await new SubagentsIntegration(pi.events, {
          artifactReader: artifacts,
        }).status(subagentRunId(scout.receipt.runId), scout.receipt);
        assert.equal(recovered.status, "succeeded");
        assert.equal(
          await readFile(join(ctx.cwd, "cache.ts"), "utf8"),
          "export function lookup(cache: Record<string, number>, key: string): number {\n  if (!cache[key]) throw new Error('missing');\n  return cache[key];\n}\n",
        );
        assert.equal(
          await readFile(join(ctx.cwd, "failure.log"), "utf8"),
          "Recorded failing assertion: lookup({key:0}, 'key')\nExpected: 0\nObserved: Error('missing') at cache.ts:2\nThis log is supplied evidence, not an execution performed by Diagnosis.\n",
        );
        Object.assign(report, {
          status: "passed",
          workflowId: state.workflowId,
          phase: state.phase,
          block: state.block,
          rootSessionId: sessionId,
          rpcSessionId: sessionFile,
          launch: scout.launch,
          receipt: scout.receipt,
          extensions: status.launchResolvedExtensions,
          terminal: status.processTerminal,
          scoutOutput: output,
          spawns,
          mainToolCalls: mainToolCalls.length,
          ownerSource,
          fixturePromptWorkaround: false,
          ownershipContext,
          recovery: "exact receipt/full output succeeded without redispatch",
          limitations:
            "Actual production /wf-new + read-only Scout only; no classifier grant, Worker, Human Gates or recovery of operator's blocked workflow.",
        });
      } catch (error) {
        report.error = error instanceof Error ? error.stack : String(error);
      }
      await writeFile(
        reportPath.trim(),
        `${JSON.stringify(report, null, 2)}\n`,
      );
      ctx.ui.notify(
        `Launch ownership audit ${String(report.status)}: ${reportPath.trim()}`,
        report.status === "passed" ? "info" : "error",
      );
    },
  });
}
