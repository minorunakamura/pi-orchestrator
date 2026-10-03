import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  VERSION,
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  registerClarificationBridge,
  CLARIFICATION_COMPLETE_EVENT,
} from "../../src/runtime/integrations/clarification.ts";
import {
  createWorkflowCommandRuntime,
  disposeWorkflowContinuations,
} from "../../src/commands/index.ts";
import { physicalModelSnapshot } from "../../src/runtime/integrations/subagent-launch.ts";
import { ArtifactStore } from "../../src/runtime/persistence/artifact-store.ts";
import { StateStore } from "../../src/runtime/persistence/state-store.ts";
import { createWorkflow } from "../../src/runtime/orchestrator/start-workflow.ts";
import { PlanningOrchestrator } from "../../src/runtime/orchestrator/planning-orchestrator.ts";
import { verifyClarificationDocuments } from "../../src/runtime/orchestrator/clarification.ts";
import { FakeJevDecisionClient, FakeSubagentExecutor } from "../fakes/index.ts";
import { configuration } from "../fakes/coding-scenario.ts";
import { jevPolicy } from "../fakes/jev-policy.ts";
import { subagentRunId } from "../../src/types.ts";
import { isRecord } from "../../src/core/schema.ts";
import { QUESTION_REQUEST_EVENT } from "../../src/runtime/integrations/ask-user-question.ts";
import { PLANNOTATOR_REQUEST_CHANNEL } from "../../src/runtime/integrations/plannotator.ts";
import { QUESTION_SOURCE_REVISION } from "./clarification-fixture.ts";

/** Actual root/Main + underlying skills + public questionnaire UI. Human answers must be entered by the operator. */
export default function (pi: ExtensionAPI) {
  const rootPort = registerClarificationBridge(pi);
  pi.registerCommand("clarification-smoke", {
    description:
      "Issue #8 both-mode root Human interaction smoke (no implementation)",
    async handler(reportPath, ctx) {
      assert.equal(process.env.HERDR_ENV, "1");
      assert.equal(VERSION, "0.99.1");
      assert.equal(ctx.mode, "tui");
      const root = dirname(getAgentDir());
      assert(root.includes("pi-orchestrator-clarification-"));
      const before = await readFile(join(ctx.cwd, "source.ts"), "utf8");
      const report: Record<string, unknown> = {
        status: "running",
        pi: VERSION,
        questionRevision: QUESTION_SOURCE_REVISION,
        startedAt: new Date().toISOString(),
        herdrTab: process.env.HERDR_TAB_ID,
        herdrPane: process.env.HERDR_PANE_ID,
        rootSessionId: ctx.sessionManager.getSessionId(),
        rootModel: `${ctx.model?.provider}/${ctx.model?.id}`,
        modes: [],
      };
      const save = () =>
        writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
      const modeReports: unknown[] = [];
      report.modes = modeReports;
      const questionRequests: unknown[] = [];
      const unsubscribeQuestion = pi.events.on(
        QUESTION_REQUEST_EVENT,
        (payload) => questionRequests.push(payload),
      );
      // The Plan Gate is a scripted pending public host contract, never an approval.
      const unsubscribeGate = pi.events.on(
        PLANNOTATOR_REQUEST_CHANNEL,
        (value) => {
          if (!isRecord(value) || typeof value.respond !== "function") return;
          const respond = value.respond;
          if (value.action === "plan-review")
            respond({
              status: "handled",
              result: {
                status: "pending",
                reviewId: `smoke-plan-${String(value.requestId)}`,
              },
            });
          else if (value.action === "review-status")
            respond({ status: "handled", result: { status: "pending" } });
        },
      );
      const modes = ["GRILL_ME", "GRILL_WITH_DOCS"] as const;
      let current: { id: string; store: ArtifactStore; states: StateStore };
      let ordinal = 0;
      const start = async () => {
        const mode = modes[ordinal];
        const id = `clarification-${mode.toLowerCase()}-${Date.now()}`;
        const directory = join(ctx.cwd, ".pi", "orchestrator", "runs", id);
        const store = new ArtifactStore(directory);
        const states = new StateStore(directory);
        current = { id, store, states };
        const classifier = new FakeJevDecisionClient({
          stages: {
            research: "SKIP",
            clarification: "RUN",
            architecture: "SKIP",
          },
          mode,
        });
        const config = { ...configuration, jev: jevPolicy(ctx.cwd, 6) };
        // Explicit fixture consent for sending authorized domain-document evidence, never an ambient grant.
        if (mode === "GRILL_WITH_DOCS")
          config.jev.runtimePolicy!.grant.evidenceCategories = [
            ...config.jev.runtimePolicy!.grant.evidenceCategories,
            "design",
          ];
        const scout = new FakeSubagentExecutor({
          run: {
            type: "result",
            value: {
              status: "succeeded",
              runId: subagentRunId("fixture-scout"),
              output:
                "Disposable clarification workspace. source.ts exports sourceMustNotChange=true. No implementation behavior is requested. All repository facts are supplied. The only unresolved Human decision is whether to preserve the existing boundary and call a customer request an Order. No dependency, test seam, scope or architecture ambiguity remains. CONTEXT.md is absent at start. No ADR is necessary (no hard-to-reverse trade-off).",
            },
          },
        });
        const created = await createWorkflow(
          {
            cwd: ctx.cwd,
            playbook: "feature",
            task: `Root Human clarification smoke, ${mode}, NOT implementation. Ask one frontier question to confirm preservation of the existing boundary and the term Order for a customer request. Recommend preservation. After the Human answers, confirm shared understanding explicitly using wf_clarification_complete. ${mode === "GRILL_WITH_DOCS" ? "Use domain-modeling; propose only CONTEXT.md with a short Order glossary, no implementation details or ADR. Human confirmation must authorize the exact content." : "Do not propose or write any documents."} No other facts or decisions are missing. The subsequent Planner should return a minimal review-only Plan with Scope / Requirements, Implementation Plan, and a Validation Contract containing a required command check, command true, cwd ., timeoutMs 1000. No implementation or approval.`,
          },
          {
            runsDirectory: join(ctx.cwd, ".pi", "orchestrator", "runs"),
            workflowIdFactory: () => id,
            artifactStore: store,
            stateStore: states,
            subagentExecutor: scout,
          },
        );
        await new PlanningOrchestrator({
          artifactStore: store,
          stateStore: states,
          subagentExecutor: scout,
          configuration: config,
          jevDecisionClient: classifier,
        }).gatherContext({ state: created.state, cwd: ctx.cwd });
        const clarificationPort = rootPort(ctx);
        report.rootTools = pi.getAllTools().map((tool) => tool.name);
        await clarificationPort.setup!(mode);
        const runtime = createWorkflowCommandRuntime(pi.events, ctx.cwd, {
          configuration: config,
          jevDecisionClient: classifier,
          clarificationPort,
          projectTrusted: ctx.isProjectTrusted(),
          launchHost: {
            sessionId: ctx.sessionManager.getSessionId(),
            projectTrusted: ctx.isProjectTrusted(),
            availableModels: physicalModelSnapshot(ctx.modelRegistry),
            parentModel: ctx.model,
            scopedModelIds: ctx.scopedModels.map(
              ({ model }) => `${model.provider}/${model.id}`,
            ),
            runtimeSnapshotHost: pi,
          },
          onContinuationError: async (error) => {
            report.status = "failed";
            report.error = String(error);
            await save();
            ctx.ui.notify(String(error), "error");
          },
        });
        const waiting = await runtime.resume(id);
        assert.equal(
          waiting.state.phase,
          "clarifying",
          JSON.stringify(waiting.state.block),
        );
        assert(waiting.state.planning.clarificationRequestRef);
        report.current = {
          mode,
          id,
          directory,
          requestRef: waiting.state.planning.clarificationRequestRef,
        };
        await save();
      };
      const unsubscribeComplete = pi.events.on(
        CLARIFICATION_COMPLETE_EVENT,
        (payload) => {
          if (!isRecord(payload) || payload.workflowId !== current?.id) return;
          void (async () => {
            // Wait for the real Planner's durable normal continuation, not an inferred approval.
            const deadline = Date.now() + 180000;
            let state = await current.states.loadState();
            while (
              !state.planning.planReview &&
              Date.now() < deadline &&
              state.phase !== "blocked" &&
              state.phase !== "failed"
            ) {
              // oxlint-disable-next-line eslint/no-await-in-loop
              await new Promise((resolve) => setTimeout(resolve, 250));
              // oxlint-disable-next-line eslint/no-await-in-loop
              state = await current.states.loadState();
            }
            assert.equal(
              state.phase,
              "awaiting-plan-review",
              JSON.stringify(state.block),
            );
            assert(state.planning.planReview);
            assert.equal(state.planning.approvedPlanRef, undefined);
            assert.equal(state.coding.implementationRef, undefined);
            assert.equal(
              await readFile(join(ctx.cwd, "source.ts"), "utf8"),
              before,
            );
            const completion = JSON.parse(
              await current.store.readText(
                state.planning.context.clarificationRef!,
              ),
            );
            assert.equal(completion.reply.status, "answered");
            assert.equal(completion.reply.cancelled, false);
            assert.equal(Object.values(completion.reply.answers)[0], "Confirm");
            await verifyClarificationDocuments(state, {
              artifactStore: current.store,
              stateStore: current.states,
            });
            const files = await readdir(ctx.cwd);
            if (modes[ordinal] === "GRILL_ME")
              assert(!files.includes("CONTEXT.md"));
            else assert(files.includes("CONTEXT.md"));
            modeReports.push({
              mode: modes[ordinal],
              workflowId: current.id,
              requestRef: state.planning.clarificationRequestRef,
              clarificationRef: state.planning.context.clarificationRef,
              documentRef: state.planning.domainDocumentWriteRef,
              finalConfirmation: completion.reply,
              planner: state.planning.agentAttempts?.["plan-v1"],
              planRef: state.planning.currentPlanRef,
              planGate: state.planning.planReview,
              questionRequests: questionRequests.splice(0),
            });
            ordinal++;
            if (ordinal < modes.length) await start();
            else {
              report.status = "passed";
              report.finishedAt = new Date().toISOString();
              report.limitations =
                "Actual root/Main model, skills, questionnaire UI/Human selections, domain writes, real Planner and normal continuation. Scout/stage classifier are scripted fixtures; no live Jev, actual Plannotator Human Gates, Worker or full-v1 completion. Narrow root tool ceiling is not an OS sandbox; #5 owns general active-workflow enforcement.";
              disposeWorkflowContinuations(pi.events);
              unsubscribeQuestion();
              unsubscribeGate();
              unsubscribeComplete();
              await save();
              ctx.ui.notify(
                `Both clarification modes passed: ${reportPath}`,
                "info",
              );
            }
          })().catch(async (error) => {
            report.status = "failed";
            report.error = String(error);
            await save();
            ctx.ui.notify(String(error), "error");
          });
        },
      );
      try {
        await start();
      } catch (error) {
        report.status = "failed";
        report.error = String(error);
        await save();
        ctx.ui.notify(String(error), "error");
      }
    },
  });
}
