import { WorkflowOwnership } from "../../src/runtime/orchestrator/workflow-ownership.ts";
import { CLARIFICATION_COMPLETE_EVENT } from "../../src/runtime/integrations/clarification.ts";
import { runClarificationRound } from "../../src/runtime/orchestrator/clarification.ts";
import { fakeLaunchResolver } from "../fakes/agent-launch.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../src/core/schema.ts";
import type { WorkflowState } from "../../src/core/workflow/state.ts";
import {
  createWorkflowCommandRuntime,
  registerWorkflowCommands,
  parseWorkflowTask,
  type WorkflowCommandRuntime,
} from "../../src/commands/index.ts";
import { ArtifactStore } from "../../src/runtime/persistence/artifact-store.ts";
import { workflowId } from "../../src/types.ts";
import { StateNotFoundError } from "../../src/runtime/persistence/state-store.ts";
import { phaseCWorkflow } from "../fakes/phase-c-workflow.ts";
import { plan, configuration as defaults } from "../fakes/coding-scenario.ts";
import { jevPolicy } from "../fakes/jev-policy.ts";
import { FakeJevDecisionClient } from "../fakes/index.ts";
import type { EventBus } from "../../src/runtime/integrations/subagents.ts";
import { FakeSubagentRpc } from "../fakes/subagent-rpc.ts";
import { PLANNOTATOR_REQUEST_CHANNEL } from "../../src/runtime/integrations/plannotator.ts";
import {
  makeExtensionApiFixture,
  makeExtensionCommandContextFixture,
} from "../fakes/typed-boundaries.ts";

type TestContext = ExtensionCommandContext & {
  notify: ReturnType<typeof vi.fn>;
};

function context(cwd = "/tmp/project"): TestContext {
  const notify = vi.fn();
  return makeExtensionCommandContextFixture({
    cwd,
    ui: { notify },
    notify,
  });
}

function registration(runtime: WorkflowCommandRuntime) {
  const commands = new Map<
    string,
    { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
  >();
  const api = makeExtensionApiFixture({
    registerCommand(
      name: string,
      options: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) {
      commands.set(name, options);
    },
  });
  registerWorkflowCommands(api, { runtime });
  return commands;
}

function minimalState(): WorkflowState {
  return {
    schemaVersion: 1,
    workflowId: workflowId("workflow-1"),
    stateRevision: 0,
    playbook: "feature",
    phase: "planning",
    taskRef: {
      kind: "task",
      path: "context/task.md",
      schemaVersion: 1,
      sha256: "a".repeat(64),
    },
    planning: { context: {}, currentPlanVersion: 0 },
    coding: { implementationRevision: 0, reviewRound: 0 },
    counters: {
      automatedFixRoundsUsed: 0,
      strongerRetriesUsed: 0,
      humanCodeFeedbackRounds: 0,
    },
    external: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeRuntime(
  overrides: Partial<WorkflowCommandRuntime> = {},
): WorkflowCommandRuntime {
  return {
    start: vi.fn(async () => {
      const state = minimalState();
      return {
        workflowId: workflowId("workflow-1"),
        runDirectory: "/tmp/project/.pi/orchestrator/runs/workflow-1",
        taskRef: state.taskRef,
        state,
        context: { state },
        artifactStore: new ArtifactStore(
          "/tmp/project/.pi/orchestrator/runs/workflow-1",
        ),
        stateStore: { saveState: async (next: WorkflowState) => next },
      };
    }),
    resume: vi.fn(async () => ({
      status: "pending" as const,
      state: minimalState(),
      phase: "planning" as const,
    })),
    loadState: vi.fn(async () => minimalState()),
    ...overrides,
  };
}

function notifications(ctx: TestContext): ReturnType<typeof vi.fn> {
  return ctx.notify;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw Error("Expected an event record");
  return value;
}

describe("ORCH-019 workflow commands", () => {
  test("captures explicit method intent flags without guessing from task prose", async () => {
    expect(parseWorkflowTask("--tdd preserve behavior")).toEqual({
      task: "preserve behavior",
      developmentIntent: "TDD",
    });
    expect(parseWorkflowTask("--behavior-free update README")).toEqual({
      task: "update README",
      developmentIntent: "BEHAVIOR_FREE",
    });
    expect(parseWorkflowTask("ordinary task")).toEqual({
      task: "ordinary task",
    });
    expect(() => parseWorkflowTask("--tdd")).toThrow(/Usage/u);
    expect(() => parseWorkflowTask("--tdd --behavior-free task")).toThrow(
      /one Development Intent/u,
    );
    const runtime = makeRuntime();
    await registration(runtime)
      .get("wf-feature")!
      .handler("--tdd preserve behavior", context());
    expect(runtime.start).toHaveBeenCalledWith({
      task: "preserve behavior",
      playbook: "feature",
      developmentIntent: "TDD",
    });
  });
  test("registers exactly the documented commands", () => {
    const commands = registration(makeRuntime());
    expect([...commands.keys()]).toEqual([
      "wf-new",
      "wf-feature",
      "wf-bugfix",
      "wf-hotfix",
      "wf-chore",
      "wf-resume",
      "wf-status",
    ]);
  });

  test("normalizes a valid playbook command and delegates to runtime", async () => {
    const start = vi.fn(async () =>
      makeRuntime().start({ task: "x", playbook: "feature" }),
    );
    const commandRuntime = makeRuntime({ start });
    const commands = registration(commandRuntime);
    const ctx = context();

    await commands.get("wf-feature")!.handler("  add a feature  ", ctx);

    expect(start).toHaveBeenCalledWith({
      task: "add a feature",
      playbook: "feature",
    });
    expect(notifications(ctx)).toHaveBeenCalledWith(
      expect.stringContaining("workflow-1"),
      "info",
    );
  });

  test("rejects invalid start input without calling runtime", async () => {
    const commandRuntime = makeRuntime();
    const commands = registration(commandRuntime);
    const ctx = context();

    await commands.get("wf-feature")!.handler("   ", ctx);

    const start = commandRuntime.start;
    expect(start).not.toHaveBeenCalled();
    expect(notifications(ctx)).toHaveBeenCalledWith(
      expect.stringMatching(/usage|task/i),
      "error",
    );
  });

  test("resume delegates only to the reconciliation runtime entrypoint", async () => {
    const commandRuntime = makeRuntime();
    const commands = registration(commandRuntime);
    const ctx = context();

    await commands.get("wf-resume")!.handler(" workflow-1 ", ctx);

    const resume = commandRuntime.resume;
    expect(resume).toHaveBeenCalledWith("workflow-1");
    expect(notifications(ctx)).toHaveBeenCalledWith(
      expect.stringContaining("pending"),
      "info",
    );
  });

  test("rejects invalid resume/status arguments and unknown workflow safely", async () => {
    const commandRuntime = makeRuntime({
      loadState: vi.fn(async () => {
        throw new StateNotFoundError("/tmp/project/missing/state.json");
      }),
    });
    const commands = registration(commandRuntime);
    const invalidResume = context();
    await commands.get("wf-resume")!.handler("../victim", invalidResume);
    const resume = commandRuntime.resume;
    expect(resume).not.toHaveBeenCalled();
    expect(notifications(invalidResume)).toHaveBeenCalledWith(
      expect.stringMatching(/safe|path|workflow id/i),
      "error",
    );

    const unknown = context();
    await commands.get("wf-status")!.handler("missing", unknown);
    expect(notifications(unknown)).toHaveBeenCalledWith(
      expect.stringMatching(/not found|does not exist/i),
      "error",
    );
  });

  test("status is a read-only projection and never mutates the loaded State", async () => {
    const source = minimalState();
    const before = structuredClone(source);
    const commandRuntime = makeRuntime({
      loadState: vi.fn(async () => source),
    });
    const commands = registration(commandRuntime);
    const ctx = context();

    await commands.get("wf-status")!.handler("workflow-1", ctx);

    expect(source).toEqual(before);
    expect(notifications(ctx)).toHaveBeenCalledWith(
      expect.stringContaining("workflow-1"),
      "info",
    );
  });

  test("status delegates optional Worker evidence to the read-only projection", async () => {
    const commandRuntime = makeRuntime({
      readStatusEvidence: vi.fn(async () => ({
        worker: {
          requestId: "request-1",
          ownerRunId: "workflow-1",
          nodeId: "worker-node-1",
          runId: "run-1",
          launchStatus: "observed" as const,
        },
      })),
    });
    const commands = registration(commandRuntime);
    const ctx = context();

    await commands.get("wf-status")!.handler("workflow-1", ctx);

    expect(notifications(ctx)).toHaveBeenCalledWith(
      expect.stringContaining("run=run-1"),
      "info",
    );
  });

  test("real reconciliation resume does not duplicate an ambiguous Worker", async () => {
    const workflow = await phaseCWorkflow({ workers: ["ambiguous"] });
    try {
      await workflow.createPlan();
      await workflow.settlePlan();
      await expect(workflow.implement()).rejects.toThrow();
      const workersBefore = workflow.children.filter(
        (child) => child.agent === "worker",
      ).length;
      const commandRuntime = makeRuntime({ resume: () => workflow.resume() });
      const commands = registration(commandRuntime);
      const ctx = context();

      await commands.get("wf-resume")!.handler("workflow-1", ctx);

      expect(
        workflow.children.filter((child) => child.agent === "worker"),
      ).toHaveLength(workersBefore);
      expect((await workflow.load()).phase).toBe("blocked");
    } finally {
      await workflow.cleanup();
    }
  });

  test("production command runtime continues through Worker, reviews, Code Gate, and duplicate resume", async () => {
    const workflow = await phaseCWorkflow({
      validations: ["failed", "passed"],
      rounds: [{ action: "RETRY" }],
    });
    try {
      const runtimeEvents: EventBus = {
        on: (event, listener) => workflow.events.on(event, listener),
        emit: (event, payload) =>
          event === PLANNOTATOR_REQUEST_CHANNEL
            ? workflow.gateEvents.emit(event, payload)
            : workflow.events.emit(event, payload),
      };
      const ownership = new WorkflowOwnership(workflow.repositoryCwd, "root-1");
      await ownership.initialize(await workflow.load(), workflow.stateStore);
      const runtime = createWorkflowCommandRuntime(
        runtimeEvents,
        workflow.repositoryCwd,
        {
          ownership,
          launchResolver: fakeLaunchResolver,
          configuration: workflow.configuration,
          jevDecisionClient: workflow.jevDecisionClient,
          validationExecutor: workflow.validationExecutor,
        },
      );
      const commands = registration(runtime);
      const resume = async () => {
        const ctx = context(workflow.repositoryCwd);
        await commands.get("wf-resume")!.handler("full-fake", ctx);
        return workflow.load();
      };

      expect((await workflow.load()).phase).toBe("planning");
      expect((await resume()).phase).toBe("awaiting-plan-review");
      workflow.events.deliver("plannotator:review-result", {
        reviewId: "plan-1",
        approved: true,
      });
      await vi.waitFor(
        async () => expect((await workflow.load()).phase).toBe("completed"),
        { timeout: 10_000 },
      );
      // Synchronous Code result already persisted and normal continuation completed.
      expect((await workflow.load()).coding.latestCodeReviewRef).toBeDefined();
      expect((await resume()).phase).toBe("completed");
      expect(
        workflow.children.filter((child) => child.agent === "worker"),
      ).toHaveLength(2);
      expect(
        workflow.gates.filter((gate) => gate.action === "code-review"),
      ).toHaveLength(1);
      expect(
        workflow.jevRequests.filter(
          (request) => "decision" in request.questions,
        ),
      ).toHaveLength(2);
    } finally {
      await workflow.cleanup();
    }
  }, 10_000);

  test("production clarification completion automatically continues to the mandatory Plan Gate; wake hints cannot answer", async () => {
    const workflow = await phaseCWorkflow({ clarification: true });
    try {
      const events: EventBus = {
        on: (event, listener) => workflow.events.on(event, listener),
        emit: (event, payload) =>
          event === PLANNOTATOR_REQUEST_CHANNEL
            ? workflow.gateEvents.emit(event, payload)
            : workflow.events.emit(event, payload),
      };
      const ownership = new WorkflowOwnership(workflow.repositoryCwd, "root-1");
      await ownership.initialize(await workflow.load(), workflow.stateStore);
      const runtime = createWorkflowCommandRuntime(
        events,
        workflow.repositoryCwd,
        {
          ownership,
          launchResolver: fakeLaunchResolver,
          configuration: workflow.configuration,
          jevDecisionClient: workflow.jevDecisionClient,
          clarificationPort: {
            setup: async () => ({ rootSessionId: "root-1", skills: [] }),
            request: async () => ({ status: "pending" }),
          },
        },
      );
      const waiting = await runtime.resume("full-fake");
      expect(waiting.state.phase).toBe("clarifying");
      const requestHash =
        waiting.state.planning.clarificationRequestRef!.sha256;
      workflow.events.deliver(CLARIFICATION_COMPLETE_EVENT, {
        workflowId: "full-fake",
        requestHash,
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect((await workflow.load()).phase).toBe("clarifying");
      expect(
        workflow.children.filter((child) => child.agent === "planner"),
      ).toHaveLength(0);
      const confirmed = await runClarificationRound(
        waiting.state,
        workflow,
        {
          requestHash,
          rootSessionId: "root-1",
          summary: "Preserve the existing boundary; all decisions settled.",
        },
        async (_id, questions) => ({
          status: "answered",
          questions,
          cancelled: false,
          answers: { [questions[0].question]: "Confirm" },
          selections: [
            {
              question: questions[0].question,
              header: "Confirm",
              value: "Confirm",
              labels: ["Confirm"],
              selectedIndices: [1],
            },
          ],
        }),
      );
      expect(confirmed.phase).toBe("planning");
      workflow.events.deliver(CLARIFICATION_COMPLETE_EVENT, {
        workflowId: "full-fake",
        requestHash: "a".repeat(64),
      });
      expect((await workflow.load()).phase).toBe("planning");
      workflow.events.deliver(CLARIFICATION_COMPLETE_EVENT, {
        workflowId: "full-fake",
        requestHash,
      });
      await vi.waitFor(
        async () =>
          expect((await workflow.load()).planning.planReview).toBeDefined(),
        { timeout: 10000 },
      );
      expect(
        workflow.children.filter((child) => child.agent === "planner"),
      ).toHaveLength(1);
      expect((await workflow.load()).planning.approvedPlanRef).toBeUndefined();
      expect(
        workflow.children.filter((child) => child.agent === "worker"),
      ).toHaveLength(0);
    } finally {
      await workflow.cleanup();
    }
  });

  test("missing command runtime configuration blocks before Jev or Worker continuation", async () => {
    const workflow = await phaseCWorkflow();
    try {
      await workflow.createPlan();
      await workflow.settlePlan();
      const runtime = createWorkflowCommandRuntime(
        workflow.events,
        workflow.repositoryCwd,
      );
      const commands = registration(runtime);
      await commands
        .get("wf-resume")!
        .handler("full-fake", context(workflow.repositoryCwd));

      const state = await workflow.load();
      expect(state.phase).toBe("blocked");
      expect(state.block?.reason).toBe("operator-attention-required");
      expect(workflow.jevRequests).toHaveLength(0);
      expect(
        workflow.children.filter((child) => child.agent === "worker"),
      ).toHaveLength(0);
    } finally {
      await workflow.cleanup();
    }
  });

  test("default resume runtime reconciles a persisted Plan Gate instead of blocking for missing adapters", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "pi-orchestrator-command-runtime-"),
    );
    const childRequests: Record<string, unknown>[] = [];
    let statusReads = 0;
    const configuration = {
      ...defaults,
      jev: jevPolicy(root),
    };
    const rpc = new FakeSubagentRpc((request, bus) => {
      childRequests.push(request);
      const runId = `${String(request.agent)}-1`;
      bus.receipt(request, runId);
      queueMicrotask(() =>
        bus.complete(
          request,
          runId,
          "complete",
          request.agent === "planner"
            ? plan
            : request.agent === "plan-simplicity-reviewer"
              ? '{"schemaVersion":1,"findings":[]}'
              : "facts",
        ),
      );
    });
    const events: EventBus = {
      on: (event, listener) => rpc.on(event, listener),
      emit: (event, payload) => {
        if (event === PLANNOTATOR_REQUEST_CHANNEL) {
          const request = asRecord(payload);
          if (
            typeof request.action !== "string" ||
            typeof request.respond !== "function"
          ) {
            throw Error("Invalid Plannotator request");
          }
          if (request.action === "plan-review") {
            request.respond({
              status: "handled",
              result: { status: "pending", reviewId: "command-plan-1" },
            });
            // The result notification races the durable binding; its payload is not approval authority.
            rpc.deliver("plannotator:review-result", {
              reviewId: "command-plan-1",
              approved: true,
            });
          } else if (request.action === "review-status") {
            statusReads++;
            request.respond({
              status: "handled",
              result: { status: "pending", reviewId: "command-plan-1" },
            });
          }
          return;
        }
        rpc.emit(event, payload);
      },
    };
    try {
      const runtime = createWorkflowCommandRuntime(events, root, {
        ownership: new WorkflowOwnership(root, "root-1"),
        launchResolver: fakeLaunchResolver,
        configuration,
        jevDecisionClient: new FakeJevDecisionClient(),
      });
      const started = await runtime.start({ task: "smoke", playbook: "chore" });
      expect(started.state.phase).toBe("awaiting-plan-review");
      expect(started.workflowId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(configuration.jev.runtimePolicy!.grant).not.toHaveProperty(
        "workflowId",
      );
      expect(started.state.jevUsage!.authorizationRef).toBeDefined();
      expect(childRequests.map((request) => request.agent)).toEqual([
        "workflow-scout",
        "planner",
        "plan-simplicity-reviewer",
      ]);

      await vi.waitFor(() => expect(statusReads).toBe(1));
      expect(
        (await runtime.loadState(started.workflowId)).planning.approvedPlanRef,
      ).toBeUndefined();
      rpc.deliver("plannotator:review-result", {
        reviewId: "unrelated",
        approved: true,
      });
      const reconciled = await runtime.resume(started.workflowId);
      expect(reconciled.status).toBe("pending");
      expect(reconciled.state.phase).toBe("awaiting-plan-review");
      const planner = childRequests.find(
        (request) => request.agent === "planner",
      );
      expect(planner?.ownerRunId).toBe(started.workflowId);
      expect(planner?.task).toContain(
        JSON.stringify({ ref: started.taskRef, content: "smoke" }),
      );
      expect(planner?.task).toContain(
        JSON.stringify({
          ref: started.state.planning.context.scoutRef,
          content: "facts",
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("renders runtime failures without exposing credentials", async () => {
    const commandRuntime = makeRuntime({
      resume: vi.fn(async () => {
        throw new Error("authorization=Bearer super-secret-token");
      }),
    });
    const commands = registration(commandRuntime);
    const ctx = context();

    await commands.get("wf-resume")!.handler("workflow-1", ctx);

    const message: unknown = notifications(ctx).mock.calls[0]?.[0];
    expect(typeof message).toBe("string");
    if (typeof message !== "string") throw new Error("Missing notification");
    expect(message).toMatch(/error|failed/i);
    expect(message).not.toContain("super-secret-token");
  });
});
