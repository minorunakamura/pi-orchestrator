// Opt-in real-host evidence; deterministic offline model, actual Human confirmation.
// oxlint-disable eslint/no-await-in-loop
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Type,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  VERSION,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { registerWorkflowOwnership } from "../../src/runtime/integrations/workflow-ownership.ts";
import {
  registerClarificationBridge,
  CLARIFICATION_COMPLETE_EVENT,
} from "../../src/runtime/integrations/clarification.ts";
import { createWorkflow } from "../../src/runtime/orchestrator/start-workflow.ts";
import { PlanningOrchestrator } from "../../src/runtime/orchestrator/planning-orchestrator.ts";
import { driveWorkflow } from "../../src/runtime/orchestrator/drive-workflow.ts";
import { verifyClarificationDocuments } from "../../src/runtime/orchestrator/clarification.ts";
import { StateStore } from "../../src/runtime/persistence/state-store.ts";
import { ArtifactStore } from "../../src/runtime/persistence/artifact-store.ts";
import { FakeSubagentExecutor, FakeJevDecisionClient } from "../fakes/index.ts";
import { jevPolicy } from "../fakes/jev-policy.ts";
import { configuration } from "../fakes/coding-scenario.ts";
import { subagentRunId } from "../../src/types.ts";
import { isRecord } from "../../src/core/schema.ts";

export default function (pi: ExtensionAPI) {
  // Explicit disposable fixture host decision, never persisted operator trust or product inference.
  pi.on("project_trust", () => ({ trusted: "yes", remember: false }));
  const ownership = registerWorkflowOwnership(pi);
  const bridge = registerClarificationBridge(pi, ownership);
  let commandContext: ExtensionCommandContext;
  let reportPath = "";
  let step = 0;
  let requestHash = "";
  const id = "ownership-live";
  const report: Record<string, unknown> = { status: "not-started", denied: [] };
  pi.registerProvider("ownership-smoke", {
    api: "ownership-offline",
    apiKey: "offline-fixture",
    baseUrl: "https://unused.invalid",
    models: [
      {
        id: "probe",
        name: "Ownership host probe",
        reasoning: false,
        input: ["text"],
        contextWindow: 64000,
        maxTokens: 4000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      const call: Pick<ToolCall, "name" | "arguments"> | undefined =
        step === 0
          ? { name: "ownership_probe", arguments: {} }
          : step === 1 && requestHash
            ? {
                name: "write",
                arguments: {
                  path: "source.ts",
                  content: "DENIED_MAIN_IMPLEMENTATION",
                },
              }
            : step === 2 && requestHash
              ? {
                  name: "wf_clarification_complete",
                  arguments: {
                    workflowId: id,
                    requestHash,
                    summary:
                      "Order means a customer request. Preserve the implementation boundary. This smoke proposes only a design glossary, not implementation or Plan/Code approval.",
                    documents: [
                      {
                        path: "CONTEXT.md",
                        content:
                          "# Orders\n\n## Language\n**Order**: A customer request.\n",
                      },
                    ],
                  },
                }
              : undefined;
      step++;
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: call ? "toolUse" : "stop",
        content: call
          ? [{ type: "toolCall", id: `ownership-call-${step}`, ...call }]
          : [
              {
                type: "text",
                text: "Ownership smoke completed; inspect the durable report.",
              },
            ],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({
          type: "done",
          reason: call ? "toolUse" : "stop",
          message,
        });
        stream.end();
      });
      return stream;
    },
  });
  const save = () =>
    writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  pi.registerTool({
    name: "ownership_probe",
    label: "Initialize ownership smoke",
    exposure: "model-only",
    description: "Disposable smoke setup only",
    parameters: Type.Object({}),
    async execute(_call, _args, _signal, _update, ctx) {
      assert.equal(process.env.HERDR_ENV, "1");
      assert.equal(VERSION, "0.99.1");
      assert.equal(ctx.isProjectTrusted(), true);
      assert(ctx.getSystemPrompt().includes("TRUSTED_PROJECT_CONTEXT_CANARY"));
      assert(pi.getAllTools().some((tool) => tool.name === "project_mutate"));
      const root = join(ctx.cwd, ".pi", "orchestrator", "runs", id);
      const artifactStore = new ArtifactStore(root),
        stateStore = new StateStore(root);
      const owner = ownership(ctx);
      const executor = new FakeSubagentExecutor({
        run: {
          type: "result",
          value: {
            status: "succeeded",
            runId: subagentRunId("scripted-scout"),
            output:
              "All facts supplied. Disposable source.ts must remain unchanged. Order means customer request. Only the Human confirmation of exact CONTEXT.md is unresolved. No ADR or implementation required.",
          },
        },
      });
      const created = await owner.start(() =>
        createWorkflow(
          {
            cwd: ctx.cwd,
            playbook: "feature",
            task: "GRILL_WITH_DOCS glossary-only smoke. Preserve source and both Human Gates.",
          },
          {
            runsDirectory: owner.runsDirectory,
            workflowIdFactory: () => id,
            subagentExecutor: executor,
            artifactStore,
            stateStore,
          },
        ),
      );
      let state = await owner.initialize(created.state, stateStore);
      const denied: unknown[] = [];
      for (const [tool, args] of [
        ["write", { path: "source.ts", content: "DENIED_NESTED" }],
        ["edit", { path: "source.ts", oldText: "true", newText: "false" }],
        ["bash", { command: "echo DENIED_SHELL > source.ts" }],
        ["project_mutate", {}],
      ] as const) {
        const result = await ctx.executeTool(tool, args);
        assert.equal(result.isError, true, tool);
        denied.push({ tool, isError: result.isError });
      }
      report.denied = denied;
      assert.equal(
        await readFile(join(ctx.cwd, "source.ts"), "utf8"),
        "export const sourceMustNotChange = true;\n",
      );
      const classifier = new FakeJevDecisionClient({
        stages: {
          research: "SKIP",
          clarification: "RUN",
          architecture: "SKIP",
        },
        mode: "GRILL_WITH_DOCS",
      });
      const planning = new PlanningOrchestrator({
        artifactStore,
        stateStore,
        subagentExecutor: executor,
        jevDecisionClient: classifier,
        configuration: { ...configuration, jev: jevPolicy(ctx.cwd, 6) },
        clarificationPort: bridge(commandContext),
      });
      state = (await planning.gatherContext({ state, cwd: ctx.cwd })).state;
      state = (await planning.requestClarification({ state })).state;
      requestHash = state.planning.clarificationRequestRef!.sha256;
      Object.assign(report, {
        status: "waiting-human",
        workflowId: id,
        root: ctx.cwd,
        rootSessionId: ctx.sessionManager.getSessionId(),
        ownershipRef: state.ownershipRef,
        requestRef: state.planning.clarificationRequestRef,
        trustedProjectToolLoaded: true,
        projectTrusted: ctx.isProjectTrusted(),
      });
      await save();
      return {
        content: [
          {
            type: "text",
            text: "Nested mutations denied. Next attempt Main write, then ask Human for exact authorized CONTEXT.md.",
          },
        ],
        details: report,
      };
    },
  });
  pi.on("tool_result", async (event) => {
    if (event.toolName === "ownership_probe" && event.isError) {
      step = 99;
      report.status = "failed";
      report.error = event.content;
      await save();
    }
    if (event.toolName === "write" && event.isError) {
      report.mainMutationDenied = true;
      await save();
    }
    if (
      event.toolName === "wf_clarification_complete" &&
      isRecord(event.details) &&
      event.details.phase === "blocked"
    ) {
      report.status = "blocked";
      report.error =
        "Human interaction/document outcome unresolved; do not replay";
      await save();
    }
  });
  const audit = async (ctx: ExtensionCommandContext) => {
    assert.equal(ctx.sessionManager.getSessionId(), report.rootSessionId);
    report.mainMutationDenied = ctx.sessionManager
      .getBranch()
      .some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "toolResult" &&
          entry.message.toolName === "write" &&
          entry.message.isError,
      );
    const root = join(ctx.cwd, ".pi", "orchestrator", "runs", id);
    const stateStore = new StateStore(root),
      artifactStore = new ArtifactStore(root);
    const state = await stateStore.loadState();
    assert.equal(state.phase, "planning");
    assert(state.workspaceCheckpointRef);
    assert.equal(report.mainMutationDenied, true);
    assert.equal(state.planning.approvedPlanRef, undefined);
    assert.equal(state.coding.implementationRef, undefined);
    await verifyClarificationDocuments(state, { artifactStore, stateStore });
    assert.equal(
      await readFile(join(ctx.cwd, "CONTEXT.md"), "utf8"),
      "# Orders\n\n## Language\n**Order**: A customer request.\n",
    );
    assert.equal(
      await readFile(join(ctx.cwd, "source.ts"), "utf8"),
      "export const sourceMustNotChange = true;\n",
    );
    // Trusted extension direct FS access is not sandboxed. Prove its drift cannot become authority.
    await writeFile(
      join(ctx.cwd, "source.ts"),
      "deliberate out-of-band trusted-extension mutation\n",
    );
    const executor = new FakeSubagentExecutor();
    const blocked = await driveWorkflow(id, {
      stateStore,
      artifactStore,
      subagentExecutor: executor,
      loadState: () => stateStore.loadState(),
      ownership: ownership(ctx),
    });
    assert.equal(blocked.status, "blocked");
    assert.equal(executor.calls.run.length, 0);
    Object.assign(report, {
      status: "passed",
      documentRef: state.planning.domainDocumentWriteRef,
      clarificationRef: state.planning.context.clarificationRef,
      workspaceCheckpointRef: state.workspaceCheckpointRef,
      driftBlock: blocked.state.block,
      finishedAt: new Date().toISOString(),
      limitations:
        "Real Pi hooks/nested execution/trusted project tool/actual Human document confirmation; offline scripted root and Scout/classifier fixtures. No actual Worker, live Jev or Human Plan/Code approval; not an OS sandbox.",
    });
    await save();
    ctx.ui.notify(`Ownership smoke passed: ${reportPath}`, "info");
  };
  pi.registerCommand("ownership-audit", {
    description:
      "Audit the same already-confirmed smoke without replaying questions/doc writes/children",
    async handler(path, ctx) {
      reportPath = path;
      Object.assign(report, JSON.parse(await readFile(path, "utf8")));
      if (report.error) {
        report.previousAuditFailure = report.error;
        delete report.error;
      }
      await audit(ctx);
    },
  });
  pi.events.on(CLARIFICATION_COMPLETE_EVENT, () => {
    void audit(commandContext).catch(async (error) => {
      report.status = "failed";
      report.error = String(error);
      await save();
    });
  });
  pi.registerCommand("ownership-smoke", {
    description: "Issue #5 real-host guard and Human document-write smoke",
    async handler(path, ctx) {
      commandContext = ctx;
      reportPath = path;
      Object.assign(report, {
        status: "running",
        pi: VERSION,
        startedAt: new Date().toISOString(),
        herdrTab: process.env.HERDR_TAB_ID,
        herdrPane: process.env.HERDR_PANE_ID,
      });
      await save();
      pi.sendUserMessage(
        "Run the deterministic ownership fixture. Human must confirm the actual document proposal; do not invent an answer.",
      );
    },
  });
}
