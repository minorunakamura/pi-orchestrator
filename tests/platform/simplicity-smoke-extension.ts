import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
import { PlannotatorIntegration } from "../../src/runtime/integrations/plannotator.ts";
import { ArtifactStore } from "../../src/runtime/persistence/artifact-store.ts";
import { StateStore } from "../../src/runtime/persistence/state-store.ts";
import { createWorkflow } from "../../src/runtime/orchestrator/start-workflow.ts";
import { driveWorkflow } from "../../src/runtime/orchestrator/drive-workflow.ts";
import { resumeWorkflow } from "../../src/runtime/orchestrator/resume-workflow.ts";
import { simplicityEvidence } from "../../src/runtime/orchestrator/plan-simplicity.ts";
import { FakeJevDecisionClient, FakeSubagentExecutor } from "../fakes/index.ts";
import { configuration, succeeded } from "../fakes/coding-scenario.ts";
import { jevPolicy } from "../fakes/jev-policy.ts";
import { isRecord } from "../../src/core/schema.ts";
import { subagentRunId } from "../../src/types.ts";
import type {
  AgentRunRequest,
  SubagentExecutor,
} from "../../src/runtime/ports/subagent-executor.ts";

const scriptedRequest = (input: AgentRunRequest) =>
  input.agent === "workflow-scout" || input.dispatch?.nodeId === "plan-v1";

/** Actual reviewers and refinement Planner; actual Plan UI pending, no implementation. */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("simplicity-smoke", {
    description:
      "Issue #14 read-only simplicity/refinement/Plan Gate/recovery smoke",
    async handler(reportPath, ctx) {
      const report: Record<string, unknown> = {
        status: "failed",
        pi: VERSION,
        startedAt: new Date().toISOString(),
        herdrTab: process.env.HERDR_TAB_ID,
        herdrPane: process.env.HERDR_PANE_ID,
      };
      try {
        assert.equal(process.env.HERDR_ENV, "1");
        assert.equal(VERSION, "0.99.1");
        const root = dirname(getAgentDir());
        assert(basename(root).startsWith("pi-orchestrator-simplicity-"));
        assert.equal(ctx.isProjectTrusted(), false);
        const cwd = ctx.cwd,
          before = await readFile(join(cwd, "greeting.mjs"), "utf8");
        const workflowId = `simplicity-smoke-${Date.now()}`;
        const store = new ArtifactStore(join(root, "runs", workflowId));
        const states = new StateStore(store.rootDirectory);
        const spawns: string[] = [],
          gateContents: string[] = [];
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
            if (
              event === "plannotator:request" &&
              isRecord(payload) &&
              payload.action === "plan-review" &&
              isRecord(payload.payload)
            )
              gateContents.push(String(payload.payload.planContent));
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
        const actual = new SubagentsIntegration(events, {
          cwd,
          launchHost: host,
          artifactReader: store,
          timeoutMs: 120000,
        });
        const candidate = `# Greeting strategy candidate
## Scope / Requirements
Only trim leading/trailing whitespace in public greet(name) before greeting. No implementation during planning.
## Implementation Approach
Introduce GreetingStrategy interface and a GreetingService class, then route greet(name) through a strategy instance for extensibility.
## Expected Change Surface
greeting.mjs plus a new greeting-service.mjs; a new public service abstraction.
## New Components
GreetingService class and GreetingStrategy interface, although only one greeting implementation is currently needed.
## New Dependencies
none
## Non-goals
Other behavior, configuration, commits and repository changes.
## Development Method
STANDARD
## Validation Contract
\`\`\`orchestrator-validation
${JSON.stringify({ schemaVersion: 1, checks: [{ id: "syntax", type: "command", command: "node --check greeting.mjs", cwd: ".", required: true, timeoutMs: 10000 }] })}
\`\`\`
`;
        const scripted = new FakeSubagentExecutor({
          run: [
            succeeded(
              "greeting.mjs:1 exports the existing public greet(name) extension point: export function greet(name) { return `Hello, ${name}!`; }. It already owns greeting formatting; trimming can be added inside this function. No other files or dependencies exist.",
            ),
            succeeded(candidate),
          ],
        });
        const executor: SubagentExecutor = {
          preflight: (input) =>
            scriptedRequest(input)
              ? scripted.preflight(input)
              : actual.preflight(input),
          run: (input) => {
            assert.notEqual(input.agent, "worker");
            return scriptedRequest(input)
              ? scripted.run(input)
              : actual.run(input);
          },
          runParallel: (inputs) => actual.runParallel(inputs),
          status: (id, receipt) => actual.status(id, receipt),
          resume: (id, task) => actual.resume(id, task),
        };
        const created = await createWorkflow(
          {
            task: "Read-only planning smoke, NOT implementation. Only trim greet(name) whitespace inside the existing public function. Prefer the existing extension point; no new service/interface/dependency is needed. Original candidate intentionally proposes unnecessary abstractions so the reviewer can cite durable Scout evidence. Refinement must be a minimal strategy preserving behavior, STANDARD and the supplied Validation Contract exactly. Emit required strategy sections, explicit none for components/dependencies. Keep candidate under 6000 characters. Reviewer must use supplied exact scout refs/excerpts and Plan sections. No file changes, State authority or approval.",
            playbook: "chore",
            developmentIntent: "BEHAVIOR_FREE",
            cwd,
          },
          {
            runsDirectory: join(root, "runs"),
            workflowIdFactory: () => workflowId,
            artifactStore: store,
            stateStore: states,
            subagentExecutor: executor,
          },
        );
        const deps = {
          artifactStore: store,
          stateStore: states,
          loadState: () => states.loadState(),
          subagentExecutor: executor,
          cwd,
          configuration: { ...configuration, jev: jevPolicy(cwd, 3) },
          jevDecisionClient: new FakeJevDecisionClient(),
          plannotatorGate: new PlannotatorIntegration({
            events,
            planReader: store,
          }),
        };
        const result = await driveWorkflow(created.workflowId, deps);
        Object.assign(report, {
          runDirectory: store.rootDirectory,
          phase: result.state.phase,
          block: result.state.block,
          spawns,
          gateContents,
        });
        assert.equal(
          result.state.phase,
          "awaiting-plan-review",
          JSON.stringify(result.state.block),
        );
        assert.equal(result.state.planning.automaticRefinementsUsed, 1);
        assert.equal(result.state.planning.currentPlanVersion, 2);
        assert.deepEqual(spawns, [
          "plan-simplicity-reviewer",
          "planner",
          "plan-simplicity-reviewer",
        ]);
        assert.equal(gateContents.length, 1);
        assert(gateContents[0].includes("Plan Simplicity Review"));
        assert.equal(result.state.planning.approvedPlanRef, undefined);
        assert.equal(result.state.coding.implementationRef, undefined);
        const first = JSON.parse(
          await readFile(
            join(store.rootDirectory, "plan-reviews/simplicity-v1.json"),
            "utf8",
          ),
        );
        assert(first.findings.length > 0);
        const review = await simplicityEvidence(result.state, deps);
        const resume = await resumeWorkflow(workflowId, {
          ...deps,
          runDirectory: store.rootDirectory,
          plannotatorGate: new PlannotatorIntegration({
            events,
            planReader: store,
          }),
        });
        assert.equal(resume.state.phase, "awaiting-plan-review");
        assert.equal(gateContents.length, 1);
        assert.equal(spawns.length, 3);
        const attempts = ["simplicity-v1", "plan-v2", "simplicity-v2"];
        const terminals = await Promise.all(
          attempts.map(async (stage) => {
            const attempt = resume.state.planning.agentAttempts![stage];
            assert(attempt.launch && attempt.receipt);
            assert.deepEqual(attempt.launch.tools, [
              ...(attempt.launch.agent === "plan-simplicity-reviewer"
                ? ["codemode"]
                : []),
              "find",
              "grep",
              "ls",
              "read",
            ]);
            const recovered = await actual.status(
              subagentRunId(attempt.receipt.runId),
              attempt.receipt,
            );
            assert.equal(recovered.status, "succeeded");
            const publicStatus = JSON.parse(
              await readFile(
                join(attempt.receipt.asyncDir, "status.json"),
                "utf8",
              ),
            );
            assert.equal(publicStatus.processTerminal.state, "observed");
            assert(
              publicStatus.processTerminal.instances.every(
                (instance: { exitCode: number }) => instance.exitCode === 0,
              ),
            );
            return {
              stage,
              receipt: attempt.receipt,
              launch: attempt.launch,
              processTerminal: publicStatus.processTerminal,
            };
          }),
        );
        assert.deepEqual(await readdir(cwd), ["greeting.mjs"]);
        assert.equal(await readFile(join(cwd, "greeting.mjs"), "utf8"), before);
        Object.assign(report, {
          status: "passed",
          finishedAt: new Date().toISOString(),
          firstFindings: first.findings,
          review,
          terminals,
          redispatches: 0,
          limitation:
            "Scout/original candidate/classifier scripted; actual read-only simplicity reviews and refinement Planner + actual Plannotator pending UI. Human has not approved; no Worker, live classifier, Code Gate or full lifecycle PASS.",
        });
      } catch (error) {
        report.error = error instanceof Error ? error.message : String(error);
      }
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      ctx.ui.notify(
        `Simplicity smoke ${String(report.status)}: ${reportPath}`,
        report.status === "passed" ? "info" : "error",
      );
    },
  });
}
