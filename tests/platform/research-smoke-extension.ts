import assert from "node:assert/strict";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  getAgentDir,
  VERSION,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { agentLaunchPolicy } from "../../src/core/agent-launch.ts";
import { isRecord } from "../../src/core/schema.ts";
import { subagentRunId } from "../../src/types.ts";
import { physicalModelSnapshot } from "../../src/runtime/integrations/subagent-launch.ts";
import {
  SubagentsIntegration,
  SUBAGENT_RPC_REQUEST_EVENT,
} from "../../src/runtime/integrations/subagents.ts";
import {
  ArtifactStore,
  calculateSha256,
} from "../../src/runtime/persistence/artifact-store.ts";
import { StateStore } from "../../src/runtime/persistence/state-store.ts";
import { createWorkflow } from "../../src/runtime/orchestrator/start-workflow.ts";
import { driveWorkflow } from "../../src/runtime/orchestrator/drive-workflow.ts";
import { resumeWorkflow } from "../../src/runtime/orchestrator/resume-workflow.ts";
import { FakeJevDecisionClient } from "../fakes/index.ts";
import { configuration as defaults } from "../fakes/coding-scenario.ts";
import { jevPolicy } from "../fakes/jev-policy.ts";
import { KETCH_REPOSITORY, KETCH_REVISION } from "./research-fixture.ts";

/** Opt-in real Pi/Research test in a new Herdr tab. Never invokes a classifier or a Worker. */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("research-smoke", {
    description: "Issue #6 Git-distributed Research integration smoke",
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
        assert(
          basename(root).startsWith("pi-orchestrator-research-"),
          "Disposable researchFixture required",
        );
        const source = JSON.parse(
          await readFile(join(root, "source.json"), "utf8"),
        );
        assert.equal(source.repository, KETCH_REPOSITORY);
        assert.equal(source.revision, KETCH_REVISION);
        const cwd = join(root, "project");
        assert.equal(ctx.cwd, cwd);
        const before = await readFile(join(cwd, "README.md"), "utf8");
        const workflowId = `research-smoke-${Date.now()}`;
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
        const url = `https://raw.githubusercontent.com/minorunakamura/pi-ketch/${KETCH_REVISION}/README.md`;
        const created = await createWorkflow(
          {
            task: `Read-only integration probe, NOT an implementation task. Scout: inspect only README.md in this disposable workspace and return under 1200 characters. Research: make exactly one ketch_scrape call with url ${url}, maxChars:4000, trim:false. Do not search, query docs/code, use other URLs, or retry. Report whether the public document names pi-ketch/search and pi-ketch.researcher; cite this URL and return under 1800 characters. Report any retrieval failure as a gap, never invent contents. No file writes, product decisions, Plan approval or implementation.`,
            playbook: "feature",
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
        const researchPolicy = agentLaunchPolicy("pi-ketch.researcher");
        const probe = {
          agent: researchPolicy.agent,
          task: "Preflight only",
          cwd,
          inputRefs: [created.taskRef],
          launchPolicy: researchPolicy,
          dispatch: {
            requestId: "preflight",
            ownerRunId: workflowId,
            nodeId: "research-preflight",
            deadline: new Date(Date.now() + 120000).toISOString(),
          },
          onStarted: async () => {},
        };
        await assert.rejects(
          adapter.preflight({
            ...probe,
            launchPolicy: {
              ...researchPolicy,
              requiredTools: ["read"],
              inheritProjectContext: true,
            },
          }),
        );
        const preflight = await adapter.preflight(probe);
        assert.deepEqual(preflight.tools, [
          "ketch_code",
          "ketch_docs",
          "ketch_scrape",
          "ketch_search",
        ]);
        assert.equal(preflight.inheritProjectContext, false);
        assert.equal(preflight.inheritGlobalContext, false);
        assert.equal(preflight.source, "package");
        assert.equal(
          preflight.sourceDigest,
          calculateSha256(join(source.source, "agents/researcher.md")),
        );
        assert.deepEqual(spawns, []);
        Object.assign(report, {
          source,
          preflight,
          progress: "preflight-passed",
        });
        await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

        // Scripted decisions force the bounded path; they still reserve through real authorization/State persistence.
        const classifier = new FakeJevDecisionClient({
          stages: { research: "RUN", clarification: "RUN" },
          mode: "GRILL_ME",
        });
        const deps = {
          artifactStore: store,
          stateStore: states,
          loadState: () => states.loadState(),
          subagentExecutor: adapter,
          cwd,
          configuration: {
            ...defaults,
            jev: jevPolicy(cwd, 3),
          },
          jevDecisionClient: classifier,
        };
        const result = await driveWorkflow(created.workflowId, deps);
        Object.assign(report, {
          progress: "driver-returned",
          phase: result.state.phase,
          block: result.state.block,
          spawns,
        });
        assert.equal(
          result.status,
          "pending",
          JSON.stringify(result.state.block),
        );
        assert.equal(result.state.phase, "clarifying");
        assert.deepEqual(spawns, ["workflow-scout", "pi-ketch.researcher"]);
        const ref = result.state.planning.context.researchRef!;
        assert(ref);
        const output = await store.readText(ref);
        assert(output.includes("pi-ketch/search"));
        assert(output.includes("pi-ketch.researcher"));
        assert(output.includes(url));
        const attempt = result.state.planning.agentAttempts!.research;
        assert(attempt.receipt && attempt.launch);
        assert.equal(
          attempt.receipt.launchContractDigest,
          attempt.launch.launchContractDigest,
        );
        assert.equal(attempt.launch.sourceDigest, preflight.sourceDigest);
        assert.equal(
          attempt.launch.definitionDigest,
          preflight.definitionDigest,
        );
        const recovered = await new SubagentsIntegration(events, {
          cwd,
          launchHost: host,
          artifactReader: store,
        }).status(subagentRunId(attempt.receipt.runId), attempt.receipt);
        assert.equal(recovered.status, "succeeded");
        assert(recovered.result?.status === "succeeded");
        assert.equal(recovered.result.output, output);
        const records: unknown[] = (
          await readFile(join(attempt.receipt.asyncDir, "events.jsonl"), "utf8")
        )
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        // Public child Pi events are mirrored in events.jsonl; no private runner module is imported.
        const toolStarts = records.filter(
          (event) => isRecord(event) && event.type === "tool_execution_start",
        );
        const toolEnds = records.filter(
          (event) => isRecord(event) && event.type === "tool_execution_end",
        );
        assert.equal(
          toolStarts.length,
          1,
          "Expected exactly one real Ketch tool invocation",
        );
        assert(
          isRecord(toolStarts[0]) && toolStarts[0].toolName === "ketch_scrape",
        );
        assert(isRecord(toolStarts[0].args) && toolStarts[0].args.url === url);
        assert(
          toolEnds.some(
            (event) =>
              isRecord(event) &&
              event.toolName === "ketch_scrape" &&
              event.isError === false,
          ),
        );
        assert.equal(await readFile(join(cwd, "README.md"), "utf8"), before);
        assert.deepEqual(await readdir(cwd), ["README.md"]);
        assert.equal(result.state.planning.approvedPlanRef, undefined);
        assert.equal(result.state.planning.currentPlanRef, undefined);
        assert.equal(result.state.coding.implementationRef, undefined);
        const calls = classifier.calls.routeStage.length;
        // Simulate interruption after Research/decision persistence, before the Human wait transition.
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
        assert.deepEqual(spawns, ["workflow-scout", "pi-ketch.researcher"]);
        Object.assign(report, {
          status: "passed",
          progress: "complete",
          source,
          runDirectory,
          researchRef: ref,
          output,
          launch: attempt.launch,
          receipt: attempt.receipt,
          toolExecution: { starts: toolStarts, successes: toolEnds.length },
          recovery:
            "exact receipt/output matched; fresh decisions reused without redispatch",
          subagents: attempt.launch.packageVersion,
          limitations:
            "Live Scout/Research and one public Ketch scrape only. Classifier scripted (zero network classifier calls); no root Human bridge, document writes, Planner, Worker or actual Human Gates.",
        });
      } catch (error) {
        report.error = error instanceof Error ? error.message : String(error);
        if (error instanceof Error && error.cause instanceof Error)
          report.cause = error.cause.message;
      }
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      ctx.ui.notify(
        `Research smoke ${String(report.status)}: ${reportPath}`,
        report.status === "passed" ? "info" : "error",
      );
    },
  });
}
