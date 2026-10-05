import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ArtifactStore } from "../../../src/runtime/persistence/artifact-store.ts";
import { StateStore } from "../../../src/runtime/persistence/state-store.ts";
import {
  SubagentsIntegration,
  fakeLaunchResolver,
} from "../../fakes/agent-launch.ts";
import { startWorkflow } from "../../../src/runtime/orchestrator/start-workflow.ts";
import {
  resumeWorkflow,
  reconcileWorkflow,
} from "../../../src/runtime/orchestrator/resume-workflow.ts";
import { PlanningOrchestrator } from "../../../src/runtime/orchestrator/planning-orchestrator.ts";
import type { WorkflowStateWriter } from "../../../src/runtime/orchestrator/advance-workflow.ts";
import { FakeSubagentRpc, childRequest } from "../../fakes/subagent-rpc.ts";
import {
  plan,
  configuration as stageConfiguration,
} from "../../fakes/coding-scenario.ts";
import { planningDependencies } from "../../fakes/planning.ts";
import { workflowId } from "../../../src/types.ts";
import { subagentRunId } from "../../../src/types.ts";
import {
  projectWorkflowStatus,
  renderWorkflowStatus,
} from "../../../src/ui/workflow-status.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function setup(
  options: {
    pause?: string;
    stageProfiles?: boolean;
    noReceipt?: boolean;
    failReceipt?: boolean;
    failContextSave?: boolean;
    failIntent?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "planning-recovery-"));
  roots.push(root);
  const runDirectory = join(root, ".pi", "orchestrator", "runs", "recovery");
  const store = new ArtifactStore(runDirectory);
  const states = new StateStore(runDirectory);
  const requests: Record<string, unknown>[] = [];
  const events = new FakeSubagentRpc((request, rpc) => {
    requests.push(request);
    const runId = `${String(request.agent)}-1`;
    if (!options.noReceipt) rpc.receipt(request, runId);
    if (request.agent !== options.pause && !options.noReceipt)
      rpc.complete(
        request,
        runId,
        "complete",
        request.agent === "planner"
          ? plan
          : `facts from ${String(request.agent)}`,
      );
  });
  const writer: WorkflowStateWriter = {
    saveState: (state, revision) => {
      if (options.failIntent && state.planning.agentAttempts?.scout)
        throw Error("intent crash");
      if (options.failReceipt && state.planning.agentAttempts?.scout?.receipt)
        throw Error("receipt crash");
      if (options.failContextSave && state.planning.context.scoutRef)
        throw Error("context commit crash");
      return states.saveState(state, revision);
    },
  };
  const executor = new SubagentsIntegration(events, {
    configuration: options.stageProfiles ? stageConfiguration : undefined,
    cwd: root,
    artifactReader: store,
    timeoutMs: 150,
  });
  const routing = planningDependencies(
    { workflowId: workflowId("recovery"), projectRoot: root },
    { requiresResearch: !options.failContextSave },
  );
  let error: unknown;
  try {
    await startWorkflow(
      { task: "Build Reversi", playbook: "new-project", cwd: root },
      {
        runsDirectory: join(root, ".pi", "orchestrator", "runs"),
        workflowIdFactory: () => "recovery",
        artifactStore: store,
        stateStore: writer,
        subagentExecutor: executor,
        ...routing,
      },
    );
  } catch (cause) {
    error = cause;
  }
  const freshEvents = new FakeSubagentRpc();
  // Isolate exact historical child recovery; normal continuation is tested separately.
  const resume = (
    launchResolver = fakeLaunchResolver,
    configuration = options.stageProfiles ? stageConfiguration : undefined,
  ) =>
    reconcileWorkflow("recovery", {
      ...routing,
      runDirectory,
      cwd: root,
      repositoryCwd: root,
      subagentExecutor: new SubagentsIntegration(freshEvents, {
        configuration,
        cwd: root,
        launchResolver,
        artifactReader: new ArtifactStore(runDirectory),
      }),
    });
  return {
    root,
    runDirectory,
    store,
    states,
    requests,
    events,
    freshEvents,
    resume,
    error,
    executor,
    routing,
  };
}

test("recreated runtime observes the same research run, then recovers its result without a completion notification", async () => {
  const h = await setup({ pause: "pi-ketch.researcher" });
  const waiting = await h.states.loadState();
  expect(waiting.phase).toBe("blocked");
  const attempt = waiting.planning.agentAttempts!.research;
  expect(attempt.dispatch).toMatchObject({
    ownerRunId: "recovery",
    nodeId: "research",
  });
  expect(attempt.inputRefs).toEqual([
    waiting.taskRef,
    waiting.planning.context.scoutRef,
    waiting.planning.stageDecisionRefs!.research,
  ]);
  expect(attempt.receipt?.runId).toBe("pi-ketch.researcher-1");
  expect(renderWorkflowStatus(projectWorkflowStatus(waiting))).toContain(
    "run=pi-ketch.researcher-1",
  );
  expect((await h.resume()).status).toBe("pending");
  expect((await h.states.loadState()).stateRevision).toBe(
    waiting.stateRevision,
  );
  expect(h.freshEvents.emitted).toHaveLength(0);
  h.events.complete(
    h.requests[1],
    attempt.receipt!.runId,
    "complete",
    "recovered research",
  );
  const recovered = await h.resume();
  expect(recovered.state.phase).toBe("planning");
  expect(
    await h.store.readText(recovered.state.planning.context.researchRef!),
  ).toBe("recovered research");
  expect(h.freshEvents.emitted).toHaveLength(0);
});

test.each(["stage-override", "model-mapping", "reasoning-mapping"])(
  "reconciliation blocks %s drift without changing historical launch evidence or redispatching",
  async (dimension) => {
    const h = await setup({ pause: "workflow-scout", stageProfiles: true });
    const before = await h.states.loadState();
    const historical = before.planning.agentAttempts!.scout;
    expect(historical.launch).toMatchObject({
      model: "fake/economy",
      thinking: "low",
    });
    expect((await h.resume()).status).toBe("pending");
    h.events.complete(
      h.requests[0],
      historical.receipt!.runId,
      "complete",
      "historical Scout output",
    );
    const configuration = structuredClone(stageConfiguration);
    if (dimension === "stage-override")
      configuration.stageProfiles = {
        scout: { modelTier: "STRONG", reasoningTier: "HIGH" },
      };
    if (dimension === "model-mapping")
      configuration.executionProfiles.ECONOMY.model = "changed";
    if (dimension === "reasoning-mapping")
      configuration.reasoningMapping.LOW = "medium";
    const result = await h.resume(fakeLaunchResolver, configuration);
    expect(result.status).toBe("blocked");
    expect(result.state.planning.agentAttempts!.scout).toEqual(historical);
    expect(h.freshEvents.emitted).toHaveLength(0);
    expect(h.requests).toHaveLength(1);
  },
);

test("recovers an interrupted planner without creating another plan version or dispatch", async () => {
  const h = await setup({ pause: "planner" });
  expect((await h.states.loadState()).phase).toBe("planning");
  const planner = new PlanningOrchestrator({
    ...h.routing,
    artifactStore: h.store,
    stateStore: h.states,
    subagentExecutor: h.executor,
  });
  await expect(
    planner.createPlan({ state: await h.states.loadState(), cwd: h.root }),
  ).rejects.toThrow("Planner did not succeed");
  const waiting = await h.states.loadState();
  expect(waiting.planning.agentAttempts?.["plan-v1"]?.receipt?.runId).toBe(
    "planner-1",
  );
  expect((await h.resume()).status).toBe("pending");
  h.events.complete(h.requests[2], "planner-1", "complete", plan);
  const recovered = await h.resume();
  expect(recovered.state.phase).toBe("planning");
  expect(recovered.state.planning.simplicityReviewRef).toBeUndefined();
  expect(recovered.state.planning.currentPlanVersion).toBe(1);
  expect(await h.store.readText(recovered.state.planning.currentPlanRef!)).toBe(
    plan,
  );
  await h.resume(); // No Human Gate is configured; must not redispatch the planner.
  expect(h.freshEvents.emitted).toHaveLength(0);
});

test.each([
  "runId",
  "sessionId",
  "launchContractDigest",
  "cwd",
  "lifecycleArtifactVersion",
])("rejects changed public status identity: %s", async (field) => {
  const h = await setup({ pause: "workflow-scout" });
  const state = await h.states.loadState();
  const receipt = state.planning.agentAttempts!.scout.receipt!;
  h.events.complete(
    h.requests[0],
    receipt.runId,
    "complete",
    "untrusted result",
  );
  const path = join(receipt.asyncDir, "status.json");
  const status = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...status, [field]: "wrong" }));
  expect((await h.resume()).status).toBe("blocked");
  expect(h.freshEvents.emitted).toHaveLength(0);
  expect(
    (await h.states.loadState()).planning.context.scoutRef,
  ).toBeUndefined();
});

test.each([
  "missing-status",
  "missing-output",
  "changed-input",
  "malformed-status",
  "symlink-output",
])("missing or corrupt evidence never causes redispatch: %s", async (fault) => {
  const h = await setup({ pause: "workflow-scout" });
  const state = await h.states.loadState();
  const receipt = state.planning.agentAttempts!.scout.receipt!;
  h.events.complete(h.requests[0], receipt.runId, "complete", "finished");
  if (fault === "missing-status")
    await rm(join(receipt.asyncDir, "status.json"));
  if (fault === "missing-output") await rm(receipt.outputPath);
  if (fault === "changed-input")
    await writeFile(join(h.runDirectory, state.taskRef.path), "changed task");
  if (fault === "malformed-status")
    await writeFile(join(receipt.asyncDir, "status.json"), "{");
  if (fault === "symlink-output") {
    await rm(receipt.outputPath);
    await symlink(join(h.runDirectory, state.taskRef.path), receipt.outputPath);
  }
  expect((await h.resume()).status).toBe("blocked");
  expect(h.freshEvents.emitted).toHaveLength(0);
});

test("persisted intent without a receipt is not retried, even after a new runtime is constructed", async () => {
  const h = await setup({ pause: "workflow-scout", noReceipt: true });
  expect(
    (await h.states.loadState()).planning.agentAttempts!.scout.receipt,
  ).toBeUndefined();
  expect((await h.resume()).status).toBe("blocked");
  expect((await h.resume()).status).toBe("blocked");
  expect(h.requests).toHaveLength(1);
  expect(h.freshEvents.emitted).toHaveLength(0);
});

test("intent persistence failure prevents dispatch", async () => {
  const h = await setup({ failIntent: true });
  expect(h.error).toBeInstanceOf(Error);
  expect(h.requests).toHaveLength(0);
  expect((await h.states.loadState()).planning.agentAttempts).toEqual({});
});

test("launch receipt persistence failure never grants permission to retry", async () => {
  const h = await setup({ failReceipt: true });
  const state = await h.states.loadState();
  expect(state.phase).toBe("blocked");
  expect(state.planning.agentAttempts!.scout.receipt).toBeUndefined();
  expect((await h.resume()).status).toBe("blocked");
  expect(h.freshEvents.emitted).toHaveLength(0);
});

test("recovers an output persisted before its State commit, with concurrent resume publishing at most once", async () => {
  const h = await setup({ failContextSave: true });
  expect(h.error).toBeInstanceOf(Error);
  const state = await h.states.loadState();
  expect(state.phase).toBe("gathering-context");
  expect(state.planning.context.scoutRef).toBeUndefined();
  // Limit this scenario to the already completed scout, with no further child needed.
  state.planning.researchRequired = false;
  await h.states.saveState(state);
  const outcomes = await Promise.allSettled([h.resume(), h.resume()]);
  expect(
    outcomes.some(
      (outcome) =>
        outcome.status === "fulfilled" &&
        outcome.value.state.phase === "planning",
    ),
  ).toBe(true);
  expect((await h.states.loadState()).phase).toBe("planning");
  expect(h.freshEvents.emitted).toHaveLength(0);
  expect(h.requests).toHaveLength(1);
});

test("legacy State remains readable but an untracked in-flight stage is not relaunched", async () => {
  const h = await setup({ pause: "workflow-scout" });
  const state = await h.states.loadState();
  delete state.planning.agentAttempts;
  await h.states.saveState(state);
  expect((await h.resume()).status).toBe("blocked");
  expect(h.freshEvents.emitted).toHaveLength(0);
});

test("resume does not hold the Workflow lock while a planner waits, and a concurrent resume does not launch a duplicate", async () => {
  const h = await setup();
  let request: Record<string, unknown> | undefined;
  const bus = new FakeSubagentRpc((input) => {
    request = input;
  });
  const active = resumeWorkflow("recovery", {
    ...h.routing,
    runDirectory: h.runDirectory,
    cwd: h.root,
    subagentExecutor: new SubagentsIntegration(bus, {
      cwd: h.root,
      artifactReader: h.store,
      timeoutMs: 2_000,
    }),
  });
  try {
    await vi.waitFor(() => expect(request).toBeDefined());
    const intent = await h.states.loadState();
    expect((await h.resume()).status).toBe("blocked");
    expect((await h.states.loadState()).stateRevision).toBe(
      intent.stateRevision,
    );
    if (!request) throw Error("No planner request");
    bus.receipt(request, "planner-active");
    await vi.waitFor(async () => {
      expect(
        (await h.states.loadState()).planning.agentAttempts?.["plan-v1"]
          ?.receipt,
      ).toBeDefined();
    });
    expect((await h.states.withLock(() => h.states.loadState())).phase).toBe(
      "planning",
    );
    const pending = await h.resume();
    expect(pending.status).toBe("pending");
    expect(pending.state.phase).toBe("planning");
    expect(h.freshEvents.emitted).toHaveLength(0);
  } finally {
    if (request) bus.complete(request, "planner-active", "complete", plan);
    await active;
  }
  expect(bus.emitted).toHaveLength(2); // One Planner, then the required simplicity review; no duplicate Planner.
  expect((await h.states.loadState()).planning.currentPlanVersion).toBe(1);
});

test("State rejects a planning attempt belonging to another Workflow", async () => {
  const h = await setup({ pause: "workflow-scout" });
  const state = await h.states.loadState();
  state.planning.agentAttempts!.scout.dispatch.ownerRunId = "other-workflow";
  await expect(h.states.saveState(state)).rejects.toThrow(
    "Planning attempt must belong",
  );
  expect(h.freshEvents.emitted).toHaveLength(0);
});

test("live publication and recovery use identical bytes despite a saved-output notice in the completion event", async () => {
  const h = await setup();
  const created = await new PlanningOrchestrator({
    ...h.routing,
    artifactStore: h.store,
    stateStore: h.states,
    subagentExecutor: h.executor,
  }).createPlan({ state: await h.states.loadState(), cwd: h.root });
  await Promise.all(
    (
      [
        ["scout", created.state.planning.context.scoutRef],
        ["research", created.state.planning.context.researchRef],
        ["plan-v1", created.planRef],
      ] as const
    ).map(async ([stage, ref]) => {
      const receipt = created.state.planning.agentAttempts?.[stage]?.receipt;
      if (!receipt || !ref) throw Error("Missing recorded result");
      const output = await readFile(receipt.outputPath, "utf8");
      expect(await h.store.readText(ref)).toBe(output);
      expect(output).not.toContain("Output saved to:");
      expect(
        await h.executor.status(subagentRunId(receipt.runId), receipt),
      ).toMatchObject({
        status: "succeeded",
        result: { status: "succeeded", output },
      });
    }),
  );
});

test("each recorded dispatch matches the request actually emitted", async () => {
  const h = await setup();
  const state = await h.states.loadState();
  for (const { payload } of h.events.emitted) {
    const request = childRequest(payload);
    const attempt = state.planning.agentAttempts![String(request.nodeId)];
    expect(attempt.dispatch.requestId).toBe(request.requestId);
    expect(attempt.receipt?.requestId).toBe(request.requestId);
    expect(attempt.launch?.launchContractDigest).toBe(
      attempt.receipt?.launchContractDigest,
    );
  }
});

test.each([
  "model",
  "thinking",
  "skills",
  "tools",
  "definitionDigest",
  "launchContractDigest",
])(
  "recovery rejects current %s drift without replacing historical evidence or dispatching",
  async (dimension) => {
    const h = await setup({ pause: "pi-ketch.researcher" });
    const before = await h.states.loadState();
    const historical = before.planning.agentAttempts!.research;
    h.events.complete(
      h.requests[1],
      historical.receipt!.runId,
      "complete",
      "historical research",
    );
    const result = await h.resume(async (input, binding) => {
      const launch = await fakeLaunchResolver(input, binding);
      if (dimension === "model") launch.model = "fake/other";
      else if (dimension === "thinking") launch.thinking = "high";
      else if (dimension === "skills")
        launch.skills = [
          {
            name: "other",
            sourceDigest: "a".repeat(64),
            contentDigest: "b".repeat(64),
          },
        ];
      else if (dimension === "tools") launch.tools = ["read"];
      else if (dimension === "definitionDigest")
        launch.definitionDigest = "c".repeat(64);
      else launch.launchContractDigest = "d".repeat(64);
      return launch;
    });
    expect(result.status).toBe("blocked");
    expect(result.state.planning.agentAttempts!.research).toEqual(historical);
    expect(h.freshEvents.emitted).toHaveLength(0);
  },
);
