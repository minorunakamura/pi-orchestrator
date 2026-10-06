// Disposable fixtures are prepared sequentially to preserve observation order.
// oxlint-disable eslint/no-await-in-loop
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  link,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { EventBus } from "../../../src/runtime/integrations/subagents.ts";
import {
  registerClarificationBridge,
  CLARIFICATION_COMPLETE_EVENT,
} from "../../../src/runtime/integrations/clarification.ts";
import {
  AskUserQuestionIntegration,
  QUESTION_REQUEST_EVENT,
  QUESTION_CANCEL_EVENT,
  normalizeHumanQuestions,
  type HumanQuestion,
} from "../../../src/runtime/integrations/ask-user-question.ts";
import {
  runClarificationRound,
  recoverClarification,
  loadClarification,
  prepareClarification,
  verifyClarificationDocuments,
} from "../../../src/runtime/orchestrator/clarification.ts";
import { advanceWorkflow } from "../../../src/runtime/orchestrator/advance-workflow.ts";
import { registerWorkflowOwnership } from "../../../src/runtime/integrations/workflow-ownership.ts";
import { WorkflowOwnership } from "../../../src/runtime/orchestrator/workflow-ownership.ts";
import { StateStore } from "../../../src/runtime/persistence/state-store.ts";
import type { WorkflowArtifactWriter } from "../../../src/runtime/orchestrator/planning-orchestrator.ts";
import { PlanningRouting } from "../../../src/runtime/orchestrator/planning-routing.ts";
import { PlanningOrchestrator } from "../../../src/runtime/orchestrator/planning-orchestrator.ts";
import { startWorkflow } from "../../fakes/planning.ts";
import {
  FakeJevDecisionClient,
  FakeSubagentExecutor,
} from "../../fakes/index.ts";
import {
  makeExtensionApiFixture,
  makeExtensionCommandContextFixture,
  makeInvalidPayload,
} from "../../fakes/typed-boundaries.ts";
import { subagentRunId } from "../../../src/types.ts";
import {
  createWorkflowCommandRuntime,
  disposeWorkflowContinuations,
} from "../../../src/commands/index.ts";

const roots: string[] = [];
class Bus implements EventBus {
  listeners = new Map<string, Set<(value: unknown) => void>>();
  calls: { event: string; value: unknown }[] = [];
  emit(event: string, value: unknown) {
    this.calls.push({ event, value });
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
  on(event: string, listener: (value: unknown) => void) {
    const set = this.listeners.get(event) ?? new Set();
    this.listeners.set(event, set);
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }
}
function reply(
  requestId: string,
  questions: HumanQuestion[],
  label = "Keep existing",
  status = "answered",
) {
  return {
    version: 1,
    requestId,
    success: true,
    result: {
      status,
      questions,
      cancelled: status !== "answered",
      answers:
        status === "answered"
          ? Object.fromEntries(
              questions.map((q) => [
                q.question,
                q.multiSelect ? [label] : label,
              ]),
            )
          : {},
      selections:
        status === "answered"
          ? questions.map((q) => ({
              question: q.question,
              header: q.header,
              value: q.multiSelect ? [label] : label,
              labels: [label],
              selectedIndices: [1],
            }))
          : [],
    },
  };
}
const question = {
  question: "Which boundary?",
  options: [{ label: "Keep existing" }],
  allowOther: false,
};
async function setup(
  mode: "GRILL_ME" | "GRILL_WITH_DOCS" = "GRILL_ME",
  owned = false,
  git = false,
) {
  const root = await mkdtemp(join(tmpdir(), "pi-orchestrator-clarification-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  await writeFile(join(cwd, "source.ts"), "export const untouched = true;\n");
  if (git) await promisify(execFile)("git", ["init", "-q", cwd]);
  const skills: {
    name: string;
    baseDir: string;
    filePath: string;
    description: string;
    disableModelInvocation: boolean;
    sourceInfo: { source: string };
  }[] = [];
  for (const name of ["grilling", "domain-modeling"]) {
    const baseDir = join(root, name);
    await mkdir(baseDir);
    const filePath = join(baseDir, "SKILL.md");
    await writeFile(filePath, `# ${name}\nRequire Human shared understanding.`);
    for (const file of name === "domain-modeling"
      ? ["CONTEXT-FORMAT.md", "ADR-FORMAT.md"]
      : [])
      await writeFile(join(baseDir, file), `# ${file}`);
    skills.push({
      name,
      baseDir,
      filePath,
      description: name,
      disableModelInvocation: false,
      sourceInfo: { source: "test" },
    });
  }
  const bus = new Bus();
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<
    string,
    (event: unknown, context: unknown) => unknown
  >();
  const sendMessage = vi.fn();
  const pi = makeExtensionApiFixture({
    events: bus,
    appendEntry: vi.fn(),
    getAllTools: () =>
      [
        "ask_user_question",
        "wf_clarification_round",
        "wf_clarification_complete",
      ].map((name) => ({ name })),
    getActiveTools: () => [],
    setActiveTools: vi.fn(),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    on: (
      event: string,
      handler: (event: unknown, context: unknown) => unknown,
    ) => {
      handlers.set(event, handler);
      return () => {};
    },
    sendMessage,
  });
  const context = makeExtensionCommandContextFixture({
    cwd,
    mode: "tui",
    sessionManager: {
      getSessionId: (): string => "root-1",
      getEntries: () => [],
    },
    getSystemPromptOptions: () => ({ skills }),
    ui: { notify: vi.fn() },
  });
  const ownership = owned ? new WorkflowOwnership(cwd, "root-1") : undefined;
  const port = registerClarificationBridge(
    pi,
    ownership
      ? (ctx) =>
          new WorkflowOwnership(ctx.cwd, ctx.sessionManager.getSessionId())
      : undefined,
  )(context);
  const executor = new FakeSubagentExecutor({
    run: {
      type: "result",
      value: {
        status: "succeeded",
        runId: subagentRunId("scout-1"),
        output:
          "Source boundary exists. Only a Human product decision remains.",
      },
    },
  });
  const h = await startWorkflow(
    {
      cwd,
      playbook: "feature",
      task: "Clarify the boundary",
      context: { requiresClarification: true },
    },
    {
      runsDirectory: join(cwd, ".pi", "orchestrator", "runs"),
      workflowIdFactory: () => "workflow-1",
      subagentExecutor: executor,
      jevDecisionClient: new FakeJevDecisionClient({
        stages: {
          research: "SKIP",
          clarification: "RUN",
          architecture: "SKIP",
        },
        mode,
      }),
    },
  );
  const deps = {
    ...h,
    stateStore: new StateStore(h.runDirectory),
    subagentExecutor: executor,
    clarificationPort: port,
  };
  const initial = ownership
    ? await ownership.initialize(h.state, deps.stateStore)
    : h.state;
  const result = await new PlanningOrchestrator(deps).requestClarification({
    state: initial,
  });
  const state = result.state;
  const identity = {
    workflowId: state.workflowId,
    requestHash: state.planning.clarificationRequestRef!.sha256,
  };
  const autoAnswer = (label = "Confirm", status = "answered") =>
    bus.on(QUESTION_REQUEST_EVENT, (value) => {
      const q = makeInvalidPayload<{
        requestId: string;
        questions: HumanQuestion[];
      }>(value);
      bus.emit(
        `pi-ask-user-question:reply:${q.requestId}`,
        reply(q.requestId, q.questions, label, status),
      );
    });
  const call = (name: string, args: object) =>
    tools
      .get(name)!
      .execute(
        "call-1",
        { ...identity, ...args },
        undefined,
        undefined,
        makeInvalidPayload(context),
      );
  return {
    ...deps,
    ownership,
    root,
    cwd,
    bus,
    tools,
    handlers,
    pi,
    sendMessage,
    context,
    state,
    identity,
    autoAnswer,
    call,
  };
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("GRILL_ME root skill setup and durable rounds, final Human confirmation, no domain writes/implementation authority", async () => {
  const h = await setup();
  expect(h.state.phase).toBe("clarifying");
  expect(h.sendMessage).toHaveBeenCalledOnce();
  expect(h.sendMessage.mock.calls[0]?.[0].content).toContain("grilling");
  expect(h.sendMessage.mock.calls[0]?.[0].content).not.toContain(
    "domain-modeling",
  );
  h.autoAnswer("Keep existing");
  await h.call("wf_clarification_round", { questions: [question] });
  const round = await h.stateStore.loadState();
  expect(round.phase).toBe("clarifying");
  expect(
    await h.artifactStore.readText!(round.planning.clarificationProgressRef!),
  ).toContain("Keep existing");
  await expect(
    h.call("wf_clarification_complete", {
      summary: "Settled",
      documents: [{ path: "CONTEXT.md", content: "Unauthorized" }],
    }),
  ).rejects.toThrow(/Mode/iu);
  // Replace the fake UI answer with explicit final confirmation.
  h.bus.listeners.get(QUESTION_REQUEST_EVENT)!.clear();
  h.autoAnswer();
  await h.call("wf_clarification_complete", {
    summary: "Keep the existing boundary. All branches settled.",
  });
  const done = await h.stateStore.loadState();
  expect(done.phase).toBe("planning");
  expect(done.planning.approvedPlanRef).toBeUndefined();
  expect(done.coding.implementationRef).toBeUndefined();
  expect(await readFile(join(h.cwd, "source.ts"), "utf8")).toBe(
    "export const untouched = true;\n",
  );
  expect(await readdir(h.cwd)).not.toContain("CONTEXT.md");
  expect(
    h.bus.calls.filter((c) => c.event === CLARIFICATION_COMPLETE_EVENT),
  ).toHaveLength(1);
  await expect(
    h.call("wf_clarification_complete", { summary: "Duplicate" }),
  ).rejects.toThrow(/No active/iu);
});

test("explicit same-root resume re-presents answered clarification without replaying questions", async () => {
  const h = await setup("GRILL_ME", true);
  h.autoAnswer("Keep existing");
  await h.call("wf_clarification_round", { questions: [question] });
  const answered = await h.stateStore.loadState();
  const interactionCount = h.bus.calls.filter(
    (c) => c.event === QUESTION_REQUEST_EVENT,
  ).length;
  const runtime = createWorkflowCommandRuntime(h.bus, h.cwd, {
    configuration: h.configuration,
    jevDecisionClient: h.jevDecisionClient,
    clarificationPort: h.clarificationPort,
    ownership: h.ownership,
  });
  const outcome = await runtime.resume(answered.workflowId);
  disposeWorkflowContinuations(h.bus);
  expect(outcome.status).toBe("pending");
  expect(h.sendMessage).toHaveBeenCalledTimes(2);
  const resumed = h.sendMessage.mock.calls[1][0];
  expect(resumed.content).toContain(h.identity.requestHash);
  expect(resumed.content).toContain("Keep existing");
  expect(
    h.bus.calls.filter((c) => c.event === QUESTION_REQUEST_EVENT),
  ).toHaveLength(interactionCount);
  expect(await h.stateStore.loadState()).toEqual(answered);
});

test("every model request restores the exact owned request and all answered rounds after interruption or lost transcript", async () => {
  const h = await setup("GRILL_ME", true);
  h.autoAnswer("Keep existing");
  await h.call("wf_clarification_round", { questions: [question] });
  h.bus.listeners.get(QUESTION_REQUEST_EVENT)!.clear();
  h.autoAnswer("Order");
  await h.call("wf_clarification_round", {
    questions: [{ question: "Which name?", options: [{ label: "Order" }] }],
  });
  const answered = await h.stateStore.loadState();
  const contextHandlers: ((event: unknown, ctx: unknown) => unknown)[] = [];
  h.pi.on = makeInvalidPayload(
    (name: string, handler: (typeof contextHandlers)[number]) => {
      if (name === "context") contextHandlers.push(handler);
      return () => {};
    },
  );
  // Production registration order; a new bridge must recover from disk, not its old memory.
  const ownership = registerWorkflowOwnership(h.pi);
  registerClarificationBridge(h.pi, ownership);
  let messages: unknown[] = [];
  for (const handler of contextHandlers) {
    const value = makeInvalidPayload<{ messages?: unknown[] } | undefined>(
      await handler({ messages }, h.context),
    );
    messages = value?.messages ?? messages;
  }
  const restored = makeInvalidPayload<{ content: string }>(messages.at(-1));
  expect(restored.content).toContain(h.identity.requestHash);
  expect(restored.content).toContain("Keep existing");
  expect(restored.content).toContain("Which name?");
  expect(restored.content).toContain("Order");
  expect(restored.content).toContain("wf_clarification_complete");
  expect(h.sendMessage).toHaveBeenCalledOnce();
  expect(await h.stateStore.loadState()).toEqual(answered);
  h.bus.listeners.get(QUESTION_REQUEST_EVENT)!.clear();
  h.autoAnswer();
  await h.call("wf_clarification_complete", {
    summary:
      "Keep the existing boundary. The name is Order. All decisions settled.",
  });
  const done = await h.stateStore.loadState();
  expect(done.phase).toBe("planning");
  expect(done.planning.approvedPlanRef).toBeUndefined();
  expect(done.coding.implementationRef).toBeUndefined();
  expect(
    h.bus.calls.filter((c) => c.event === QUESTION_REQUEST_EVENT),
  ).toHaveLength(3);
});

test.each(["skill", "workspace", "latest-answer", "earlier-answer"])(
  "request-local restoration rejects %s drift instead of presenting resumable authority",
  async (drift) => {
    const h = await setup("GRILL_ME", true);
    h.autoAnswer("Keep existing");
    await h.call("wf_clarification_round", { questions: [question] });
    const first = await h.stateStore.loadState();
    await h.call("wf_clarification_round", {
      questions: [{ ...question, question: "Which second boundary?" }],
    });
    const before = await h.stateStore.loadState();
    if (drift === "skill")
      await writeFile(
        h.context.getSystemPromptOptions().skills![0].filePath,
        "changed skill",
      );
    else if (drift === "workspace")
      await writeFile(join(h.cwd, "source.ts"), "changed source");
    else
      await writeFile(
        join(
          h.runDirectory,
          (drift === "latest-answer" ? before : first).planning
            .clarificationProgressRef!.path,
        ),
        "corrupt answer",
      );
    const result = makeInvalidPayload<{ messages: { content: string }[] }>(
      await h.handlers.get("context")!({ messages: [] }, h.context),
    );
    expect(result.messages.at(-1)!.content).toContain("not safely resumable");
    expect(result.messages.at(-1)!.content).not.toContain(
      "Continue this active",
    );
    expect(
      await h.handlers.get("tool_call")!(
        { toolName: "wf_clarification_complete" },
        h.context,
      ),
    ).toMatchObject({ block: true });
    expect(
      h.bus.calls.filter((c) => c.event === QUESTION_REQUEST_EVENT),
    ).toHaveLength(2);
    expect(h.sendMessage).toHaveBeenCalledOnce();
  },
);

test("history corruption after context restoration is rejected again before owned Human interaction", async () => {
  const h = await setup("GRILL_ME", true);
  h.autoAnswer("Keep existing");
  await h.call("wf_clarification_round", { questions: [question] });
  const first = await h.stateStore.loadState();
  await h.call("wf_clarification_round", {
    questions: [{ ...question, question: "Which second boundary?" }],
  });
  await h.handlers.get("context")!({ messages: [] }, h.context);
  await writeFile(
    join(h.runDirectory, first.planning.clarificationProgressRef!.path),
    "corrupt past answer",
  );
  h.bus.listeners.get(QUESTION_REQUEST_EVENT)!.clear();
  h.autoAnswer();
  await expect(
    h.call("wf_clarification_complete", { summary: "Settled" }),
  ).rejects.toThrow(/hash/iu);
  expect(
    h.bus.calls.filter((c) => c.event === QUESTION_REQUEST_EVENT),
  ).toHaveLength(2);
  expect((await h.stateStore.loadState()).phase).toBe("clarifying");
});

test.each(["wrong-request", "missing-link", "round-gap"])(
  "restoration rejects a hash-valid but invalid %s history chain",
  async (fault) => {
    const h = await setup("GRILL_ME", true);
    h.autoAnswer("Keep existing");
    await h.call("wf_clarification_round", { questions: [question] });
    const before = await h.stateStore.loadState();
    const answer = JSON.parse(
      await h.artifactStore.readText!(
        before.planning.clarificationProgressRef!,
      ),
    );
    if (fault === "wrong-request") answer.requestRef.sha256 = "a".repeat(64);
    else if (fault === "missing-link") delete answer.previousRef;
    else answer.round = 2;
    const ref = await h.artifactStore.writeText(
      "clarification",
      "invalid-history.md",
      JSON.stringify(answer),
    );
    await h.stateStore.saveState(
      {
        ...before,
        planning: { ...before.planning, clarificationProgressRef: ref },
      },
      before.stateRevision,
    );
    const result = makeInvalidPayload<{ messages: { content: string }[] }>(
      await h.handlers.get("context")!({ messages: [] }, h.context),
    );
    expect(result.messages.at(-1)!.content).toContain("not safely resumable");
    await expect(
      h.call("wf_clarification_complete", { summary: "Settled" }),
    ).rejects.toThrow(/history|binding/iu);
    expect(
      h.bus.calls.filter((c) => c.event === QUESTION_REQUEST_EVENT),
    ).toHaveLength(1);
  },
);

test("over-limit confirmed history is rejected, never silently truncated", async () => {
  const h = await setup();
  const text = "x".repeat(131073);
  h.bus.on(QUESTION_REQUEST_EVENT, (value) => {
    const q = makeInvalidPayload<{
      requestId: string;
      questions: HumanQuestion[];
    }>(value);
    const response = reply(q.requestId, q.questions, text);
    Object.assign(response.result.selections[0], { customText: text });
    h.bus.emit(`pi-ask-user-question:reply:${q.requestId}`, response);
  });
  await h.call("wf_clarification_round", {
    questions: [{ question: "Which name?", options: [] }],
  });
  const before = await h.stateStore.loadState();
  await expect(
    new PlanningOrchestrator(h).requestClarification({ state: before }),
  ).resolves.toMatchObject({ status: "blocked" });
  expect(h.sendMessage).toHaveBeenCalledOnce();
  expect(
    h.bus.calls.filter((c) => c.event === QUESTION_REQUEST_EVENT),
  ).toHaveLength(1);
});

test.each(["pending", "declined"])(
  "explicit resume and request-local context never replay a %s question",
  async (status) => {
    const h = await setup("GRILL_ME", true);
    if (status === "declined") {
      h.autoAnswer("", "user-cancelled");
      await h.call("wf_clarification_round", { questions: [question] });
    } else {
      await runClarificationRound(
        h.state,
        h,
        { ...h.identity, rootSessionId: "root-1", questions: [question] },
        async () => {
          throw Error("Question UI interrupted");
        },
      );
    }
    const state = await h.stateStore.loadState();
    const original = state.planning.clarificationProgressRef;
    const runtime = createWorkflowCommandRuntime(h.bus, h.cwd, {
      configuration: h.configuration,
      jevDecisionClient: h.jevDecisionClient,
      clarificationPort: h.clarificationPort,
      ownership: h.ownership,
    });
    const result = await runtime.resume(state.workflowId);
    disposeWorkflowContinuations(h.bus);
    expect(result.state.phase).toBe("blocked");
    expect(result.state.planning.clarificationProgressRef).toEqual(original);
    expect(
      await h.handlers.get("context")!({ messages: [] }, h.context),
    ).toBeUndefined();
    expect(h.sendMessage).toHaveBeenCalledOnce();
    expect(
      h.bus.calls.filter((c) => c.event === QUESTION_REQUEST_EVENT),
    ).toHaveLength(status === "declined" ? 1 : 0);
  },
);

test("GRILL_WITH_DOCS exact CONTEXT/ADR grant and before/intent/answer/after evidence, no source write", async () => {
  const h = await setup("GRILL_WITH_DOCS");
  await writeFile(join(h.cwd, "CONTEXT.md"), "# Old glossary\n");
  h.autoAnswer();
  await h.call("wf_clarification_complete", {
    summary: "Order means a customer request.",
    documents: [
      {
        path: "CONTEXT.md",
        content: "# Orders\n\n## Language\n**Order**: A customer request.\n",
      },
      {
        path: "billing/docs/adr/0001-boundary.md",
        content: "# Boundary\nCustomer ownership stays in Orders.\n",
      },
    ],
  });
  const done = await h.stateStore.loadState();
  expect(done.phase).toBe("planning");
  const doc = JSON.parse(
    await h.artifactStore.readText!(done.planning.domainDocumentWriteRef!),
  );
  expect(doc.status).toBe("completed");
  expect(doc.requestRef).toEqual(done.planning.clarificationRequestRef);
  const intent = JSON.parse(await h.artifactStore.readText!(doc.intentRef));
  expect(intent.status).toBe("intent");
  expect(intent.answerRef).toEqual(doc.answerRef);
  expect(intent.operations[0].before).toBe("# Old glossary\n");
  expect(intent.operations[1].beforeHash).toBeNull();
  expect(doc.operations[0].afterHash).toMatch(/^[a-f0-9]{64}$/u);
  expect(await readFile(join(h.cwd, "source.ts"), "utf8")).toBe(
    "export const untouched = true;\n",
  );
  expect(h.sendMessage.mock.calls[0]?.[0].content).toContain("domain-modeling");
  await verifyClarificationDocuments(done, h);
  await writeFile(join(h.cwd, "CONTEXT.md"), "drift");
  await expect(verifyClarificationDocuments(done, h)).rejects.toThrow(
    /drift/iu,
  );
});

test.each([false, true])(
  "owned GRILL_WITH_DOCS Git/non-Git (%s) advances only through exact full-workspace evidence without implementation authority",
  async (git) => {
    const h = await setup("GRILL_WITH_DOCS", true, git);
    registerWorkflowOwnership(h.pi);
    expect(
      await h.handlers.get("tool_call")!(
        {
          toolName: "wf_clarification_complete",
          input: { documents: [{ path: "CONTEXT.md" }] },
        },
        h.context,
      ),
    ).toBeUndefined();
    // Later hook input mutation cannot turn this name allowance into source authority.
    await expect(
      h.call("wf_clarification_complete", {
        summary: "Changed effective inputs",
        documents: [{ path: "source.ts", content: "Denied" }],
      }),
    ).rejects.toThrow(/Unauthorized/iu);
    h.autoAnswer();
    await h.call("wf_clarification_complete", {
      summary: "Order ownership stays local.",
      documents: [
        {
          path: "billing/docs/adr/0001-boundary.md",
          content: "# Boundary\nOrders own requests.\n",
        },
      ],
    });
    const done = await h.stateStore.loadState();
    expect(done.phase).toBe("planning");
    expect(done.workspaceCheckpointRef).toBeDefined();
    expect(
      await h.handlers.get("tool_call")!(
        { toolName: "write", input: { path: "CONTEXT.md" } },
        h.context,
      ),
    ).toMatchObject({ block: true });
    expect(done.planning.approvedPlanRef).toBeUndefined();
    expect(done.coding.implementationRef).toBeUndefined();
    const doc = JSON.parse(
      await h.artifactStore.readText!(done.planning.domainDocumentWriteRef!),
    );
    const intent = JSON.parse(await h.artifactStore.readText!(doc.intentRef));
    expect(doc.workspaceBeforeRef).toEqual(intent.workspaceBeforeRef);
    expect(doc.scopeBeforeRef).toEqual(intent.scopeBeforeRef);
    expect(doc.workspaceBeforeRef.kind).toBe("reconciliation");
    expect(doc.workspaceAfterRef.kind).toBe("reconciliation");
    expect(JSON.stringify(doc)).not.toContain("export const untouched");
    expect(doc.workspaceBefore).toBeUndefined();
    expect(await h.ownership!.validate(done, h.stateStore)).toEqual(done);
    h.configuration.jev.runtimePolicy!.grant.evidenceCategories = [
      ...h.configuration.jev.runtimePolicy!.grant.evidenceCategories,
      "design",
    ];
    const routed = await new PlanningRouting(h).stage(done, "architecture");
    expect(
      JSON.stringify(h.jevDecisionClient.calls.routeStage.at(-1)),
    ).not.toContain("export const untouched");
    await writeFile(join(h.cwd, "source.ts"), "unauthorized");
    expect(
      (await h.ownership!.validate(routed.state, h.stateStore)).phase,
    ).toBe("blocked");
    expect(await readFile(join(h.cwd, "source.ts"), "utf8")).toBe(
      "unauthorized",
    );
  },
);

test("Human-wait workspace drift denies documentation before any document side effect", async () => {
  const h = await setup("GRILL_WITH_DOCS", true);
  h.bus.on(QUESTION_REQUEST_EVENT, (value) => {
    void (async () => {
      const q = makeInvalidPayload<{
        requestId: string;
        questions: HumanQuestion[];
      }>(value);
      await writeFile(
        join(h.cwd, "source.ts"),
        "out-of-band during Human wait",
      );
      h.bus.emit(
        `pi-ask-user-question:reply:${q.requestId}`,
        reply(q.requestId, q.questions, "Confirm"),
      );
    })();
  });
  await h.call("wf_clarification_complete", {
    summary: "Settled",
    documents: [{ path: "CONTEXT.md", content: "# Orders\n" }],
  });
  const blocked = await h.stateStore.loadState();
  expect(blocked.phase).toBe("blocked");
  expect(blocked.planning.domainDocumentWriteRef).toBeUndefined();
  expect(await readdir(h.cwd)).not.toContain("CONTEXT.md");
  expect(
    h.bus.calls.filter((c) => c.event === CLARIFICATION_COMPLETE_EVENT),
  ).toHaveLength(0);
});

test("owned GRILL_ME rejects docs and a different root session cannot adopt its authority", async () => {
  const h = await setup("GRILL_ME", true);
  h.autoAnswer();
  await expect(
    h.call("wf_clarification_complete", {
      summary: "Settled",
      documents: [{ path: "CONTEXT.md", content: "# Denied" }],
    }),
  ).rejects.toThrow(/Mode/iu);
  h.context.sessionManager.getSessionId = () => "other-root";
  await expect(
    h.call("wf_clarification_round", { questions: [question] }),
  ).rejects.toThrow(/ownership/iu);
  expect(
    h.bus.calls.filter((c) => c.event === QUESTION_REQUEST_EVENT),
  ).toHaveLength(0);
  expect((await h.stateStore.loadState()).phase).toBe("blocked");
});

test("Architecture consumes exact domain evidence under explicit design consent; lost intent rejects cached routing", async () => {
  const h = await setup("GRILL_WITH_DOCS");
  h.configuration.jev.runtimePolicy!.grant.evidenceCategories = [
    ...h.configuration.jev.runtimePolicy!.grant.evidenceCategories,
    "design",
  ];
  h.autoAnswer();
  await h.call("wf_clarification_complete", {
    summary: "Order is a customer request.",
    documents: [
      {
        path: "CONTEXT.md",
        content: "# Orders\n**Order**: A customer request.\n",
      },
    ],
  });
  const done = await h.stateStore.loadState();
  const routed = await new PlanningRouting(h).stage(done, "architecture");
  expect(routed.inputRefs).toContainEqual(done.planning.domainDocumentWriteRef);
  const call = h.jevDecisionClient.calls.routeStage.at(-1)!;
  expect(call.inputRefs).toContainEqual(done.planning.domainDocumentWriteRef);
  const doc = JSON.parse(
    await h.artifactStore.readText!(done.planning.domainDocumentWriteRef!),
  );
  await rm(join(h.runDirectory, doc.intentRef.path));
  const calls = h.jevDecisionClient.calls.routeStage.length;
  await expect(
    new PlanningRouting(h).stage(routed.state, "architecture", true),
  ).rejects.toThrow(/attention/iu);
  expect((await h.stateStore.loadState()).phase).toBe("blocked");
  expect(h.jevDecisionClient.calls.routeStage.length).toBe(calls);
});

test.each([
  "../CONTEXT.md",
  "/tmp/CONTEXT.md",
  "a/../../CONTEXT.md",
  "a\\CONTEXT.md",
  "docs/adr/bad\n.md",
  "src/source.ts",
  "package.json",
  "docs/config.md",
  ".pi/CONTEXT.md",
  "docs/adr/nested/no.md",
])("rejects unauthorized document %s before UI/write", async (path) => {
  const h = await setup("GRILL_WITH_DOCS");
  h.autoAnswer();
  await expect(
    h.call("wf_clarification_complete", {
      summary: "Settled",
      documents: [{ path, content: "Denied" }],
    }),
  ).rejects.toThrow(/Unauthorized/iu);
  expect(
    h.bus.calls.filter((c) => c.event === QUESTION_REQUEST_EVENT),
  ).toHaveLength(0);
  expect(
    (await h.stateStore.loadState()).planning.domainDocumentWriteRef,
  ).toBeUndefined();
});

test("symlink escape and hardlinked document denied before granting a write", async () => {
  const h = await setup("GRILL_WITH_DOCS");
  await symlink(h.root, join(h.cwd, "escaped"));
  await expect(
    h.call("wf_clarification_complete", {
      summary: "Settled",
      documents: [{ path: "escaped/CONTEXT.md", content: "Denied" }],
    }),
  ).rejects.toThrow(/Unsafe/iu);
  await symlink(join(h.cwd, "source.ts"), join(h.cwd, "CONTEXT.md"));
  await expect(
    h.call("wf_clarification_complete", {
      summary: "Settled",
      documents: [{ path: "CONTEXT.md", content: "Denied" }],
    }),
  ).rejects.toThrow(/Unsafe/iu);
  await rm(join(h.cwd, "CONTEXT.md"));
  await link(join(h.cwd, "source.ts"), join(h.cwd, "CONTEXT.md"));
  await expect(
    h.call("wf_clarification_complete", {
      summary: "Settled",
      documents: [{ path: "CONTEXT.md", content: "Denied" }],
    }),
  ).rejects.toThrow(/Unsafe/iu);
});

test.each(["user-cancelled", "caller-aborted", "shutdown"])(
  "%s is durable blocked evidence, not an answer",
  async (status) => {
    const h = await setup();
    h.autoAnswer("", status);
    await h.call("wf_clarification_round", { questions: [question] });
    const state = await h.stateStore.loadState();
    expect(state.phase).toBe("blocked");
    expect(
      await h.artifactStore.readText!(state.planning.clarificationProgressRef!),
    ).toContain(status);
    expect(state.planning.context.clarificationRef).toBeUndefined();
  },
);

test("pending Human request cannot be replayed after crash, and changed source/root/hash fails closed", async () => {
  const h = await setup();
  const request = await loadClarification(h.state, h, "root-1");
  await expect(loadClarification(h.state, h, "different-root")).rejects.toThrow(
    /identity/iu,
  );
  await expect(
    h.call("wf_clarification_round", {
      requestHash: "a".repeat(64),
      questions: [question],
    }),
  ).rejects.toThrow(/hash/iu);
  const altered = {
    ...h.state,
    coding: { ...h.state.coding, implementationRevision: 1 },
  };
  await expect(loadClarification(altered, h)).rejects.toThrow(/Stale/iu);
  await expect(
    runClarificationRound(
      h.state,
      h,
      {
        requestHash: request.requestRef!.sha256,
        rootSessionId: "root-1",
        questions: [question],
      },
      async () => {
        throw Error("UI process died");
      },
    ),
  ).resolves.toMatchObject({ phase: "blocked" });
  const blocked = await h.stateStore.loadState();
  const recoverable = await advanceWorkflow(
    blocked,
    { type: "BLOCK_RESOLVED" },
    h.stateStore,
  );
  expect((await recoverClarification(recoverable, h)).phase).toBe("blocked");
  expect(
    h.bus.calls.filter((c) => c.event === QUESTION_REQUEST_EVENT),
  ).toHaveLength(0);
});

test("document mutation/output-before-State interruption blocks blind repeat", async () => {
  const h = await setup("GRILL_WITH_DOCS");
  const writeText = h.artifactStore.writeText.bind(h.artifactStore);
  const artifactStore: WorkflowArtifactWriter = {
    readText: h.artifactStore.readText!.bind(h.artifactStore),
    writeText: async (kind, name, content) => {
      if (name.startsWith("domain-document-result"))
        throw Error("After evidence persistence failed");
      return writeText(kind, name, content);
    },
  };
  const deps = { ...h, artifactStore };
  const next = await runClarificationRound(
    h.state,
    deps,
    {
      ...h.identity,
      rootSessionId: "root-1",
      summary: "Settled",
      documents: [{ path: "CONTEXT.md", content: "# Glossary\n" }],
    },
    async (id, questions) =>
      makeInvalidPayload(reply(id, questions, "Confirm").result),
  );
  expect(next.phase).toBe("blocked");
  expect(await readFile(join(h.cwd, "CONTEXT.md"), "utf8")).toBe(
    "# Glossary\n",
  );
  expect(
    await h.artifactStore.readText!(next.planning.domainDocumentWriteRef!),
  ).toContain('"status": "intent"');
  const restored = await advanceWorkflow(
    next,
    { type: "BLOCK_RESOLVED" },
    h.stateStore,
  );
  await expect(
    runClarificationRound(
      restored,
      h,
      { ...h.identity, rootSessionId: "root-1", summary: "Retry" },
      async () => {
        throw Error("Must not ask");
      },
    ),
  ).rejects.toThrow(/cannot be replayed/iu);
  expect((await recoverClarification(restored, h)).phase).toBe("blocked");
});

test("root ceiling denies raw tools, unknown providers, nested/child bypass; own execution validates effective inputs", async () => {
  const h = await setup("GRILL_WITH_DOCS");
  for (const name of [
    "write",
    "edit",
    "bash",
    "subagent",
    "codemode",
    "ask_user_question",
    "mcp_unknown",
  ])
    expect(
      h.handlers.get("tool_call")?.({ toolName: name }, h.context),
    ).toMatchObject({ block: true });
  expect(
    h.handlers.get("tool_call")?.(
      { toolName: "wf_clarification_complete" },
      h.context,
    ),
  ).toBeUndefined();
  // A later hook changing owned-tool inputs cannot widen the execution-time path check.
  await expect(
    h.call("wf_clarification_complete", {
      summary: "Settled",
      documents: [{ path: "source.ts", content: "Denied" }],
    }),
  ).rejects.toThrow(/Unauthorized/iu);
  await writeFile(
    h.context.getSystemPromptOptions().skills![0].filePath,
    "skill drift",
  );
  await expect(
    h.call("wf_clarification_round", { questions: [question] }),
  ).rejects.toThrow(/skill drift/iu);
});

test("copied workflow data cannot authorize writes in a different root workspace", async () => {
  const h = await setup("GRILL_WITH_DOCS");
  const other = join(h.root, "other-project");
  await mkdir(other);
  await cp(join(h.cwd, ".pi"), join(other, ".pi"), { recursive: true });
  h.context.cwd = other;
  h.autoAnswer();
  await expect(
    h.call("wf_clarification_complete", {
      summary: "Settled",
      documents: [{ path: "CONTEXT.md", content: "Denied" }],
    }),
  ).rejects.toThrow(/workspace identity mismatch/iu);
  expect(
    h.bus.calls.filter((c) => c.event === QUESTION_REQUEST_EVENT),
  ).toHaveLength(0);
  expect(await readdir(h.cwd)).not.toContain("CONTEXT.md");
});

test("root setup rejects RPC/print, missing skills and missing registered integration without starting Human interaction", async () => {
  const h = await setup();
  h.context.mode = "rpc";
  await expect(h.clarificationPort.setup!("GRILL_ME")).rejects.toThrow(
    /root TUI/iu,
  );
  h.context.mode = "tui";
  h.context.getSystemPromptOptions = () => ({ cwd: h.cwd, skills: [] });
  await expect(h.clarificationPort.setup!("GRILL_ME")).rejects.toThrow(
    /skill unavailable/iu,
  );
  h.pi.getAllTools = () => [];
  await expect(h.clarificationPort.setup!("GRILL_ME")).rejects.toThrow(
    /not loaded/iu,
  );
  expect(
    h.bus.calls.filter((c) => c.event === QUESTION_REQUEST_EVENT),
  ).toHaveLength(0);
});

test("question intent State-save failure means zero UI calls; answer-save interruption leaves a non-replayable barrier", async () => {
  const h = await setup();
  let asks = 0;
  const input = {
    ...h.identity,
    rootSessionId: "root-1",
    questions: [question],
  };
  const ask = async (id: string, questions: HumanQuestion[]) => {
    asks++;
    return makeInvalidPayload<
      import("../../../src/runtime/integrations/ask-user-question.ts").HumanReply
    >(reply(id, questions).result);
  };
  await expect(
    runClarificationRound(
      h.state,
      {
        ...h,
        stateStore: {
          saveState: async () => {
            throw Error("Intent State interrupted");
          },
        },
      },
      input,
      ask,
    ),
  ).rejects.toThrow("Intent State interrupted");
  expect(asks).toBe(0);
  await expect(
    runClarificationRound(
      h.state,
      {
        ...h,
        stateStore: {
          saveState: (state, rev) => {
            if (
              state.planning.clarificationProgressRef?.path.startsWith(
                "context/human-reply-",
              )
            )
              throw Error("Answer State interrupted");
            return h.stateStore.saveState(state, rev);
          },
        },
      },
      input,
      ask,
    ),
  ).rejects.toThrow("Answer State interrupted");
  expect(asks).toBe(1);
  expect(
    (await recoverClarification(await h.stateStore.loadState(), h)).phase,
  ).toBe("blocked");
});

test("evidence is bounded and hash-validated, never silently truncated or replaced", async () => {
  const h = await setup();
  const fresh = structuredClone(h.state);
  delete fresh.planning.clarificationRequestRef;
  const huge = await h.artifactStore.writeText(
    "scout",
    "huge.md",
    "x".repeat(65537),
  );
  await expect(
    prepareClarification(fresh, h, { mode: "GRILL_ME", contextRefs: [huge] }),
  ).rejects.toThrow(/bound/iu);
  await writeFile(
    join(h.runDirectory, h.state.taskRef.path),
    "corrupt evidence",
  );
  await expect(loadClarification(h.state, h)).rejects.toThrow(/hash/iu);
  expect(
    h.bus.calls.filter((c) => c.event === QUESTION_REQUEST_EVENT),
  ).toHaveLength(0);
});

test("question adapter rejects incomplete/mismatched replies and times out/cancels without leaked listeners", async () => {
  const bus = new Bus();
  const questions = normalizeHumanQuestions([question]);
  bus.on(QUESTION_REQUEST_EVENT, () =>
    bus.emit("pi-ask-user-question:reply:id", {
      version: 1,
      requestId: "id",
      success: true,
      result: {
        status: "answered",
        cancelled: false,
        questions,
        answers: {},
        selections: [],
      },
    }),
  );
  await expect(
    new AskUserQuestionIntegration(bus).ask("id", questions),
  ).rejects.toThrow(/Incomplete/iu);
  bus.listeners.clear();
  const choices = normalizeHumanQuestions([
    {
      question: "Which boundary?",
      options: [{ label: "Keep existing" }, { label: "Change" }],
      allowOther: false,
    },
  ]);
  bus.on(QUESTION_REQUEST_EVENT, () => {
    const wrong = reply("mismatch", choices);
    wrong.result.selections[0].selectedIndices = [2];
    bus.emit("pi-ask-user-question:reply:mismatch", wrong);
  });
  await expect(
    new AskUserQuestionIntegration(bus).ask("mismatch", choices),
  ).rejects.toThrow(/indices do not match/iu);
  bus.listeners.clear();
  vi.useFakeTimers();
  const promise = new AskUserQuestionIntegration(bus, 50).ask(
    "lost",
    questions,
  );
  const assertion = expect(promise).rejects.toThrow(/timed out/iu);
  await vi.advanceTimersByTimeAsync(50);
  await assertion;
  expect(bus.calls.some((c) => c.event === QUESTION_CANCEL_EVENT)).toBe(true);
  expect(bus.listeners.get("pi-ask-user-question:reply:lost")?.size).toBe(0);
});
