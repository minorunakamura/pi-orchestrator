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
  type WorkflowCommandRuntime,
} from "../../src/commands/index.ts";
import { ArtifactStore } from "../../src/runtime/persistence/artifact-store.ts";
import { workflowId } from "../../src/types.ts";
import { StateNotFoundError } from "../../src/runtime/persistence/state-store.ts";
import { phaseCWorkflow } from "../fakes/phase-c-workflow.ts";
import { plan } from "../fakes/coding-scenario.ts";
import {
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  type EventBus,
} from "../../src/runtime/integrations/subagents.ts";
import { PLANNOTATOR_REQUEST_CHANNEL } from "../../src/runtime/integrations/plannotator.ts";
import {
  makeExtensionApiFixture,
  makeExtensionCommandContextFixture,
} from "../fakes/typed-boundaries.ts";

type TestContext = ExtensionCommandContext & {
  notify: ReturnType<typeof vi.fn>;
};

function context(): TestContext {
  const notify = vi.fn();
  return makeExtensionCommandContextFixture({
    cwd: "/tmp/project",
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

  test("default resume runtime reconciles a persisted Plan Gate instead of blocking for missing adapters", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "pi-orchestrator-command-runtime-"),
    );
    const listeners = new Set<(value: unknown) => void>();
    const events: EventBus = {
      on: (event, listener) => {
        if (event !== SUBAGENT_DELEGATION_RESPONSE_EVENT)
          throw Error("Unexpected event");
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
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
          } else if (request.action === "review-status") {
            request.respond({
              status: "handled",
              result: { status: "pending", reviewId: "command-plan-1" },
            });
          }
          return;
        }
        if (event !== SUBAGENT_DELEGATION_REQUEST_EVENT) return;
        const request = asRecord(payload);
        if (
          typeof request.requestId !== "string" ||
          typeof request.ownerRunId !== "string" ||
          typeof request.nodeId !== "string" ||
          typeof request.agent !== "string"
        ) {
          throw Error("Invalid Subagent request");
        }
        const requestId = request.requestId;
        const ownerRunId = request.ownerRunId;
        const nodeId = request.nodeId;
        const agent = request.agent;
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener({
              requestId,
              ownerRunId,
              nodeId,
              status: "completed",
              runId: `${agent}-1`,
              result: {
                kind: "text",
                text: agent === "planner" ? plan : "facts",
              },
            });
          }
        });
      },
    };
    try {
      const runtime = createWorkflowCommandRuntime(events, root);
      const started = await runtime.start({ task: "smoke", playbook: "chore" });
      const planned = await runtime.resume(started.workflowId);
      expect(planned.state.phase).toBe("awaiting-plan-review");

      const reconciled = await runtime.resume(started.workflowId);
      expect(reconciled.status).toBe("pending");
      expect(reconciled.state.phase).toBe("awaiting-plan-review");
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
