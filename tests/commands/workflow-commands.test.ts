import { describe, expect, test, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { WorkflowState } from "../../src/core/workflow/state.ts";
import {
  registerWorkflowCommands,
  type WorkflowCommandRuntime,
} from "../../src/commands/index.ts";
import type { StartedWorkflow } from "../../src/runtime/orchestrator/start-workflow.ts";
import type { WorkflowId } from "../../src/types.ts";
import { StateNotFoundError } from "../../src/runtime/persistence/state-store.ts";
import { phaseCWorkflow } from "../fakes/phase-c-workflow.ts";

type TestContext = ExtensionCommandContext & {
  notify: ReturnType<typeof vi.fn>;
};

function context(): TestContext {
  const notify = vi.fn();
  return {
    cwd: "/tmp/project",
    ui: { notify },
    notify,
  } as unknown as TestContext;
}

function registration(runtime: WorkflowCommandRuntime) {
  const commands = new Map<
    string,
    { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
  >();
  const api = {
    registerCommand(
      name: string,
      options: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) {
      commands.set(name, options);
    },
  } as unknown as Pick<ExtensionAPI, "registerCommand">;
  registerWorkflowCommands(api, { runtime });
  return commands;
}

function minimalState(): WorkflowState {
  return {
    schemaVersion: 1,
    workflowId: "workflow-1" as WorkflowId,
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
    start: vi.fn(
      async () =>
        ({
          workflowId: "workflow-1" as WorkflowId,
          runDirectory: "/tmp/project/.pi/orchestrator/runs/workflow-1",
          taskRef: minimalState().taskRef,
          state: minimalState(),
          context: { state: minimalState() },
          artifactStore: {},
          stateStore: {},
        }) as unknown as StartedWorkflow,
    ),
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

  test("renders runtime failures without exposing credentials", async () => {
    const commandRuntime = makeRuntime({
      resume: vi.fn(async () => {
        throw new Error("authorization=Bearer super-secret-token");
      }),
    });
    const commands = registration(commandRuntime);
    const ctx = context();

    await commands.get("wf-resume")!.handler("workflow-1", ctx);

    const message = notifications(ctx).mock.calls[0]?.[0] as string;
    expect(message).toMatch(/error|failed/i);
    expect(message).not.toContain("super-secret-token");
  });
});
