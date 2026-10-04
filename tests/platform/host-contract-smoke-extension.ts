import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  getAgentDir,
  VERSION,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  agentLaunchPolicy,
  parseAgentLaunchEvidence,
  type AgentLaunchEvidence,
} from "../../src/core/agent-launch.ts";
import { physicalModelSnapshot } from "../../src/runtime/integrations/subagent-launch.ts";
import {
  SubagentsIntegration,
  SUBAGENT_RPC_REQUEST_EVENT,
} from "../../src/runtime/integrations/subagents.ts";
import { ArtifactStore } from "../../src/runtime/persistence/artifact-store.ts";
import type { AgentRunReceipt } from "../../src/runtime/ports/subagent-executor.ts";
import { isRecord } from "../../src/core/schema.ts";
import { subagentRunId } from "../../src/types.ts";

/** Released owner + actual native children; deterministic model only, no fake RPC/status/output. */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("host-contract-smoke", {
    description:
      "0.74.0 full output, cold RPC activation, fanout preflight, stop and timeout contract",
    async handler(reportPath, ctx) {
      const report: Record<string, unknown> = {
        status: "failed",
        pi: VERSION,
        startedAt: new Date().toISOString(),
        herdrTab: process.env.HERDR_TAB_ID,
        herdrPane: process.env.HERDR_PANE_ID,
        network: "offline provider",
      };
      const initialTools = pi.getActiveTools();
      const complete: unknown[] = [];
      const unsubscribe = pi.events.on("subagent:async-complete", (value) =>
        complete.push(value),
      );
      try {
        assert.equal(process.env.HERDR_ENV, "1");
        assert.equal(VERSION, "0.99.1");
        assert.equal(ctx.isProjectTrusted(), false);
        const root = dirname(getAgentDir());
        const cwd = join(root, "project");
        const store = new ArtifactStore(join(root, "contracts", randomUUID()));
        const profile = {
          provider: "platform-smoke",
          model: "probe",
          thinking: "off",
        };
        const policy = {
          ...agentLaunchPolicy("workflow-scout", profile, [
            "platform-selected",
          ]),
          agent: "platform-isolated",
          inheritProjectContext: false,
          denyExtensions: false,
        };
        let spawns = 0;
        const events = {
          on: (name: string, listener: (value: unknown) => void) =>
            pi.events.on(name, listener),
          emit: (name: string, value: unknown) => {
            if (name === SUBAGENT_RPC_REQUEST_EVENT) {
              spawns++;
              // Released display-only option: production intentionally leaves inline output uncapped.
              // The real owner still writes the full file and must return the same launch digest.
              if (
                isRecord(value) &&
                isRecord(value.params) &&
                value.params.task === "PLATFORM_LARGE_OUTPUT"
              )
                value = {
                  ...value,
                  params: {
                    ...value.params,
                    maxOutput: { bytes: 1024, lines: 10 },
                  },
                };
            }
            pi.events.emit(name, value);
          },
        };
        const host = {
          sessionId: ctx.sessionManager.getSessionId(),
          projectTrusted: ctx.isProjectTrusted(),
          availableModels: physicalModelSnapshot(ctx.modelRegistry),
          parentModel: ctx.model,
          scopedModelIds: [],
          runtimeSnapshotHost: pi,
        };
        const adapter = new SubagentsIntegration(events, {
          cwd,
          artifactReader: store,
          launchHost: host,
          timeoutMs: 60000,
        });
        const input = (
          task: string,
          onStarted?: (receipt: AgentRunReceipt) => Promise<void>,
        ) => ({
          agent: policy.agent,
          launchPolicy: policy,
          executionProfile: profile,
          cwd,
          task,
          onStarted: async (receipt: AgentRunReceipt) => {
            await writeFile(
              join(store.rootDirectory, `receipt-${receipt.requestId}.json`),
              JSON.stringify(receipt),
            );
            await onStarted?.(receipt);
          },
          onPrepared: async (launch: AgentLaunchEvidence) => {
            const launchRef = await store.writeJson(
              "agent-launch",
              `${randomUUID()}.json`,
              launch,
              parseAgentLaunchEvidence,
            );
            await writeFile(
              join(store.rootDirectory, `intent-${randomUUID()}.json`),
              JSON.stringify({ status: "intent", task, launchRef }),
            );
          },
        });
        const toolsBefore = initialTools;
        const activation = process.env.ISSUE12_ACTIVATION;
        if (activation === "dynamic") {
          assert(toolsBefore.includes("subagents_enable"));
          assert(!toolsBefore.includes("subagent"));
        } else if (activation === "eager") {
          assert(toolsBefore.includes("subagent"));
          assert(!toolsBefore.includes("subagents_enable"));
        }
        report.configuredActivation = activation;
        // Public RPC must work with the native model-facing delegation tool cold.
        pi.setActiveTools(toolsBefore.filter((name) => name !== "subagent"));
        assert(!pi.getActiveTools().includes("subagent"));
        await assert.rejects(
          adapter.runParallel([
            input("valid sibling must not start"),
            {
              ...input("missing sibling"),
              agent: "missing-platform-agent",
              launchPolicy: { ...policy, agent: "missing-platform-agent" },
            },
          ]),
        );
        assert.equal(spawns, 0);
        let largeReceipt: AgentRunReceipt | undefined;
        const large = await adapter.run(
          input("PLATFORM_LARGE_OUTPUT", async (value) => {
            largeReceipt = value;
          }),
        );
        assert.equal(large.status, "succeeded", JSON.stringify(large));
        assert(largeReceipt && large.status === "succeeded");
        const full = JSON.parse(large.output);
        assert.equal(full.padding.length, 100000);
        assert.equal(full.projectTrusted, false);
        assert.equal(full.selectedSkill, true);
        assert.equal(full.ambientSkill, false);
        assert.equal(full.extensionSkill, false);
        assert.equal(full.projectSkill, false);
        assert.equal(full.projectPrompt, false);
        const notification = complete.find(
          (value) => isRecord(value) && value.runId === large.runId,
        );
        assert(isRecord(notification) && Array.isArray(notification.results));
        const display = notification.results[0];
        assert(isRecord(display) && typeof display.output === "string");
        assert.equal(typeof notification.summary, "string");
        const summary = String(notification.summary);
        report.largeDisplay = {
          inlineLength: display.output.length,
          summaryLength: summary.length,
          fullLength: large.output.length,
        };
        assert(
          summary.length < large.output.length,
          "Explicit maxOutput truncates the summary, not the raw results or authoritative full output",
        );
        const fresh = new SubagentsIntegration(events, {
          cwd,
          artifactReader: store,
          launchHost: host,
        });
        const recovered = await fresh.status(large.runId, largeReceipt);
        assert(recovered.result?.status === "succeeded");
        assert.equal(recovered.result.output, large.output);
        assert.equal(spawns, 1);
        pi.setActiveTools(toolsBefore);
        const stopRequest = (id: string) =>
          new Promise<unknown>((resolve, reject) => {
            const requestId = randomUUID();
            const timer = setTimeout(() => {
              off();
              reject(Error("Stop RPC did not settle"));
            }, 10000);
            const off = pi.events.on(
              `subagents:rpc:v1:reply:${requestId}`,
              (reply) => {
                clearTimeout(timer);
                off();
                resolve(reply);
              },
            );
            pi.events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
              version: 1,
              requestId,
              method: "stop",
              params: { id },
            });
          });
        let stoppedReceipt: AgentRunReceipt | undefined;
        let stopReply: unknown;
        const stopped = await adapter.run(
          input("PLATFORM_DELAY_OUTPUT", async (receipt) => {
            stoppedReceipt = receipt;
            stopReply = await stopRequest(receipt.runId);
          }),
        );
        assert(stoppedReceipt);
        assert.equal(
          stopped.status,
          "ambiguous",
          "A stop request is not terminal success proof",
        );
        const stopStatus = await fresh.status(
          subagentRunId(stoppedReceipt.runId),
          stoppedReceipt,
        );
        assert.notEqual(stopStatus.status, "succeeded");
        const short = new SubagentsIntegration(events, {
          cwd,
          artifactReader: store,
          launchHost: host,
          timeoutMs: 4000,
        });
        let timedReceipt: AgentRunReceipt | undefined;
        const timed = await short.run(
          input("PLATFORM_DELAY_OUTPUT", async (value) => {
            timedReceipt = value;
          }),
        );
        assert.equal(timed.status, "ambiguous");
        assert(timed.status === "ambiguous" && timed.timedOut);
        assert(
          timedReceipt,
          "Retain exact public receipt for later reconciliation",
        );
        // Reconcile this same timed-out read-only child; never spawn/resume/replay it.
        await new Promise((resolve) => setTimeout(resolve, 12000));
        const reconciled = await fresh.status(
          subagentRunId(timedReceipt.runId),
          timedReceipt,
        );
        assert.equal(reconciled.status, "unknown", JSON.stringify(reconciled));
        const terminal = JSON.parse(
          await readFile(join(timedReceipt.asyncDir, "status.json"), "utf8"),
        );
        assert.equal(terminal.processTerminal.state, "observed");
        assert.notEqual(terminal.state, "complete");
        report.timeoutTerminalProof = terminal.processTerminal;
        assert.equal(spawns, 3);
        Object.assign(report, {
          status: "passed",
          subagents: "0.74.0",
          finishedAt: new Date().toISOString(),
          activation: { coldRpc: true, initialTools: toolsBefore },
          preflightSpawns: 0,
          large: {
            fullLength: large.output.length,
            inlineLength: display.output.length,
            summaryLength: summary.length,
            receipt: largeReceipt,
          },
          stop: { result: stopped, reply: stopReply, reconciled: stopStatus },
          timeout: { result: timed, receipt: timedReceipt, reconciled },
          spawnCount: spawns,
          failureKind:
            "Not applicable: ordinary single RPC; workflow-only semantics are not required",
          limitations:
            "Offline model and test-only provider extension policy, not production Gates/classifier or OS sandbox",
        });
      } catch (error) {
        report.error = error instanceof Error ? error.stack : String(error);
      } finally {
        pi.setActiveTools(initialTools);
        unsubscribe();
      }
      await writeFile(reportPath.trim(), JSON.stringify(report, null, 2));
      ctx.ui.notify(
        `Host contract smoke ${String(report.status)}: ${reportPath}`,
        report.status === "passed" ? "info" : "error",
      );
    },
  });
}
