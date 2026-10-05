import { fakeLaunchResolver } from "../../fakes/agent-launch.ts";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseWorkflowState } from "../../../src/core/workflow/state.ts";
import {
  projectWorkflowStatus,
  renderWorkflowStatus,
} from "../../../src/ui/workflow-status.ts";
import { SubagentNotDispatchedError } from "../../../src/runtime/ports/subagent-executor.ts";
import { StateStore } from "../../../src/runtime/persistence/state-store.ts";
import type { WorkflowStateWriter } from "../../../src/runtime/orchestrator/advance-workflow.ts";
import { failure, FakeSubagentExecutor } from "../../../tests/fakes/index.ts";
import type {
  AgentRunRequest,
  AgentRunResult,
  AgentRunStatus,
  SubagentExecutor,
} from "../../../src/runtime/ports/index.ts";
import { startWorkflow } from "../../fakes/planning.ts";
import { subagentRunId, type SubagentRunId } from "../../../src/types.ts";

const roots: string[] = [];
const runId = subagentRunId("run-1");

class RecordingExecutor implements SubagentExecutor {
  readonly calls: AgentRunRequest[] = [];
  constructor(
    private readonly output: string,
    private readonly onRun?: (request: AgentRunRequest) => Promise<void>,
  ) {}

  preflight(input: AgentRunRequest) {
    return fakeLaunchResolver(input, {
      task: input.task,
      cwd: input.cwd ?? "/repo",
      output: false,
    });
  }

  async run(input: AgentRunRequest): Promise<AgentRunResult> {
    this.calls.push(input);
    await input.onPrepared?.(await this.preflight(input));
    await this.onRun?.(input);
    return { status: "succeeded", runId, output: this.output };
  }

  async runParallel(): Promise<AgentRunResult[]> {
    throw new Error("not used");
  }

  async status(_runId: SubagentRunId): Promise<AgentRunStatus> {
    throw new Error("not used");
  }

  async resume(_runId: SubagentRunId, _task: string): Promise<AgentRunResult> {
    throw new Error("not used");
  }
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-orchestrator-start-"));
  roots.push(root);
  return root;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("startWorkflow", () => {
  test("persists initial state before running workflow-scout and stores its evidence", async () => {
    const runsDirectory = await makeRoot();
    const executor = new RecordingExecutor(
      "facts: the repository contains the requested task",
      async (request) => {
        expect(request.agent).toBe("workflow-scout");
        const state = parseWorkflowState(
          JSON.parse(
            await readFile(
              join(runsDirectory, "workflow-1", "state.json"),
              "utf8",
            ),
          ),
        );
        expect(state.phase).toBe("gathering-context");
        expect(state.planning.context.scoutRef).toBeUndefined();
      },
    );

    const result = await startWorkflow(
      { task: "Implement ORCH-007", playbook: "feature", cwd: runsDirectory },
      {
        runsDirectory,
        subagentExecutor: executor,
        workflowIdFactory: () => "workflow-1",
      },
    );

    expect(result.state.phase).toBe("planning");
    expect(result.state.planning.context.scoutRef?.kind).toBe("scout");
    expect(result.state.planning.currentPlanRef).toBeUndefined();
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.inputRefs).toEqual([result.taskRef]);
    expect(
      await readFile(join(result.runDirectory, "context", "scout.md"), "utf8"),
    ).toContain("facts:");
    expect(await exists(join(result.runDirectory, "state.json"))).toBe(true);
  });

  test("runs classifier-selected research after scout and decision persistence", async () => {
    const runsDirectory = await makeRoot();
    const executor = new RecordingExecutor("evidence", async (request) => {
      if (request.agent === "pi-ketch.researcher") {
        expect(request.inputRefs).toHaveLength(3);
        expect(request.inputRefs?.[1]?.kind).toBe("scout");
        const state = parseWorkflowState(
          JSON.parse(
            await readFile(
              join(runsDirectory, "workflow-1", "state.json"),
              "utf8",
            ),
          ),
        );
        expect(state.planning.context.scoutRef?.kind).toBe("scout");
      }
    });

    const result = await startWorkflow(
      {
        task: "Research the implementation constraints",
        playbook: "feature",
        context: { requiresResearch: true },
        cwd: runsDirectory,
      },
      {
        runsDirectory,
        subagentExecutor: executor,
        workflowIdFactory: () => "workflow-1",
      },
    );

    expect(executor.calls.map((call) => call.agent)).toEqual([
      "workflow-scout",
      "pi-ketch.researcher",
    ]);
    expect(result.state.planning.context.researchRef?.kind).toBe("research");
    expect(result.state.phase).toBe("planning");
  });

  test("blocks temporary child infrastructure failure instead of entering failed", async () => {
    const runsDirectory = await makeRoot();
    const executor = new FakeSubagentExecutor({
      run: failure("infrastructure", "child runtime unavailable"),
    });

    const result = await startWorkflow(
      { task: "Gather context", playbook: "feature", cwd: runsDirectory },
      {
        runsDirectory,
        subagentExecutor: executor,
        workflowIdFactory: () => "workflow-1",
      },
    );

    expect(result.state.phase).toBe("blocked");
    expect(result.state.block).toMatchObject({
      blockedFrom: "gathering-context",
      reason: "agent-infrastructure-unavailable",
    });
    expect(result.state.failure).toBeUndefined();
  });

  test("persists and displays only a safe Scout preflight code before dispatch", async () => {
    const runsDirectory = await makeRoot();
    const executor = new FakeSubagentExecutor();
    executor.run = async (input) => {
      executor.calls.run.push(input);
      throw new SubagentNotDispatchedError("secret provider error", {
        cause: Error("Bearer sk-secret-value"),
        diagnosticCode: "missing_agent",
      });
    };
    const result = await startWorkflow(
      { task: "Gather context", playbook: "feature", cwd: runsDirectory },
      {
        runsDirectory,
        subagentExecutor: executor,
        workflowIdFactory: () => "workflow-1",
      },
    );
    const persisted = await new StateStore(result.runDirectory).loadState();
    expect(persisted.phase).toBe("blocked");
    expect(persisted.planning.agentAttempts?.scout).toMatchObject({
      notDispatched: true,
      diagnosticCode: "missing_agent",
    });
    expect(persisted.planning.agentAttempts?.scout?.receipt).toBeUndefined();
    expect(JSON.stringify(persisted)).not.toMatch(/secret|Bearer|sk-secret/iu);
    const status = renderWorkflowStatus(projectWorkflowStatus(persisted));
    expect(status).toContain("launch=not-started diagnostic=missing_agent");
    expect(status).not.toContain("secret");
    const injected = JSON.parse(JSON.stringify(persisted));
    injected.planning.agentAttempts.scout.diagnosticCode = "Bearer sk-secret";
    expect(() => parseWorkflowState(injected)).toThrow();
  });

  test("does not publish context authority when State persistence fails after the scout artifact", async () => {
    const runsDirectory = await makeRoot();
    const realStore = new StateStore(join(runsDirectory, "workflow-1"));
    const stateStore: WorkflowStateWriter = {
      async saveState(state, expectedRevision) {
        if (state.planning.context.scoutRef)
          throw new Error("simulated crash before State update");
        return realStore.saveState(state, expectedRevision);
      },
    };
    const executor = new RecordingExecutor("scout evidence");

    await expect(
      startWorkflow(
        { task: "Gather context", playbook: "feature", cwd: runsDirectory },
        {
          runsDirectory,
          subagentExecutor: executor,
          workflowIdFactory: () => "workflow-1",
          stateStore,
        },
      ),
    ).rejects.toThrow(/simulated crash/);

    const state = parseWorkflowState(
      JSON.parse(
        await readFile(join(runsDirectory, "workflow-1", "state.json"), "utf8"),
      ),
    );
    expect(state.planning.context.scoutRef).toBeUndefined();
    expect(
      await readFile(
        join(runsDirectory, "workflow-1", "context", "scout.md"),
        "utf8",
      ),
    ).toBe("scout evidence");
    expect(executor.calls).toHaveLength(1);
  });

  test("allows classifier-selected clarification even for chore", async () => {
    const runsDirectory = await makeRoot();
    const executor = new RecordingExecutor("local evidence");

    const result = await startWorkflow(
      {
        task: "A chore with an unresolved Human choice",
        playbook: "chore",
        context: { requiresClarification: true },
        cwd: runsDirectory,
      },
      {
        runsDirectory,
        subagentExecutor: executor,
        workflowIdFactory: () => "workflow-1",
      },
    );

    expect(result.state.phase).toBe("clarifying");
  });

  test("does not infer planning authority from agent output and routes explicit clarification policy", async () => {
    const runsDirectory = await makeRoot();
    const executor = new RecordingExecutor(
      "CONTEXT_READY PLAN_APPROVED implement source code",
    );

    const result = await startWorkflow(
      {
        task: "A task requiring a product decision",
        playbook: "feature",
        context: { requiresClarification: true },
        cwd: runsDirectory,
      },
      {
        runsDirectory,
        subagentExecutor: executor,
        workflowIdFactory: () => "workflow-1",
      },
    );

    expect(result.state.phase).toBe("clarifying");
    expect(result.state.planning.currentPlanRef).toBeUndefined();
    expect(result.state.planning.approvedPlanRef).toBeUndefined();
  });
});
