import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
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
import { startWorkflow } from "../../src/runtime/orchestrator/start-workflow.ts";
import { PlanningOrchestrator } from "../../src/runtime/orchestrator/planning-orchestrator.ts";
import { CodingOrchestrator } from "../../src/runtime/orchestrator/coding-orchestrator.ts";
import { finishTddSmoke } from "./tdd-audit.ts";
import { FakeJevDecisionClient, FakeSubagentExecutor } from "../fakes/index.ts";
import { configuration, succeeded } from "../fakes/coding-scenario.ts";
import { jevPolicy } from "../fakes/jev-policy.ts";
import { isRecord } from "../../src/core/schema.ts";

/** Opt-in actual Human Plan Gate + builtin TDD Worker in a disposable Git fixture. */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("tdd-smoke-audit", {
    description:
      "Audit an already-completed TDD Worker and run remaining Validation; never redispatch",
    async handler(reportPath, ctx) {
      const previous = JSON.parse(await readFile(reportPath, "utf8"));
      const report = {
        ...previous,
        previousFailure: previous.error,
        status: "failed",
      };
      delete report.error;
      try {
        assert.equal(process.env.HERDR_ENV, "1");
        const root = dirname(getAgentDir());
        assert(basename(root).startsWith("pi-orchestrator-tdd-"));
        assert(
          typeof previous.runDirectory === "string" &&
            previous.runDirectory.startsWith(join(root, "runs") + "/"),
        );
        const store = new ArtifactStore(previous.runDirectory);
        const states = new StateStore(store.rootDirectory);
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
        let spawns = 0;
        const events = {
          on: (event: string, listener: (payload: unknown) => void) =>
            pi.events.on(event, listener),
          emit: (event: string, payload: unknown) => {
            if (event === SUBAGENT_RPC_REQUEST_EVENT) spawns++;
            pi.events.emit(event, payload);
          },
        };
        const adapter = new SubagentsIntegration(events, {
          cwd: ctx.cwd,
          launchHost: host,
          artifactReader: store,
        });
        Object.assign(
          report,
          await finishTddSmoke(store, states, adapter, ctx.cwd),
        );
        assert.equal(spawns, 0);
        report.auditRedispatches = spawns;
      } catch (error) {
        report.status = "failed";
        report.error = error instanceof Error ? error.message : String(error);
      }
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      ctx.ui.notify(
        `TDD audit ${report.status}: ${reportPath}`,
        report.status === "passed" ? "info" : "error",
      );
    },
  });
  pi.registerCommand("tdd-smoke", {
    description:
      "Issue #16 actual Human seam approval / TDD skill / vertical slices / Validation smoke",
    async handler(reportPath, ctx) {
      const report: Record<string, unknown> = {
        status: "failed",
        pi: VERSION,
        recordedAt: new Date().toISOString(),
        herdrTab: process.env.HERDR_TAB_ID,
        herdrPane: process.env.HERDR_PANE_ID,
      };
      const save = () =>
        writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      const fail = async (error: unknown) => {
        report.status = "failed";
        report.error = error instanceof Error ? error.message : String(error);
        if (error instanceof Error && error.cause instanceof Error)
          report.cause = error.cause.message;
        await save();
        ctx.ui.notify(`TDD smoke failed: ${reportPath}`, "error");
      };
      try {
        assert.equal(process.env.HERDR_ENV, "1");
        assert.equal(VERSION, "0.99.1");
        assert.equal(ctx.isProjectTrusted(), false);
        const root = dirname(getAgentDir());
        assert(
          basename(root).startsWith("pi-orchestrator-tdd-"),
          "Disposable TDD fixture required",
        );
        const cwd = ctx.cwd;
        const sourceBefore = await readFile(join(cwd, "greeting.mjs"), "utf8");
        const workflowId = `tdd-smoke-${Date.now()}`;
        const store = new ArtifactStore(join(root, "runs", workflowId));
        const states = new StateStore(store.rootDirectory);
        const plan = `# Disposable TDD Worker smoke Plan
## Scope / Requirements
Only in ${cwd}: implement greeting.mjs public greet(name), returning Hello, <trimmed name>! for the two approved observable cases. No repository source or operator settings may change.
## Implementation Plan
Read the selected upstream tdd and codebase-design guidance. Use two vertical slices: first unpadded name Ada, then whitespace-padded name. Write one test, run node --test greeting.test.mjs to observe RED, implement only that slice, rerun to observe GREEN; then the next slice. Preserve command exit codes, no || true. Edit only greeting.mjs and greeting.test.mjs; no dependencies, refactoring or commits.
## Development Method
TDD
## Test Seams
- Existing public greet(name) exported by greeting.mjs: greet('Ada') returns 'Hello, Ada!'; greet('  Ada  ') returns 'Hello, Ada!'. Tests import that public function using node:test and node:assert/strict. No private helpers/internal collaborator calls. No external dependencies need mocking.
## Do not test
- Private helpers/internal collaborator calls; no unapproved seams.
## Supporting Skills
codebase-design
## Validation Contract
\`\`\`orchestrator-validation
${JSON.stringify({ schemaVersion: 1, checks: [{ id: "public-greeting-tests", type: "command", command: "node --test greeting.test.mjs", cwd, required: true, timeoutMs: 10000 }] })}
\`\`\`
`;
        const scripted = new FakeSubagentExecutor({
          run: [
            succeeded(
              "Fixture facts: greeting.mjs exists with an unimplemented public greet(name); no tests/dependencies. Human requests TDD. No architecture/scope decisions remain.",
            ),
            succeeded(plan),
          ],
        });
        const config = {
          ...configuration,
          jev: jevPolicy(cwd, 10),
          executionProfiles: {
            ECONOMY: { provider: "openai", model: "gpt-6.1-sol" },
            STANDARD: { provider: "openai", model: "gpt-6.1-sol" },
            STRONG: { provider: "openai", model: "gpt-6.1-sol" },
          },
        };
        const jev = new FakeJevDecisionClient({
          routeExecution: {
            type: "result",
            value: {
              modelTier: { value: "STANDARD", confidence: 0.99 },
              reasoningTier: { value: "MEDIUM", confidence: 0.99 },
            },
          },
        });
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
              isRecord(payload.params)
            )
              spawns.push(String(payload.params.agent));
            pi.events.emit(event, payload);
          },
        };
        report.spawns = spawns;
        const adapter = new SubagentsIntegration(events, {
          cwd,
          launchHost: host,
          artifactReader: store,
        });
        const gate = new PlannotatorIntegration({ events, planReader: store });
        const deps = {
          artifactStore: store,
          stateStore: states,
          subagentExecutor: scripted,
          configuration: config,
          jevDecisionClient: jev,
          cwd,
        };
        const started = await startWorkflow(
          {
            task: "Explicit Human TDD Worker smoke only in this disposable fixture.",
            developmentIntent: "TDD",
            playbook: "feature",
            cwd,
          },
          {
            ...deps,
            runsDirectory: join(root, "runs"),
            workflowIdFactory: () => workflowId,
          },
        );
        const planning = new PlanningOrchestrator(deps);
        const created = await planning.createPlan({
          state: started.state,
          cwd,
        });
        assert.equal(created.parsedPlan.developmentMethod, "TDD");
        assert(created.parsedPlan.testSeams?.includes("public greet(name)"));
        assert.equal(jev.calls.routeDevelopmentMethod.length, 0);
        assert.equal(
          await readFile(join(cwd, "greeting.mjs"), "utf8"),
          sourceBefore,
        );
        assert.deepEqual(spawns, []);
        const productionPlanning = new PlanningOrchestrator({
          ...deps,
          plannotatorGate: gate,
        });
        let active = false;
        const continueFromGate = async () => {
          if (active) return;
          const state = await states.loadState();
          if (
            state.phase !== "awaiting-plan-review" ||
            !state.planning.planReview
          )
            return;
          active = true;
          try {
            const reviewed = await productionPlanning.reconcilePlanReview({
              state,
              reviewId: state.planning.planReview.reviewId,
            });
            if (reviewed.status === "pending") {
              active = false;
              return;
            }
            assert.equal(
              reviewed.status,
              "approved",
              "Actual Human must approve the exact Plan and Test Seams; no proxy answers",
            );
            assert.deepEqual(
              reviewed.state.planning.approvedPlanRef,
              created.planRef,
            );
            report.status = "running-worker";
            await save();
            const result = await new CodingOrchestrator({
              ...deps,
              subagentExecutor: adapter,
              repositoryCwd: cwd,
            }).execute({ state: reviewed.state, cwd });
            assert.equal(result.state.phase, "validating");
            assert.deepEqual(spawns, ["worker"]);
            Object.assign(
              report,
              await finishTddSmoke(store, states, adapter, cwd),
            );
            unsubscribe();
            await save();
            ctx.ui.notify(`TDD smoke passed: ${reportPath}`, "info");
          } catch (error) {
            unsubscribe();
            await fail(error);
          }
        };
        const unsubscribe = pi.events.on("plannotator:review-result", () => {
          void continueFromGate();
        });
        const opened = await productionPlanning.openPlanReview({
          state: created.state,
        });
        assert.equal(opened.status, "opened");
        report.status = "awaiting-human-plan-review";
        report.runDirectory = store.rootDirectory;
        report.planRef = created.planRef;
        report.reviewId = opened.state.planning.planReview!.reviewId;
        await save();
        ctx.ui.notify(
          "TDD smoke: approve the disposable fixture's exact TDD/Test Seams in the Plannotator browser. Worker has not started.",
          "info",
        );
        await continueFromGate();
      } catch (error) {
        await fail(error);
      }
    },
  });
}
