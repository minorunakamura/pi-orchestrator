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
import { physicalModelSnapshot } from "../../src/runtime/integrations/subagent-launch.ts";
import {
  SubagentsIntegration,
  SUBAGENT_RPC_REQUEST_EVENT,
} from "../../src/runtime/integrations/subagents.ts";
import { ArtifactStore } from "../../src/runtime/persistence/artifact-store.ts";
import { StateStore } from "../../src/runtime/persistence/state-store.ts";
import { createWorkflow } from "../../src/runtime/orchestrator/start-workflow.ts";
import { driveWorkflow } from "../../src/runtime/orchestrator/drive-workflow.ts";
import { resumeWorkflow } from "../../src/runtime/orchestrator/resume-workflow.ts";
import { diagnosisEvidence } from "../../src/runtime/orchestrator/diagnosis.ts";
import { FakeJevDecisionClient } from "../fakes/index.ts";
import { configuration } from "../fakes/coding-scenario.ts";
import { jevPolicy } from "../fakes/jev-policy.ts";

/** Explicit opt-in; only real read-only Scout/Diagnosis, no Worker or classifier network calls. */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("diagnosis-smoke", {
    description: "Issue #7 read-only Diagnosis persistence and recovery smoke",
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
        const root = dirname(getAgentDir());
        assert(basename(root).startsWith("pi-orchestrator-diagnosis-"));
        const cwd = ctx.cwd;
        const files = await readdir(cwd);
        const before = await Promise.all(
          files.map((file) => readFile(join(cwd, file), "utf8")),
        );
        const workflowId = `diagnosis-smoke-${Date.now()}`;
        const runDirectory = join(root, "runs", workflowId);
        const store = new ArtifactStore(runDirectory);
        const states = new StateStore(runDirectory);
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
            )
              spawns.push(String(payload.params.agent));
            pi.events.emit(event, payload);
          },
        };
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
        const adapter = new SubagentsIntegration(events, {
          cwd,
          launchHost: host,
          artifactReader: store,
          timeoutMs: 120000,
        });
        const created = await createWorkflow(
          {
            task: "Read-only diagnosis probe, NOT implementation. lookup({key:0}, 'key') incorrectly throws 'missing'; expected return 0. Inspect only cache.ts and failure.log in this disposable workspace. Scout report under 1000 characters. Diagnosis must distinguish the recorded failure from command execution (no commands allowed), cite the local source/log, and preserve unknowns. Return compact JSON per the supplied Diagnosis contract, under 4500 characters. No file changes, scope/architecture decisions, Plan approval or implementation.",
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
        const classifier = new FakeJevDecisionClient({
          stages: { clarification: "RUN" },
          mode: "GRILL_ME",
        });
        const deps = {
          artifactStore: store,
          stateStore: states,
          loadState: () => states.loadState(),
          subagentExecutor: adapter,
          cwd,
          configuration: {
            ...configuration,
            jev: jevPolicy(cwd, 3),
          },
          jevDecisionClient: classifier,
        };
        const result = await driveWorkflow(created.workflowId, deps);
        Object.assign(report, {
          runDirectory,
          spawns,
          phase: result.state.phase,
          block: result.state.block,
        });
        assert.equal(
          result.state.phase,
          "clarifying",
          JSON.stringify(result.state.block),
        );
        assert.deepEqual(spawns, ["workflow-scout", "workflow-scout"]);
        const evidence = await diagnosisEvidence(result.state, deps);
        assert(evidence);
        assert(
          evidence.workspaceEvidence.some((item) => item.includes("cache.ts")),
        );
        assert.equal(evidence.expectedBehavior?.includes("0"), true);
        const attempt = result.state.planning.agentAttempts!.diagnosis;
        assert(attempt.receipt && attempt.launch);
        assert.deepEqual(attempt.launch.tools, ["find", "grep", "ls", "read"]);
        const recovered = await new SubagentsIntegration(events, {
          cwd,
          launchHost: host,
          artifactReader: store,
        }).status(subagentRunId(attempt.receipt.runId), attempt.receipt);
        assert.equal(recovered.status, "succeeded");
        assert(recovered.result?.status === "succeeded");
        assert.deepEqual(JSON.parse(recovered.result.output), evidence);
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
              ["read", "grep", "find", "ls"].includes(String(event.toolName)),
          ),
        );
        const calls = classifier.calls.routeStage.length;
        await states.saveState(
          { ...result.state, phase: "gathering-context" },
          result.state.stateRevision,
        );
        const resumed = await resumeWorkflow(created.workflowId, {
          ...deps,
          runDirectory,
        });
        assert.equal(resumed.state.phase, "clarifying");
        assert.equal(classifier.calls.routeStage.length, calls);
        assert.deepEqual(spawns, ["workflow-scout", "workflow-scout"]);
        assert.deepEqual(await readdir(cwd), files);
        assert.deepEqual(
          await Promise.all(
            files.map((file) => readFile(join(cwd, file), "utf8")),
          ),
          before,
        );
        assert.equal(resumed.state.planning.approvedPlanRef, undefined);
        assert.equal(resumed.state.coding.implementationRef, undefined);
        const processTerminal = await Promise.all(
          ["scout", "diagnosis"].map(async (stage) => {
            const receipt =
              resumed.state.planning.agentAttempts![stage].receipt!;
            const status = JSON.parse(
              await readFile(join(receipt.asyncDir, "status.json"), "utf8"),
            );
            assert.equal(status.processTerminal.state, "observed");
            assert(
              status.processTerminal.instances.every(
                (instance: { exitCode: number }) => instance.exitCode === 0,
              ),
            );
            return { stage, proof: status.processTerminal };
          }),
        );
        Object.assign(report, {
          processTerminal,
          status: "passed",
          diagnosisRef: resumed.state.planning.context.diagnosisRef,
          evidence,
          receipt: attempt.receipt,
          launch: attempt.launch,
          toolCalls: tools,
          subagents: attempt.launch.packageVersion,
          recovery:
            "durable evidence and exact public output reused without redispatch",
          limitations:
            "Real Scout/Diagnosis only; classifier scripted, no live Jev, command-based reproduction, Planner/Worker or actual Human Gates. Read-only tools are not an OS sandbox.",
        });
      } catch (error) {
        report.error = error instanceof Error ? error.message : String(error);
        if (error instanceof Error && error.cause instanceof Error)
          report.cause = error.cause.message;
      }
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      ctx.ui.notify(
        `Diagnosis smoke ${String(report.status)}: ${reportPath}`,
        report.status === "passed" ? "info" : "error",
      );
    },
  });
}
