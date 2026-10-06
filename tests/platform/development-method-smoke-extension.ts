// Opt-in actual root questionnaire, Planner/Simplicity and Plannotator UI. Never approve or launch a Worker.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createWorkflowCommandRuntime,
  disposeWorkflowContinuations,
} from "../../src/commands/index.ts";
import { registerWorkflowOwnership } from "../../src/runtime/integrations/workflow-ownership.ts";
import { physicalModelSnapshot } from "../../src/runtime/integrations/subagent-launch.ts";
import {
  AskUserQuestionIntegration,
  QUESTION_REQUEST_EVENT,
} from "../../src/runtime/integrations/ask-user-question.ts";
import { PLANNOTATOR_REQUEST_CHANNEL } from "../../src/runtime/integrations/plannotator.ts";
import { ArtifactStore } from "../../src/runtime/persistence/artifact-store.ts";
import { parsePlan } from "../../src/runtime/planning/plan-parser.ts";
import { FakeJevDecisionClient } from "../fakes/index.ts";
import { configuration } from "../fakes/coding-scenario.ts";
import { jevPolicy } from "../fakes/jev-policy.ts";
import { isRecord } from "../../src/core/schema.ts";

export default function (pi: ExtensionAPI) {
  const ownership = registerWorkflowOwnership(pi);
  const questionnaire = new AskUserQuestionIntegration(pi.events);
  let reportPath = "";
  const questions: unknown[] = [];
  const gates: unknown[] = [];
  const report: Record<string, unknown> = {
    status: "not-started",
    questions,
    gates,
  };
  pi.on("project_trust", () => ({ trusted: "yes", remember: false }));
  pi.events.on(QUESTION_REQUEST_EVENT, (value) => {
    if (reportPath) questions.push(value);
  });
  pi.events.on(PLANNOTATOR_REQUEST_CHANNEL, (value) => {
    if (!reportPath || !isRecord(value)) return;
    gates.push({
      action: value.action,
      requestId: value.requestId,
    });
    if (value.action === "plan-review") {
      // Public Gate still opens. Stop only this fixture's automatic continuation before any approval could dispatch.
      disposeWorkflowContinuations(pi.events);
    }
  });
  pi.on("session_shutdown", () => disposeWorkflowContinuations(pi.events));
  pi.registerCommand("development-method-smoke", {
    description:
      "Issue #45: actual Human STANDARD/TDD choice and mandatory real Plan Gate; no implementation",
    async handler(path, ctx) {
      assert.equal(process.env.HERDR_ENV, "1");
      assert.equal(VERSION, "0.99.1");
      assert.equal(ctx.mode, "tui");
      assert(ctx.cwd.includes("pi-orchestrator-clarification-"));
      assert(ctx.model);
      assert(
        pi.getAllTools().some((tool) => tool.name === "ask_user_question"),
      );
      reportPath = path.trim();
      const save = () =>
        writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
      const profile = { provider: ctx.model.provider, model: ctx.model.id };
      const classifier = new FakeJevDecisionClient({
        stages: {
          research: "SKIP",
          clarification: "SKIP",
          architecture: "SKIP",
        },
        method: "STANDARD",
      });
      const classify = classifier.routeDevelopmentMethod.bind(classifier);
      classifier.routeDevelopmentMethod = async (input, authorization) => ({
        ...(await classify(input, authorization)),
        confidence: 0.6,
      });
      const runtime = createWorkflowCommandRuntime(pi.events, ctx.cwd, {
        ownership: ownership(ctx),
        humanQuestionPort: {
          rootSessionId: ctx.sessionManager.getSessionId(),
          projectRoot: ctx.cwd,
          ask: (id, frontier, signal) =>
            questionnaire.ask(id, frontier, signal),
        },
        configuration: {
          ...configuration,
          executionProfiles: {
            ECONOMY: profile,
            STANDARD: profile,
            STRONG: profile,
          },
          jev: jevPolicy(ctx.cwd, 6),
        },
        jevDecisionClient: classifier,
        projectTrusted: ctx.isProjectTrusted(),
        launchHost: {
          sessionId:
            ctx.sessionManager.getSessionFile() ??
            ctx.sessionManager.getSessionId(),
          projectTrusted: ctx.isProjectTrusted(),
          availableModels: physicalModelSnapshot(ctx.modelRegistry),
          parentModel: ctx.model,
          scopedModelIds: ctx.scopedModels.map(
            ({ model }) => `${model.provider}/${model.id}`,
          ),
          runtimeSnapshotHost: pi,
        },
      });
      Object.assign(report, {
        status: "running",
        startedAt: new Date().toISOString(),
        rootSessionId: ctx.sessionManager.getSessionId(),
        model: `${ctx.model.provider}/${ctx.model.id}`,
        herdrTab: process.env.HERDR_TAB_ID,
        herdrPane: process.env.HERDR_PANE_ID,
      });
      await save();
      try {
        const result = await runtime.start({
          playbook: "feature",
          task: "Review-only disposable smoke, not implementation. Preserve source.ts exports sourceMustNotChange=true without editing it. All scope/requirements are settled; no clarification or external research. The Orchestrator will ask the Human to choose STANDARD or TDD; obey that durable method exactly. Propose a minimal Plan with Scope / Requirements, Implementation Approach, Expected Change Surface, New Components (none), New Dependencies (none), Non-goals, Development Method, and a Validation Contract with command true, cwd ., required true, timeoutMs 1000. For TDD include explicit Test Seams: public sourceMustNotChange export remains true, no dependencies to control, regression assertion of that observable public export. No changes, dependencies, components, documentation or Worker execution are requested.",
        });
        const state = await runtime.loadState(result.workflowId);
        assert.equal(
          state.phase,
          "awaiting-plan-review",
          JSON.stringify(state.block),
        );
        assert(state.planning.planReview);
        assert.equal(state.planning.approvedPlanRef, undefined);
        assert.equal(state.coding.workerAttemptRef, undefined);
        const store = new ArtifactStore(result.runDirectory);
        const selection = JSON.parse(
          await store.readText(state.planning.developmentMethodSelectionRef!),
        );
        assert.equal(selection.status, "answered");
        assert.equal(
          selection.rootSessionId,
          ctx.sessionManager.getSessionId(),
        );
        const selectedMethod = Object.values(selection.reply.answers)[0];
        assert(selectedMethod === "STANDARD" || selectedMethod === "TDD");
        assert.equal(
          parsePlan(await store.readText(state.planning.currentPlanRef!))
            .developmentMethod,
          selectedMethod,
        );
        assert.equal(questions.length, 1);
        assert.equal(
          await readFile(join(ctx.cwd, "source.ts"), "utf8"),
          "export const sourceMustNotChange = true;\n",
        );
        Object.assign(report, {
          status: "passed",
          finishedAt: new Date().toISOString(),
          workflowId: state.workflowId,
          selectedMethod,
          selectionRef: state.planning.developmentMethodSelectionRef,
          methodRef: state.planning.developmentMethodRef,
          planRef: state.planning.currentPlanRef,
          planGate: state.planning.planReview,
          agentAttempts: state.planning.agentAttempts,
          sessionFile: ctx.sessionManager.getSessionFile(),
          limitations:
            "Controlled classifier STANDARD/0.6 (no live Jev); actual Scout/Planner/Simplicity, root Human choice and real pending Plannotator Plan UI. Continuation deliberately detached at Gate; no Plan/Code approval or Worker.",
        });
        ctx.ui.notify(`Development Method smoke passed: ${reportPath}`, "info");
      } catch (error) {
        Object.assign(report, { status: "failed", error: String(error) });
        ctx.ui.notify(String(error), "error");
      } finally {
        disposeWorkflowContinuations(pi.events);
        await save();
      }
    },
  });
}
