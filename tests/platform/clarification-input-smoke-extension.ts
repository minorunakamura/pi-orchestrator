// Opt-in real Main / Human / Planner; no Human answer or approval is synthesized.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { registerWorkflowOwnership } from "../../src/runtime/integrations/workflow-ownership.ts";
import { registerClarificationBridge } from "../../src/runtime/integrations/clarification.ts";
import { physicalModelSnapshot } from "../../src/runtime/integrations/subagent-launch.ts";
import {
  createWorkflowCommandRuntime,
  disposeWorkflowContinuations,
} from "../../src/commands/index.ts";
import { createWorkflow } from "../../src/runtime/orchestrator/start-workflow.ts";
import { PlanningOrchestrator } from "../../src/runtime/orchestrator/planning-orchestrator.ts";
import { StateStore } from "../../src/runtime/persistence/state-store.ts";
import { ArtifactStore } from "../../src/runtime/persistence/artifact-store.ts";
import { clarificationEvidence } from "../../src/runtime/orchestrator/clarification.ts";
import { PLANNOTATOR_REQUEST_CHANNEL } from "../../src/runtime/integrations/plannotator.ts";
import { FakeJevDecisionClient, FakeSubagentExecutor } from "../fakes/index.ts";
import { configuration } from "../fakes/coding-scenario.ts";
import { jevPolicy } from "../fakes/jev-policy.ts";
import { subagentRunId } from "../../src/types.ts";
import { isRecord } from "../../src/core/schema.ts";

const topics = [
  "Preserve the existing implementation boundary",
  "Keep the source.ts bytes unchanged",
  "Do not add runtime dependencies",
  "Do not add components",
  "Do not add public interfaces",
  "Do not add persistence",
  "Do not add authentication",
  "Do not add network services",
  "Do not add configuration files",
  "Do not add deployment integration",
  "Do not add build tools",
  "Do not add database integration",
  "Do not add assets",
  "Do not add mobile scope",
  "Do not add internationalization",
  "Do not add background jobs",
  "Keep this a review-only exercise",
  "Use STANDARD development method",
  "Use command true for review-only validation",
  "Require separate Human Plan approval before implementation",
];

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
  const id = "clarification-input-live";
  let reportPath = "";
  const report: Record<string, unknown> = { status: "not-started" };
  const save = () =>
    writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  pi.on("project_trust", () => ({ trusted: "yes", remember: false }));
  const ownership = registerWorkflowOwnership(pi);
  const bridge = registerClarificationBridge(pi, ownership);
  const classifier = new FakeJevDecisionClient({
    stages: { research: "SKIP", clarification: "RUN", architecture: "SKIP" },
    mode: "GRILL_ME",
  });
  pi.events.on(PLANNOTATOR_REQUEST_CHANNEL, (value) => {
    if (!isRecord(value) || typeof value.respond !== "function") return;
    if (value.action === "plan-review")
      value.respond({
        status: "handled",
        result: { status: "pending", reviewId: "long-input-plan" },
      });
    else if (value.action === "review-status")
      value.respond({ status: "handled", result: { status: "pending" } });
  });
  pi.registerCommand("clarification-input-smoke", {
    description:
      "Issue #49: actual Human five rounds and long final confirmation, then mandatory Plan wait",
    async handler(path, ctx) {
      assert.equal(process.env.HERDR_ENV, "1");
      assert.equal(ctx.mode, "tui");
      assert(ctx.cwd.includes("pi-orchestrator-clarification-"));
      reportPath = path.trim();
      Object.assign(report, {
        status: "running",
        startedAt: new Date().toISOString(),
        herdrTab: process.env.HERDR_TAB_ID,
        herdrPane: process.env.HERDR_PANE_ID,
        rootSessionId: ctx.sessionManager.getSessionId(),
        model: `${ctx.model?.provider}/${ctx.model?.id}`,
      });
      await save();
      const owner = ownership(ctx);
      const directory = join(owner.runsDirectory, id);
      const artifactStore = new ArtifactStore(directory),
        stateStore = new StateStore(directory);
      const scout = new FakeSubagentExecutor({
        run: {
          type: "result",
          value: {
            status: "succeeded",
            runId: subagentRunId("long-input-scout"),
            output:
              "Disposable source.ts exports sourceMustNotChange=true. Read-only review exercise only. Environment facts are known. Twenty independent explicit Human scope confirmations are listed in the Task. No changes or implementation requested. No other missing decisions.",
          },
        },
      });
      const created = await owner.start(() =>
        createWorkflow(
          {
            cwd: ctx.cwd,
            playbook: "feature",
            developmentIntent: "BEHAVIOR_FREE",
            task: `Long-input regression smoke only. No implementation or domain documents. Root MUST ask the following twenty scope decisions in exactly five wf_clarification_round calls, four questions each, in listed order. Each question must explain its specific boundary and offer Preserve / Change; recommend Preserve but accept actual Human choices. Do not synthesize answers or use prose questions. Topics: ${JSON.stringify(topics)}. After all twenty actual answers, call wf_clarification_complete with a detailed summary of 3000-4000 characters, preserving all confirmed choices with each boundary explained separately (no padding or repeated sentences). The long final confirmation intentionally tests the duplicated old completion envelope. No further decisions should be invented; if Human changes scope, make that explicit. After confirmation, Planner proposes a minimal review-only STANDARD Plan with required strategy sections, no components/dependencies and one Validation Contract command true, cwd ., required true, timeoutMs 1000. Both Human Gates are still required; approval and Worker are out of scope.`,
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
      await new PlanningOrchestrator({
        artifactStore,
        stateStore,
        subagentExecutor: scout,
        configuration: config(ctx),
        jevDecisionClient: classifier,
      }).gatherContext({
        state: await owner.initialize(created.state, stateStore),
        cwd: ctx.cwd,
      });
      const runtime = createWorkflowCommandRuntime(pi.events, ctx.cwd, {
        ownership: owner,
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
        onContinuationResult: (result) => {
          report.status = result.status;
          report.reason = result.reason;
          report.phase = result.phase;
          void save();
          ctx.ui.notify(
            `Workflow ${result.state.workflowId}: ${result.status} (${result.phase})${result.reason ? `: ${result.reason}` : ""}`,
            ["blocked", "failed"].includes(result.status) ? "warning" : "info",
          );
        },
      });
      assert.equal((await runtime.resume(id)).state.phase, "clarifying");
    },
  });
  pi.registerCommand("clarification-input-audit", {
    description:
      "Audit exact long-input completion / pending mandatory Plan Gate",
    async handler(_args, ctx) {
      assert(reportPath);
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
      const store = new ArtifactStore(directory),
        ref = state.planning.context.clarificationRef!;
      const original = await store.readText(ref);
      assert(
        original.length > 12000,
        "Real confirmation envelope must exceed the old limit",
      );
      const evidence = await clarificationEvidence(ref, store);
      const assembled = JSON.parse(evidence.content);
      assert.equal(assembled.confirmation, "confirmed-by-human");
      assert.equal(assembled.rounds.length, 5);
      assert.equal(
        assembled.rounds.flatMap(
          (round: { decisions: unknown[] }) => round.decisions,
        ).length,
        20,
      );
      assert.equal(
        await readFile(join(ctx.cwd, "source.ts"), "utf8"),
        "export const sourceMustNotChange = true;\n",
      );
      Object.assign(report, {
        status: "passed",
        finishedAt: new Date().toISOString(),
        workflowId: id,
        originalChars: original.length,
        derivedChars: evidence.content.length,
        completionRef: ref,
        planGate: state.planning.planReview,
        planner: state.planning.agentAttempts?.["plan-v1"],
        reviewer: state.planning.agentAttempts?.["simplicity-v1"],
        limitations:
          "Actual Main, five actual Human rounds/final confirmation, real Planner/Simplicity Reviewer. Scout/classifier and pending Plan Gate are fixtures; no live Jev capacity or Worker/Code approval guarantee. Unit regression separately covers assembled evidence above 48,000 code units.",
      });
      disposeWorkflowContinuations(pi.events);
      await save();
      ctx.ui.notify(`Long-input smoke passed: ${reportPath}`, "info");
    },
  });
  pi.on("session_shutdown", () => disposeWorkflowContinuations(pi.events));
}
