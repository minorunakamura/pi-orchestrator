import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  getAgentDir,
  VERSION,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { physicalModelSnapshot } from "../../src/runtime/integrations/subagent-launch.ts";
import {
  SubagentsIntegration,
  SUBAGENT_RPC_REQUEST_EVENT,
} from "../../src/runtime/integrations/subagents.ts";
import { ArtifactStore } from "../../src/runtime/persistence/artifact-store.ts";
import { StateStore } from "../../src/runtime/persistence/state-store.ts";
import { createWorkflow } from "../../src/runtime/orchestrator/start-workflow.ts";
import { runPlanningAgent } from "../../src/runtime/orchestrator/planning-agent-run.ts";
import { agentLaunchPolicy } from "../../src/core/agent-launch.ts";
import { isRecord } from "../../src/core/schema.ts";

/** Positive native child; exact product definition/ceiling, no classifier or Human authority. */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("codemode-smoke", {
    description:
      "Issue #20 positive read-only Codemode / isolation / recovery smoke",
    async handler(reportPath, ctx) {
      const report: Record<string, unknown> = {
        status: "failed",
        pi: VERSION,
        startedAt: new Date().toISOString(),
        tab: process.env.HERDR_TAB_ID,
        pane: process.env.HERDR_PANE_ID,
      };
      try {
        assert.equal(process.env.HERDR_ENV, "1");
        assert.equal(VERSION, "0.99.1");
        assert.equal(ctx.isProjectTrusted(), false);
        assert(!pi.getActiveTools().includes("codemode"));
        const root = dirname(getAgentDir()),
          cwd = ctx.cwd;
        const before = await Promise.all(
          ["greeting.mjs", "facts.txt"].map((name) =>
            readFile(join(cwd, name), "utf8"),
          ),
        );
        const store = new ArtifactStore(join(root, "runs", "codemode"));
        const states = new StateStore(store.rootDirectory);
        let spawns = 0;
        const events = {
          on: (event: string, listener: (payload: unknown) => void) =>
            pi.events.on(event, listener),
          emit: (event: string, payload: unknown) => {
            if (
              event === SUBAGENT_RPC_REQUEST_EVENT &&
              isRecord(payload) &&
              payload.method === "spawn"
            )
              spawns++;
            pi.events.emit(event, payload);
          },
        };
        const host = {
          sessionId: ctx.sessionManager.getSessionId(),
          projectTrusted: false,
          availableModels: physicalModelSnapshot(ctx.modelRegistry),
          parentModel: ctx.model,
          scopedModelIds: ctx.scopedModels.map(
            ({ model }) => `${model.provider}/${model.id}`,
          ),
          runtimeSnapshotHost: pi,
        };
        const actual = new SubagentsIntegration(events, {
          cwd,
          launchHost: host,
          artifactReader: store,
          timeoutMs: 120000,
        });
        const created = await createWorkflow(
          {
            task: "Synthetic read-only Codemode smoke",
            playbook: "chore",
            cwd,
          },
          {
            runsDirectory: join(root, "runs"),
            workflowIdFactory: () => "codemode",
            artifactStore: store,
            stateStore: states,
            subagentExecutor: actual,
          },
        );
        const code = `const paths = ["greeting.mjs", "facts.txt"];
const facts = await Promise.all(paths.map(async path => ({path, lines:"1-1", excerpt:(await tools.read({path})).split("\\n")[0]})));
const forbidden = ["write","edit","bash","codemode","subagent","subagents_enable","subagent_supervisor","contact_supervisor","structured_output","mcp__fs__write"];
const denied = [];
for (const name of forbidden) { try { await tools[name]({path:"forbidden-mutation.txt",content:"bad",command:"touch forbidden-mutation.txt"}); } catch { denied.push(name); } }
let classifierDenied = false;
try { await models.classify("typesafe/jev-latest", {}); } catch { classifierDenied = true; }
return {facts, denied, models:typeof models, classifierDenied, callable:ALL_TOOLS, filteredBytes:JSON.stringify(facts).length};`;
        const input = {
          agent: "plan-simplicity-reviewer",
          launchPolicy: agentLaunchPolicy("plan-simplicity-reviewer"),
          cwd,
          task: `Synthetic positive integration probe, not implementation or approval. Before returning findings, execute the following EXACT code in one codemode call (not read calls). Do not attempt any other tools or classifier calls. It batches two actual file reads and safely checks unavailable capabilities. Confirm models is undefined and every forbidden call is denied. Afterward return ONLY {"schemaVersion":1,"findings":[]} (the synthetic candidate merely reuses the current greet function, no new components/dependencies). Preserve the exact source provenance in the codemode output.\n${code}`,
        };
        const deps = {
          artifactStore: store,
          stateStore: states,
          subagentExecutor: actual,
        };
        const first = await runPlanningAgent(
          created.state,
          "simplicity-v1",
          input,
          deps,
        );
        assert.equal(first.result.status, "succeeded");
        assert.equal(spawns, 1);
        const output =
          first.result.status === "succeeded" ? first.result.output : "";
        const ref = await store.writeText(
          "scout",
          "codemode-output.md",
          output,
        );
        assert.equal(await store.readText(ref), output);
        const attempt = first.state.planning.agentAttempts!["simplicity-v1"];
        assert(attempt.launch && attempt.receipt);
        assert.deepEqual(attempt.launch.tools, [
          "codemode",
          "find",
          "grep",
          "ls",
          "read",
        ]);
        assert.equal(
          attempt.launch.launchContractDigest,
          attempt.receipt.launchContractDigest,
        );
        const status = JSON.parse(
          await readFile(join(attempt.receipt.asyncDir, "status.json"), "utf8"),
        );
        const session = (await readFile(status.steps[0].sessionFile, "utf8"))
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        const messages = session
          .filter((entry) => entry.type === "message")
          .map((entry) => entry.message);
        const calls = messages.flatMap((m) =>
          m.role === "assistant"
            ? m.content.filter((c: { type: string }) => c.type === "toolCall")
            : [],
        );
        const scripts = messages.filter(
          (m) => m.role === "toolResult" && m.toolName === "codemode",
        );
        assert.equal(calls.length, 1);
        assert.equal(calls[0].name, "codemode");
        assert.equal(scripts.length, 1);
        const text = scripts[0].content
          .map((c: { text?: string }) => c.text ?? "")
          .join("\n");
        assert(text.includes("Script completed"));
        assert(
          text.includes('"models": "undefined"') ||
            text.includes('"models":"undefined"'),
        );
        assert(
          text.includes('"classifierDenied": true') ||
            text.includes('"classifierDenied":true'),
        );
        assert(
          text.includes("Hello") && text.includes("source provenance canary"),
        );
        for (const name of [
          "write",
          "edit",
          "bash",
          "codemode",
          "subagent",
          "subagents_enable",
          "subagent_supervisor",
          "contact_supervisor",
          "structured_output",
          "mcp__fs__write",
        ])
          assert(text.includes(`"${name}"`));
        assert.equal(scripts[0].nestedCalls.calls.length, 2);
        assert(
          scripts[0].nestedCalls.calls.every(
            (c: { name: string }) => c.name === "read",
          ),
        );
        const recreated = new SubagentsIntegration(events, {
          cwd,
          launchHost: host,
          artifactReader: store,
        });
        const recovered = await runPlanningAgent(
          await states.loadState(),
          "simplicity-v1",
          input,
          { ...deps, subagentExecutor: recreated },
        );
        assert.equal(recovered.result.status, "succeeded");
        assert.equal(
          recovered.result.status === "succeeded" && recovered.result.output,
          output,
        );
        assert.equal(spawns, 1);
        assert.deepEqual(
          await Promise.all(
            ["greeting.mjs", "facts.txt"].map((name) =>
              readFile(join(cwd, name), "utf8"),
            ),
          ),
          before,
        );
        await assert.rejects(readFile(join(cwd, "forbidden-mutation.txt")), {
          code: "ENOENT",
        });
        assert(
          !recovered.state.planning.approvedPlanRef &&
            !recovered.state.coding.implementationRef,
        );
        Object.assign(report, {
          status: "passed",
          finishedAt: new Date().toISOString(),
          spawns,
          launch: attempt.launch,
          receipt: attempt.receipt,
          outputRef: ref,
          statePhase: recovered.state.phase,
          statusPath: join(attempt.receipt.asyncDir, "status.json"),
          sessionFile: status.steps[0].sessionFile,
          runtimeScriptOutput: text,
          nestedCalls: scripts[0].nestedCalls,
          processTerminal: status.processTerminal,
          directReadEquivalentCalls: 2,
          actualCodemodeCalls: 1,
          scriptReplayOnRecovery: 0,
        });
      } catch (error) {
        report.error = error instanceof Error ? error.stack : String(error);
      }
      await writeFile(reportPath.trim(), JSON.stringify(report, null, 2));
      ctx.ui.notify(
        `Codemode smoke: ${String(report.status)}; ${reportPath}`,
        report.status === "passed" ? "info" : "error",
      );
    },
  });
}
