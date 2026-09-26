import { readFile, readdir, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { advanceWorkflow } from "../../../src/runtime/orchestrator/advance-workflow.ts";
import { PlanningOrchestrator } from "../../../src/runtime/orchestrator/planning-orchestrator.ts";
import { startWorkflow } from "../../../src/runtime/orchestrator/start-workflow.ts";
import { StateStore } from "../../../src/runtime/persistence/state-store.ts";
import {
  FakeClarificationPort,
  FakeSubagentExecutor,
} from "../../../tests/fakes/index.ts";
import type { PlaybookContext } from "../../../src/core/playbooks/policy.ts";
import type { AgentRunResult } from "../../../src/runtime/ports/index.ts";
import type { SubagentRunId } from "../../../src/types.ts";

const roots: string[] = [];
const runId = "run-1" as unknown as SubagentRunId;

const validPlan = `# Plan

## Scope / Requirements
Implement the requested behavior without changing unrelated code.

## Architecture / Design
Keep parsing and orchestration behind their existing boundaries.

## Implementation Plan
1. Add focused tests.
2. Implement the smallest safe change.

## Validation Contract

\`\`\`orchestrator-validation
{
  "schemaVersion": 1,
  "checks": [
    {
      "id": "tests",
      "type": "command",
      "command": "pnpm test",
      "cwd": ".",
      "required": true
    }
  ]
}
\`\`\`
`;

function succeeded(output: string): AgentRunResult {
  return { status: "succeeded", runId, output };
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-orchestrator-planning-"));
  roots.push(root);
  return root;
}

async function makeStarted(
  runsDirectory: string,
  executor: FakeSubagentExecutor,
  context?: PlaybookContext,
) {
  return startWorkflow(
    {
      task: "Implement the planning change",
      playbook: "feature",
      context,
    },
    {
      runsDirectory,
      subagentExecutor: executor,
      workflowIdFactory: () => "workflow-1",
    },
  );
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("PlanningOrchestrator ORCH-008", () => {
  test("invokes Human clarification with explicit context refs and persists the answer before completion", async () => {
    const runsDirectory = await makeRoot();
    const executor = new FakeSubagentExecutor({
      run: { type: "result", value: succeeded("local facts") },
    });
    const started = await makeStarted(runsDirectory, executor, {
      requiresClarification: true,
    });
    const clarification = new FakeClarificationPort({
      request: {
        type: "result",
        value: {
          status: "provided",
          answer: "Use the existing parser boundary.",
        },
      },
    });
    const orchestrator = new PlanningOrchestrator({
      artifactStore: started.artifactStore,
      stateStore: started.stateStore,
      subagentExecutor: executor,
      clarificationPort: clarification,
    });

    const result = await orchestrator.requestClarification({
      state: started.state,
      prompt: "Which parser boundary should the plan preserve?",
    });

    expect(clarification.calls[0]).toMatchObject({
      prompt: "Which parser boundary should the plan preserve?",
      contextRefs: [started.taskRef, started.state.planning.context.scoutRef],
    });
    expect(result.status).toBe("provided");
    expect(result.state.phase).toBe("planning");
    expect(result.state.planning.context.clarificationRef?.path).toBe(
      "context/clarification.md",
    );
    await expect(
      readFile(
        join(started.runDirectory, "context", "clarification.md"),
        "utf8",
      ),
    ).resolves.toContain("Use the existing parser boundary.");
  });

  test("keeps a declined Human decision in clarifying without inventing a fact or plan", async () => {
    const runsDirectory = await makeRoot();
    const executor = new FakeSubagentExecutor({
      run: { type: "result", value: succeeded("facts only") },
    });
    const started = await makeStarted(runsDirectory, executor, {
      requiresClarification: true,
    });
    const clarification = new FakeClarificationPort({
      request: {
        type: "result",
        value: { status: "declined", reason: "Need a product owner." },
      },
    });
    const orchestrator = new PlanningOrchestrator({
      artifactStore: started.artifactStore,
      stateStore: started.stateStore,
      subagentExecutor: executor,
      clarificationPort: clarification,
    });

    const result = await orchestrator.requestClarification({
      state: started.state,
      prompt: "Choose the product scope.",
    });

    expect(result).toEqual({
      status: "declined",
      reason: "Need a product owner.",
      state: started.state,
    });
    expect(result.state.phase).toBe("clarifying");
    expect(executor.calls.run).toHaveLength(1);
    await expect(
      readdir(join(started.runDirectory, "context")),
    ).resolves.toEqual(["scout.md", "task.md"]);
  });

  test("does not silently drop an architecture requirement persisted at workflow start", async () => {
    const runsDirectory = await makeRoot();
    const executor = new FakeSubagentExecutor({
      run: [
        { type: "result", value: succeeded("local facts") },
        {
          type: "result",
          value: succeeded(
            validPlan.replace(
              "## Architecture / Design\nKeep parsing and orchestration behind their existing boundaries.\n\n",
              "",
            ),
          ),
        },
      ],
    });
    const started = await makeStarted(runsDirectory, executor, {
      requiresArchitecture: true,
    });
    const orchestrator = new PlanningOrchestrator({
      artifactStore: started.artifactStore,
      stateStore: started.stateStore,
      subagentExecutor: executor,
    });

    await expect(
      orchestrator.createPlan({ state: started.state }),
    ).rejects.toThrow(/Architecture \/ Design/iu);
    expect((await new StateStore(started.runDirectory).loadState()).phase).toBe(
      "planning",
    );
  });

  test("passes only explicit artifact refs to planner and creates plan-v1 after validation", async () => {
    const runsDirectory = await makeRoot();
    const executor = new FakeSubagentExecutor({
      run: [
        { type: "result", value: succeeded("local facts") },
        { type: "result", value: succeeded(validPlan) },
      ],
    });
    const started = await makeStarted(runsDirectory, executor);
    const orchestrator = new PlanningOrchestrator({
      artifactStore: started.artifactStore,
      stateStore: started.stateStore,
      subagentExecutor: executor,
    });

    const result = await orchestrator.createPlan({ state: started.state });

    expect(result.state.phase).toBe("awaiting-plan-review");
    expect(result.state.planning.currentPlanVersion).toBe(1);
    expect(result.planRef.path).toBe("plans/plan-v1.md");
    expect(executor.calls.run[1]?.agent).toBe("planner");
    expect(executor.calls.run[1]?.inputRefs).toEqual([
      started.taskRef,
      started.state.planning.context.scoutRef,
    ]);
    expect(executor.calls.run[1]?.task).toMatch(/target version.*1/iu);
    await expect(
      readFile(join(started.runDirectory, "plans", "plan-v1.md"), "utf8"),
    ).resolves.toBe(validPlan);
  });

  test.each([
    [
      "missing required plan section",
      validPlan.replace("## Implementation Plan", "## Notes"),
    ],
    [
      "invalid validation contract",
      validPlan.replace('"schemaVersion": 1', '"schemaVersion": 2'),
    ],
  ])("does not emit PLAN_CREATED for %s", async (_name, plannerOutput) => {
    const runsDirectory = await makeRoot();
    const executor = new FakeSubagentExecutor({
      run: [
        { type: "result", value: succeeded("local facts") },
        { type: "result", value: succeeded(plannerOutput) },
      ],
    });
    const started = await makeStarted(runsDirectory, executor);
    const orchestrator = new PlanningOrchestrator({
      artifactStore: started.artifactStore,
      stateStore: started.stateStore,
      subagentExecutor: executor,
    });

    await expect(
      orchestrator.createPlan({ state: started.state }),
    ).rejects.toThrow();

    const persistedState = await new StateStore(
      started.runDirectory,
    ).loadState();
    expect(persistedState.phase).toBe("planning");
    expect(persistedState.planning.currentPlanVersion).toBe(0);
    await expect(
      readdir(join(started.runDirectory, "plans")),
    ).rejects.toThrow();
  });

  test("creates immutable plan-v2 after feedback while preserving plan-v1 and forwarding feedback refs", async () => {
    const runsDirectory = await makeRoot();
    const executor = new FakeSubagentExecutor({
      run: [
        { type: "result", value: succeeded("local facts") },
        { type: "result", value: succeeded(validPlan) },
        {
          type: "result",
          value: succeeded(validPlan.replace("# Plan", "# Plan v2")),
        },
      ],
    });
    const started = await makeStarted(runsDirectory, executor);
    const orchestrator = new PlanningOrchestrator({
      artifactStore: started.artifactStore,
      stateStore: started.stateStore,
      subagentExecutor: executor,
    });
    const first = await orchestrator.createPlan({ state: started.state });
    const feedbackRef = await started.artifactStore.writeText(
      "plan-review",
      "review-1.md",
      "Clarify the validation command.",
    );
    const planningState = await advanceWorkflow(
      first.state,
      { type: "PLAN_FEEDBACK", feedbackRef },
      started.stateStore,
    );

    const second = await orchestrator.createPlan({ state: planningState });

    expect(second.planRef.path).toBe("plans/plan-v2.md");
    expect(second.state.planning.currentPlanVersion).toBe(2);
    expect(second.state.planning.latestPlanReviewRef).toBeUndefined();
    expect(executor.calls.run[2]?.inputRefs).toEqual([
      started.taskRef,
      started.state.planning.context.scoutRef,
      first.planRef,
      feedbackRef,
    ]);
    await expect(
      readFile(join(started.runDirectory, "plans", "plan-v1.md"), "utf8"),
    ).resolves.toBe(validPlan);
    await expect(
      readFile(join(started.runDirectory, "plans", "plan-v2.md"), "utf8"),
    ).resolves.toContain("# Plan v2");
  });
});
