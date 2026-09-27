import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import {
  ArtifactStore,
  calculateSha256,
  createArtifactRef,
} from "../../../src/runtime/persistence/artifact-store.ts";
import { StateStore } from "../../../src/runtime/persistence/state-store.ts";
import { startWorkflow } from "../../../src/runtime/orchestrator/start-workflow.ts";
import { PlanningOrchestrator } from "../../../src/runtime/orchestrator/planning-orchestrator.ts";
import { resumeWorkflow } from "../../../src/runtime/orchestrator/resume-workflow.ts";
import type { WorkflowState } from "../../../src/core/workflow/state.ts";
import type {
  AgentRunResult,
  AgentRunStatus,
  SubagentExecutor,
} from "../../../src/runtime/ports/index.ts";
import type { SubagentRunId } from "../../../src/types.ts";
import {
  FakePlannotatorGate,
  FakeSubagentExecutor,
  failure,
} from "../../fakes/index.ts";

const roots: string[] = [];
const runId = "worker-1" as SubagentRunId;
const plan = `# Plan\n\n## Scope / Requirements\nKeep the change small.\n\n## Architecture / Design\nUse the existing runtime boundary.\n\n## Implementation Plan\n1. Test.\n\n## Validation Contract\n\`\`\`orchestrator-validation\n{"schemaVersion":1,"checks":[{"id":"tests","type":"command","command":"pnpm test","cwd":".","required":true}]}\n\`\`\``;

function succeeded(output: string): AgentRunResult {
  return { status: "succeeded", runId, output };
}

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "pi-orchestrator-resume-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  );
});

describe("ORCH-018 resumeWorkflow", () => {
  test("reconciles a persisted Plan review identity without reopening it", async () => {
    const runs = await root();
    const executor = new FakeSubagentExecutor({
      run: [
        { type: "result", value: succeeded("facts") },
        { type: "result", value: succeeded(plan) },
      ],
    });
    const started = await startWorkflow(
      { task: "resume safely", playbook: "feature" },
      {
        runsDirectory: runs,
        workflowIdFactory: () => "workflow-1",
        subagentExecutor: executor,
      },
    );
    const firstGate = new FakePlannotatorGate({
      openPlanReview: {
        type: "result",
        value: {
          reviewId: "plan-1" as never,
          planRef: createArtifactRef("plan", "plans/plan-v1.md", plan),
          planVersion: 1,
        },
      },
    });
    const planning = new PlanningOrchestrator({
      artifactStore: started.artifactStore,
      stateStore: started.stateStore,
      subagentExecutor: executor,
      plannotatorGate: firstGate,
    });
    const created = await planning.createPlan({ state: started.state });
    expect(created.state.planning.planReview).toBeDefined();

    const freshGate = new FakePlannotatorGate({
      openPlanReview: failure("infrastructure", "must not reopen"),
      getPlanReview: {
        type: "result",
        value: { ...created.state.planning.planReview!, status: "pending" },
      },
    });
    const result = await resumeWorkflow("workflow-1" as never, {
      runDirectory: started.runDirectory,
      artifactStore: started.artifactStore,
      stateStore: started.stateStore,
      subagentExecutor: new FakeSubagentExecutor(),
      plannotatorGate: freshGate,
    });

    expect(result.status).toBe("pending");
    expect(result.state.phase).toBe("awaiting-plan-review");
    expect(freshGate.calls.openPlanReview).toHaveLength(0);
    expect(freshGate.calls.getPlanReview).toEqual(["plan-1"]);
  });

  test("fails closed for a possible orphan Plan review instead of reopening", async () => {
    const runs = await root();
    const executor = new FakeSubagentExecutor({
      run: [
        { type: "result", value: succeeded("facts") },
        { type: "result", value: succeeded(plan) },
      ],
    });
    const started = await startWorkflow(
      { task: "resume safely", playbook: "feature" },
      {
        runsDirectory: runs,
        workflowIdFactory: () => "workflow-1",
        subagentExecutor: executor,
      },
    );
    const created = await new PlanningOrchestrator({
      artifactStore: started.artifactStore,
      stateStore: started.stateStore,
      subagentExecutor: executor,
    }).createPlan({ state: started.state });
    const gate = new FakePlannotatorGate({
      openPlanReview: failure("infrastructure", "must not reopen"),
    });

    const result = await resumeWorkflow("workflow-1" as never, {
      runDirectory: started.runDirectory,
      artifactStore: started.artifactStore,
      stateStore: started.stateStore,
      subagentExecutor: new FakeSubagentExecutor(),
      plannotatorGate: gate,
    });

    expect(result.status).toBe("blocked");
    expect(result.state.block?.reason).toBe("human-gate-unavailable");
    expect(gate.calls.openPlanReview).toHaveLength(0);
    expect(created.state.phase).toBe("awaiting-plan-review");
  });

  test("reconstructs a known Worker completion from durable evidence without dispatch", async () => {
    const runs = await root();
    const artifactStore = new ArtifactStore(join(runs, "workflow-1"));
    const stateStore = new StateStore(join(runs, "workflow-1"));
    const taskRef = await artifactStore.writeText("task", "task.md", "task");
    const planRef = await artifactStore.writeText("plan", "plan-v1.md", plan);
    const routingRef = await artifactStore.writeText(
      "execution-routing",
      "routing.md",
      "routing",
    );
    const before = {
      cwd: runs,
      root: runs,
      head: null,
      indexDigest: "a".repeat(64),
      worktreeDigest: "b".repeat(64),
      untracked: [],
    };
    const after = { ...before, worktreeDigest: "c".repeat(64) };
    const implementation = {
      schemaVersion: 1,
      implementationRevision: 1,
      approvedPlanRef: planRef,
      executionRoutingRef: routingRef,
      executionProfile: {
        provider: "fake",
        model: "standard",
        thinking: "medium",
      },
      repository: {
        cwd: runs,
        outputSha256: calculateSha256("implementation"),
      },
      runId: runId,
      output: "implementation",
    };
    const implementationRef = await artifactStore.writeJson(
      "implementation",
      "implementation-1.json",
      implementation,
      (value) => value,
    );
    const attempt = {
      schemaVersion: 1,
      recordType: "worker-attempt",
      workflowId: "workflow-1",
      attemptId: "attempt-known",
      inputRevision: 0,
      targetRevision: 1,
      approvedPlanRef: planRef,
      planVersion: 1,
      executionRoutingRef: routingRef,
      inputRefs: [taskRef, planRef],
      executionProfile: implementation.executionProfile,
      dispatch: {
        requestId: "request-known",
        ownerRunId: "workflow-1",
        nodeId: "worker-attempt-known",
        deadline: "2099-01-01T00:00:00.000Z",
      },
      observedAt: "2026-01-01T00:00:00.000Z",
      status: "succeeded",
      runId,
      launchStatus: "observed",
      before,
      after: { status: "observed", snapshot: after },
      implementationRef,
      resultDigest: "e".repeat(64),
    } as const;
    const attemptRef = await artifactStore.writeJson(
      "implementation",
      "attempt-known-result.json",
      attempt,
      (value) => value,
    );
    const state: WorkflowState = {
      schemaVersion: 1,
      workflowId: "workflow-1" as never,
      stateRevision: 0,
      playbook: "feature",
      phase: "implementing",
      taskRef,
      projectRoot: runs,
      planning: {
        context: {},
        currentPlanRef: planRef,
        currentPlanVersion: 1,
        approvedPlanRef: planRef,
        approvedPlanVersion: 1,
      },
      coding: {
        implementationRevision: 0,
        reviewRound: 0,
        executionRoutingRef: routingRef,
        workerAttemptRef: attemptRef,
      },
      counters: {
        automatedFixRoundsUsed: 0,
        strongerRetriesUsed: 0,
        humanCodeFeedbackRounds: 0,
      },
      external: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await stateStore.saveState(state, 0);
    const executor: SubagentExecutor = {
      run: async () => ({
        status: "succeeded",
        runId,
        output: "must not dispatch",
      }),
      runParallel: async () => [],
      status: async (id: SubagentRunId): Promise<AgentRunStatus> => ({
        runId: id,
        status: "succeeded",
      }),
      resume: async () => ({ status: "ambiguous", reason: "not used" }),
    };

    const result = await resumeWorkflow("workflow-1" as never, {
      runDirectory: join(runs, "workflow-1"),
      artifactStore,
      stateStore,
      subagentExecutor: executor,
    });

    expect(result.status).toBe("advanced");
    expect(result.state.phase).toBe("validating");
  });

  test("does not redispatch an unresolved Worker attempt on resume", async () => {
    const runs = await root();
    const artifactStore = new ArtifactStore(join(runs, "workflow-1"));
    const stateStore = new StateStore(join(runs, "workflow-1"));
    const taskRef = await artifactStore.writeText("task", "task.md", "task");
    const planRef = await artifactStore.writeText("plan", "plan-v1.md", plan);
    const routingRef = await artifactStore.writeText(
      "execution-routing",
      "routing.md",
      "routing",
    );
    const before = {
      cwd: runs,
      root: runs,
      head: null,
      indexDigest: "a".repeat(64),
      worktreeDigest: "b".repeat(64),
      untracked: [],
    };
    const attempt = {
      schemaVersion: 1,
      recordType: "worker-attempt",
      workflowId: "workflow-1",
      attemptId: "attempt-1",
      inputRevision: 0,
      targetRevision: 1,
      approvedPlanRef: planRef,
      planVersion: 1,
      executionRoutingRef: routingRef,
      inputRefs: [taskRef, planRef],
      executionProfile: {
        provider: "fake",
        model: "standard",
        thinking: "medium",
      },
      dispatch: {
        requestId: "request-1",
        ownerRunId: "workflow-1",
        nodeId: "worker-attempt-1",
        deadline: "2099-01-01T00:00:00.000Z",
      },
      observedAt: "2026-01-01T00:00:00.000Z",
      status: "intent",
      launchStatus: "unknown",
      before,
    } as const;
    const attemptRef = await artifactStore.writeJson(
      "implementation",
      "attempt-1-intent.json",
      attempt,
      (value) => value,
    );
    const state: WorkflowState = {
      schemaVersion: 1,
      workflowId: "workflow-1" as never,
      stateRevision: 0,
      playbook: "feature",
      phase: "implementing",
      taskRef,
      projectRoot: runs,
      planning: {
        context: {},
        currentPlanRef: planRef,
        currentPlanVersion: 1,
        approvedPlanRef: planRef,
        approvedPlanVersion: 1,
      },
      coding: {
        implementationRevision: 0,
        reviewRound: 0,
        executionRoutingRef: routingRef,
        workerAttemptRef: attemptRef,
      },
      counters: {
        automatedFixRoundsUsed: 0,
        strongerRetriesUsed: 0,
        humanCodeFeedbackRounds: 0,
      },
      external: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await stateStore.saveState(state, 0);
    const executor: SubagentExecutor = {
      run: async () => ({
        status: "succeeded",
        runId,
        output: "unsafe duplicate",
      }),
      runParallel: async () => [],
      status: async (id: SubagentRunId): Promise<AgentRunStatus> => ({
        runId: id,
        status: "running",
      }),
      resume: async () => ({ status: "ambiguous", reason: "not used" }),
    };

    const result = await resumeWorkflow("workflow-1" as never, {
      runDirectory: join(runs, "workflow-1"),
      artifactStore,
      stateStore,
      subagentExecutor: executor,
    });

    expect(result.status).toBe("blocked");
    expect(result.state.block?.reason).toBe("agent-execution-ambiguous");
  });
});
