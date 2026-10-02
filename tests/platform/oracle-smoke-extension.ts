import assert from "node:assert/strict";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  getAgentDir,
  VERSION,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../src/core/schema.ts";
import { subagentRunId } from "../../src/types.ts";
import { physicalModelSnapshot } from "../../src/runtime/integrations/subagent-launch.ts";
import {
  SubagentsIntegration,
  SUBAGENT_RPC_REQUEST_EVENT,
} from "../../src/runtime/integrations/subagents.ts";
import { ArtifactStore } from "../../src/runtime/persistence/artifact-store.ts";
import { StateStore } from "../../src/runtime/persistence/state-store.ts";
import { createWorkflow } from "../../src/runtime/orchestrator/start-workflow.ts";
import { driveWorkflow } from "../../src/runtime/orchestrator/drive-workflow.ts";
import { requestOracleAdvice } from "../../src/runtime/orchestrator/oracle-advisory.ts";
import { FakeJevDecisionClient } from "../fakes/index.ts";
import { configuration } from "../fakes/coding-scenario.ts";
import { jevPolicy } from "../fakes/jev-policy.ts";

/** Opt-in real builtin Oracle, unchanged production launch policy, disposable untrusted fixture. */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("oracle-smoke", {
    description: "Issue #17 builtin Oracle durability/read-only/recovery smoke",
    async handler(reportPath, ctx) {
      const report: Record<string, unknown> = {
        status: "failed",
        pi: VERSION,
        recordedAt: new Date().toISOString(),
        herdrTab: process.env.HERDR_TAB_ID,
        herdrPane: process.env.HERDR_PANE_ID,
      };
      try {
        assert.equal(process.env.HERDR_ENV, "1");
        assert.equal(VERSION, "0.99.1");
        assert.equal(ctx.isProjectTrusted(), false);
        const root = dirname(getAgentDir());
        assert(basename(root).startsWith("pi-orchestrator-platform-"));
        const cwd = ctx.cwd;
        const before = await readFile(join(cwd, "evidence.txt"), "utf8");
        const filesBefore = await readdir(cwd);
        const workflowId = `oracle-smoke-${Date.now()}`;
        const runDirectory = join(root, "runs", workflowId);
        const store = new ArtifactStore(runDirectory);
        const states = new StateStore(runDirectory);
        const host = {
          sessionId: ctx.sessionManager.getSessionId(),
          projectTrusted: ctx.isProjectTrusted(),
          availableModels: physicalModelSnapshot(ctx.modelRegistry),
          parentModel: ctx.model,
          scopedModelIds: ctx.scopedModels.map(
            ({ model }) => `${model.provider}/${model.id}`,
          ),
          runtimeSnapshotHost: pi,
        };
        const spawns: string[] = [];
        const events = {
          on: (event: string, listener: (payload: unknown) => void) =>
            pi.events.on(event, listener),
          emit: (event: string, payload: unknown) => {
            if (
              event === SUBAGENT_RPC_REQUEST_EVENT &&
              isRecord(payload) &&
              payload.method === "spawn" &&
              isRecord(payload.params)
            ) {
              spawns.push(String(payload.params.agent));
            }
            pi.events.emit(event, payload);
          },
        };
        const adapter = new SubagentsIntegration(events, {
          cwd,
          launchHost: host,
          artifactReader: store,
        });
        const created = await createWorkflow(
          {
            task: "Read-only competing diagnosis probe, not implementation. No product/architecture/scope authority is requested.",
            playbook: "bugfix",
            cwd,
          },
          {
            runsDirectory: join(root, "runs"),
            workflowIdFactory: () => workflowId,
            artifactStore: store,
            stateStore: states,
            subagentExecutor: adapter,
          },
        );
        // Fixture evidence, not a claim of actual Scout/Diagnosis producer coverage (#7).
        const scoutRef = await store.writeText(
          "scout",
          "scout.md",
          "Fixture facts: evidence.txt contains competing cache and timeout hypotheses. No approved Plan exists.",
        );
        const diagnosisRef = await store.writeText(
          "diagnosis",
          "diagnosis.md",
          "Observed failure: stale response. Competing hypotheses: stale cache versus delayed upstream response. Evidence is inconclusive; ask Human before new scope.",
        );
        const source = await states.saveState(
          {
            ...created.state,
            planning: {
              ...created.state.planning,
              context: { scoutRef, diagnosisRef },
            },
          },
          created.state.stateRevision,
        );
        await requestOracleAdvice(
          source,
          {
            reason: "competing-diagnosis",
            question:
              "Use the read tool once on evidence.txt in cwd. Compare the two supplied root-cause hypotheses, identify one missing piece of evidence, and report assumptions/risks/unresolved questions in under 1800 characters. No implementation or executor handoff is authorized. Do not call other tools or change any file.",
          },
          {
            artifactStore: store,
            stateStore: states,
            subagentExecutor: adapter,
          },
        );
        const deps = {
          artifactStore: store,
          stateStore: states,
          loadState: () => states.loadState(),
          subagentExecutor: adapter,
          cwd,
          configuration: {
            ...configuration,
            jev: jevPolicy(created.workflowId, cwd, 3),
          },
          jevDecisionClient: new FakeJevDecisionClient({
            stages: { research: "SKIP", clarification: "RUN" },
            mode: "GRILL_ME",
          }),
        };
        const result = await driveWorkflow(created.workflowId, deps);
        Object.assign(report, {
          progress: "driver-returned",
          phase: result.state.phase,
          block: result.state.block,
          spawns,
          runDirectory,
        });
        assert.equal(
          result.status,
          "pending",
          JSON.stringify(result.state.block),
        );
        assert.equal(result.state.phase, "clarifying");
        assert.deepEqual(spawns, ["oracle"]);
        const adviceRef = result.state.oracle!.latestAdviceRef!;
        const advice = JSON.parse(await store.readText(adviceRef));
        assert.equal(advice.status, "available");
        assert.equal(advice.request.sourceRevision, source.stateRevision);
        assert.equal(advice.request.reason, "competing-diagnosis");
        assert(advice.output.trim());
        const attempt = result.state.planning.agentAttempts!["oracle-1"];
        assert(attempt.launch && attempt.receipt);
        assert.equal(attempt.launch.source, "builtin");
        assert.equal(attempt.launch.packageVersion, "0.74.0");
        assert.equal(attempt.launch.policy.context, "fresh");
        assert.equal(attempt.launch.policy.denyExtensions, true);
        assert.equal(attempt.launch.inheritSkills, false);
        assert.equal(attempt.launch.projectTrusted, false);
        assert.deepEqual(attempt.launch.tools, ["find", "grep", "ls", "read"]);
        const recovered = await new SubagentsIntegration(events, {
          cwd,
          launchHost: host,
          artifactReader: store,
        }).status(subagentRunId(attempt.receipt.runId), attempt.receipt);
        assert.equal(recovered.status, "succeeded");
        assert(recovered.result?.status === "succeeded");
        assert.equal(recovered.result.output, advice.output);
        const records: unknown[] = (
          await readFile(join(attempt.receipt.asyncDir, "events.jsonl"), "utf8")
        )
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const tools = records.filter(
          (event) => isRecord(event) && event.type === "tool_execution_start",
        );
        assert(
          tools.some((event) => isRecord(event) && event.toolName === "read"),
        );
        assert(
          tools.every(
            (event) =>
              isRecord(event) &&
              attempt.launch!.tools.includes(String(event.toolName)),
          ),
        );
        assert.equal(await readFile(join(cwd, "evidence.txt"), "utf8"), before);
        assert.deepEqual(await readdir(cwd), filesBefore);
        for (const marker of [
          "PROJECT_SETTINGS_INJECTION",
          "PROJECT_SYSTEM_INJECTION",
          "PROJECT_APPEND_INJECTION",
          "PROJECT_PROMPT_INJECTION",
        ])
          assert(!advice.output.includes(marker));
        assert.equal(result.state.planning.approvedPlanRef, undefined);
        assert.equal(result.state.coding.implementationRef, undefined);
        assert.equal(result.state.oracle!.attemptsUsed, 1);
        assert.equal(result.state.oracle!.pendingRef, undefined);
        const terminalPath = join(
          attempt.receipt.asyncDir,
          "process-terminal.json",
        );
        Object.assign(report, {
          status: "passed",
          subagents: attempt.launch.packageVersion,
          adviceRef,
          output: advice.output,
          launch: attempt.launch,
          receipt: attempt.receipt,
          terminalPath,
          tools,
          phase: result.state.phase,
          recovery:
            "Recreated production adapter recovered exact historical full output; one spawn only",
          limitations:
            "Live builtin Oracle with unchanged production ceiling; fixture Scout/Diagnosis and scripted classifier (zero live classify). No actual Human Gates or full lifecycle claim; those remain producer/#12 coverage.",
        });
      } catch (error) {
        report.error = error instanceof Error ? error.message : String(error);
        if (error instanceof Error && error.cause instanceof Error)
          report.cause = error.cause.message;
      }
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      ctx.ui.notify(
        `Oracle smoke ${String(report.status)}: ${reportPath}`,
        report.status === "passed" ? "info" : "error",
      );
    },
  });
}
