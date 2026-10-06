// Opt-in real Main/Planner + actual Human UI; interruption uses public Pi hooks.
// oxlint-disable eslint/no-await-in-loop
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  VERSION,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { registerWorkflowOwnership } from "../../src/runtime/integrations/workflow-ownership.ts";
import { registerClarificationBridge } from "../../src/runtime/integrations/clarification.ts";
import { physicalModelSnapshot } from "../../src/runtime/integrations/subagent-launch.ts";
import {
  createWorkflowCommandRuntime,
  registerWorkflowCommands,
  disposeWorkflowContinuations,
} from "../../src/commands/index.ts";
import { createWorkflow } from "../../src/runtime/orchestrator/start-workflow.ts";
import { PlanningOrchestrator } from "../../src/runtime/orchestrator/planning-orchestrator.ts";
import { StateStore } from "../../src/runtime/persistence/state-store.ts";
import { ArtifactStore } from "../../src/runtime/persistence/artifact-store.ts";
import { clarificationAnswerHistory } from "../../src/runtime/orchestrator/clarification.ts";
import { QUESTION_REQUEST_EVENT } from "../../src/runtime/integrations/ask-user-question.ts";
import { PLANNOTATOR_REQUEST_CHANNEL } from "../../src/runtime/integrations/plannotator.ts";
import { FakeJevDecisionClient, FakeSubagentExecutor } from "../fakes/index.ts";
import { configuration } from "../fakes/coding-scenario.ts";
import { jevPolicy } from "../fakes/jev-policy.ts";
import { subagentRunId } from "../../src/types.ts";
import { isRecord } from "../../src/core/schema.ts";

function config(ctx: ExtensionCommandContext) {
  assert(ctx.model);
  const profile = { provider: ctx.model.provider, model: ctx.model.id };
  return {
    ...configuration,
    executionProfiles: { ECONOMY: profile, STANDARD: profile, STRONG: profile },
    jev: jevPolicy(ctx.cwd, 6),
  };
}

export default function (pi: ExtensionAPI) {
  const id = "clarification-recovery-live";
  let reportPath = "";
  let interrupted = false;
  let resetTranscript = false;
  const questionRequests: unknown[] = [];
  const report: Record<string, unknown> = {
    status: "not-started",
    questionRequests,
  };
  const save = () =>
    writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  pi.on("project_trust", () => ({ trusted: "yes", remember: false }));
  // Strip the first resumed request's transcript BEFORE production restoration.
  // Pi restores system/tool declarations; the bridge must supply request + answers.
  pi.on("context", () => {
    if (!resetTranscript) return undefined;
    resetTranscript = false;
    report.transcriptReset = true;
    return { messages: [] };
  });
  const ownership = registerWorkflowOwnership(pi);
  const bridge = registerClarificationBridge(pi, ownership);
  const classifier = new FakeJevDecisionClient({
    stages: { research: "SKIP", clarification: "RUN", architecture: "SKIP" },
    mode: "GRILL_ME",
  });
  const runtime = (ctx: ExtensionCommandContext) =>
    createWorkflowCommandRuntime(pi.events, ctx.cwd, {
      ownership: ownership(ctx),
      clarificationPort: bridge(ctx),
      configuration: config(ctx),
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
      onContinuationError: (error) => {
        report.status = "failed";
        report.error = String(error);
        void save();
        ctx.ui.notify(String(error), "error");
      },
    });
  registerWorkflowCommands(pi, { createRuntime: runtime });
  pi.events.on(QUESTION_REQUEST_EVENT, (value) => {
    questionRequests.push(value);
  });
  // Real Plan generation, but this fixture Gate is pending only, never approval.
  pi.events.on(PLANNOTATOR_REQUEST_CHANNEL, (value) => {
    if (!isRecord(value) || typeof value.respond !== "function") return;
    if (value.action === "plan-review")
      value.respond({
        status: "handled",
        result: { status: "pending", reviewId: "recovery-smoke-plan" },
      });
    else if (value.action === "review-status")
      value.respond({ status: "handled", result: { status: "pending" } });
  });
  pi.on("tool_result", async (event, ctx) => {
    if (
      !reportPath ||
      interrupted ||
      event.toolName !== "wf_clarification_round" ||
      event.isError
    )
      return;
    const state = await new StateStore(
      join(ctx.cwd, ".pi", "orchestrator", "runs", id),
    ).loadState();
    const store = new ArtifactStore(
      join(ctx.cwd, ".pi", "orchestrator", "runs", id),
    );
    const history = await clarificationAnswerHistory(state, {
      artifactStore: store,
      stateStore: new StateStore(store.rootDirectory),
    });
    if (history.length !== 2) return;
    interrupted = true;
    resetTranscript = true;
    report.status = "awaiting-explicit-resume";
    report.interruption =
      "public ctx.abort() after two State-bound Human answers; transport outage not injected";
    report.historyBefore = history;
    report.requestRef = state.planning.clarificationRequestRef;
    report.progressBefore = state.planning.clarificationProgressRef;
    await save();
    ctx.abort();
  });
  pi.on("context", (event) => {
    if (!interrupted) return;
    const restored = event.messages.find(
      (message) =>
        message.role === "custom" &&
        message.customType === "orchestrator-clarification-context",
    );
    if (restored?.role === "custom" && typeof restored.content === "string")
      report.restoredContext = restored.content;
  });
  pi.registerCommand("clarification-recovery-smoke", {
    description:
      "Issue #42: two Human rounds, interrupted Main, explicit /wf-resume and mandatory Plan wait",
    async handler(path, ctx) {
      assert.equal(process.env.HERDR_ENV, "1");
      assert.equal(VERSION, "0.99.1");
      assert.equal(ctx.mode, "tui");
      assert(ctx.cwd.includes("pi-orchestrator-clarification-"));
      reportPath = path;
      Object.assign(report, {
        status: "running",
        startedAt: new Date().toISOString(),
        herdrTab: process.env.HERDR_TAB_ID,
        herdrPane: process.env.HERDR_PANE_ID,
        workflowId: id,
        rootSessionId: ctx.sessionManager.getSessionId(),
        model: `${ctx.model?.provider}/${ctx.model?.id}`,
      });
      await save();
      const directory = join(ctx.cwd, ".pi", "orchestrator", "runs", id);
      const artifactStore = new ArtifactStore(directory),
        stateStore = new StateStore(directory);
      const scout = new FakeSubagentExecutor({
        run: {
          type: "result",
          value: {
            status: "succeeded",
            runId: subagentRunId("recovery-fixture-scout"),
            output:
              "Disposable source.ts exports sourceMustNotChange=true. All environment facts are supplied. No implementation requested. Only two Human choices: preserve the existing boundary; then choose the domain term Order or Request. No other decisions, documents or dependencies are required.",
          },
        },
      });
      const owner = ownership(ctx);
      const created = await owner.start(() =>
        createWorkflow(
          {
            cwd: ctx.cwd,
            playbook: "feature",
            developmentIntent: "BEHAVIOR_FREE",
            task: "Recovery smoke only, no implementation. Use GRILL_ME. Round 1: ask exactly one question to preserve the existing implementation boundary (recommend preservation). Round 2, only after preservation is answered: ask exactly one question to choose the term Order or Request (recommend Order). These are the ONLY unresolved decisions. Do not combine both rounds. After both answers, confirm shared understanding through wf_clarification_complete without re-asking settled questions. Do not write documents. Planner afterward: minimal review-only Plan, STANDARD, all required strategy sections, no new components/dependencies, command check true, cwd ., required true, timeoutMs 1000. Human Plan/Code approval and implementation are out of scope.",
          },
          {
            runsDirectory: owner.runsDirectory,
            workflowIdFactory: () => id,
            artifactStore,
            stateStore,
            subagentExecutor: scout,
          },
        ),
      );
      const initial = await owner.initialize(created.state, stateStore);
      await new PlanningOrchestrator({
        artifactStore,
        stateStore,
        subagentExecutor: scout,
        configuration: config(ctx),
        jevDecisionClient: classifier,
      }).gatherContext({ state: initial, cwd: ctx.cwd });
      const waiting = await runtime(ctx).resume(id);
      assert.equal(waiting.state.phase, "clarifying");
    },
  });
  pi.registerCommand("clarification-recovery-audit", {
    description:
      "Audit real recovery after final confirmation and Planner; no approval inferred",
    async handler(args, ctx) {
      // Reopen only the same persisted fixture UUID; never adopt another root.
      if (!reportPath) {
        reportPath = args.trim();
        const checkpoint: unknown = JSON.parse(
          await readFile(reportPath, "utf8"),
        );
        assert(isRecord(checkpoint));
        assert.equal(
          checkpoint.rootSessionId,
          ctx.sessionManager.getSessionId(),
        );
        Object.assign(report, checkpoint);
      }
      const directory = join(ctx.cwd, ".pi", "orchestrator", "runs", id);
      const state = await new StateStore(directory).loadState();
      assert.equal(
        state.phase,
        "awaiting-plan-review",
        JSON.stringify(state.block),
      );
      assert(state.planning.planReview);
      assert.equal(state.planning.approvedPlanRef, undefined);
      assert.equal(state.coding.implementationRef, undefined);
      const mainCalls = ctx.sessionManager
        .getEntries()
        .flatMap((entry) =>
          entry.type === "message" && entry.message.role === "assistant"
            ? entry.message.content.filter((part) => part.type === "toolCall")
            : [],
        );
      assert.equal(
        mainCalls.filter((call) => call.name === "wf_clarification_round")
          .length,
        2,
      );
      assert.equal(
        mainCalls.filter((call) => call.name === "wf_clarification_complete")
          .length,
        1,
      );
      assert.equal(
        mainCalls.length,
        3,
        "Only two frontier questions + one final confirmation",
      );
      if (typeof report.restoredContext === "string") {
        assert.equal(report.transcriptReset, true);
        const restored = report.restoredContext;
        assert(
          restored.includes(state.planning.clarificationRequestRef!.sha256),
        );
        assert(
          restored.includes('"round":1') && restored.includes('"round":2'),
        );
      } else {
        report.transientContextEvidence =
          "Not retained across fixture process restart; empty-transcript restoration is independently covered by context-hook regression tests.";
      }
      report.mainCalls = mainCalls;
      report.modelAtAudit = `${ctx.model?.provider}/${ctx.model?.id}`;
      report.sessionFileAtAudit = ctx.sessionManager.getSessionFile();
      const store = new ArtifactStore(directory);
      const completion = JSON.parse(
        await store.readText(state.planning.context.clarificationRef!),
      );
      assert.equal(completion.status, "completed");
      assert.equal(Object.values(completion.reply.answers)[0], "Confirm");
      assert.equal(
        await readFile(join(ctx.cwd, "source.ts"), "utf8"),
        "export const sourceMustNotChange = true;\n",
      );
      Object.assign(report, {
        status: "passed",
        finishedAt: new Date().toISOString(),
        completionRef: state.planning.context.clarificationRef,
        planRef: state.planning.currentPlanRef,
        planGate: state.planning.planReview,
        planner: state.planning.agentAttempts?.["plan-v1"],
        limitations:
          "Actual Main/Planner, Human UI, abort and explicit same-root /wf-resume. Transport outage not injected; Scout/classifier and pending Plan Gate are fixtures. Request-local evidence may be unavailable after fixture process restart; do not infer an observed context snapshot. No Worker or Human Plan/Code approval.",
      });
      disposeWorkflowContinuations(pi.events);
      await save();
      ctx.ui.notify(`Recovery smoke passed: ${reportPath}`, "info");
    },
  });
  pi.on("session_shutdown", () => disposeWorkflowContinuations(pi.events));
}
