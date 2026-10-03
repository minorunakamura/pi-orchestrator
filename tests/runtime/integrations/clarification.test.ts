// Disposable fixtures are prepared sequentially to preserve observation order.
// oxlint-disable eslint/no-await-in-loop
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
async function setup(mode: "GRILL_ME" | "GRILL_WITH_DOCS" = "GRILL_ME") {
  const root = await mkdtemp(join(tmpdir(), "pi-orchestrator-clarification-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  await writeFile(join(cwd, "source.ts"), "export const untouched = true;\n");
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
    sessionManager: { getSessionId: () => "root-1" },
    getSystemPromptOptions: () => ({ skills }),
    ui: { notify: vi.fn() },
  });
  const port = registerClarificationBridge(pi)(context);
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
  const result = await new PlanningOrchestrator(deps).requestClarification({
    state: h.state,
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
