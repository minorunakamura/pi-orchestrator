import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import type { OrchestratorConfiguration } from "../../../src/core/configuration.ts";
import { advanceWorkflow } from "../../../src/runtime/orchestrator/advance-workflow.ts";
import {
  CodingOrchestrator,
  type CodingOrchestratorDependencies,
} from "../../../src/runtime/orchestrator/coding-orchestrator.ts";
import { PlanningOrchestrator } from "../../../src/runtime/orchestrator/planning-orchestrator.ts";
import { startWorkflow } from "../../../src/runtime/orchestrator/start-workflow.ts";
import { StateStore } from "../../../src/runtime/persistence/state-store.ts";
import type {
  CodeReviewHandle,
  CodeReviewStatus,
} from "../../../src/runtime/ports/index.ts";
import {
  FakeJevDecisionClient,
  FakePlannotatorGate,
  FakeSubagentExecutor,
  failure,
} from "../../fakes/index.ts";
import type { PlannotatorReviewId, SubagentRunId } from "../../../src/types.ts";

const roots: string[] = [];
const reviewId = "code-review-1" as PlannotatorReviewId;
const runId = "worker-1" as SubagentRunId;
const plan = `# Approved Plan

## Scope / Requirements
Implement the requested behavior safely.

## Architecture / Design
Keep runtime orchestration behind existing ports.

## Implementation Plan
1. Add focused tests.

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

const configuration: OrchestratorConfiguration = {
  decision: { autoDecisionThreshold: 0.8, escalationThreshold: 0.5 },
  executionProfiles: {
    ECONOMY: { provider: "economy", model: "economy" },
    STANDARD: { provider: "standard", model: "standard" },
    STRONG: { provider: "strong", model: "strong" },
  },
  reasoningMapping: { LOW: "low", MEDIUM: "medium", HIGH: "high" },
  retries: { maxAutomatedFixRounds: 3, maxStrongerRetries: 1 },
  validation: { stopOnInfrastructureFailure: true },
  jev: {},
};

function succeeded(output: string) {
  return {
    type: "result" as const,
    value: { status: "succeeded" as const, runId, output },
  };
}

async function makeAwaitingCodeReview() {
  const runsDirectory = await mkdtemp(
    join(tmpdir(), "pi-orchestrator-code-review-"),
  );
  roots.push(runsDirectory);
  const executor = new FakeSubagentExecutor({
    run: [succeeded("facts"), succeeded(plan)],
  });
  const started = await startWorkflow(
    { task: "Implement the code gate", playbook: "feature" },
    {
      runsDirectory,
      subagentExecutor: executor,
      workflowIdFactory: () => "workflow-1",
    },
  );
  const created = await new PlanningOrchestrator({
    artifactStore: started.artifactStore,
    stateStore: started.stateStore,
    subagentExecutor: executor,
  }).createPlan({ state: started.state });
  const planReviewRef = await started.artifactStore.writeText(
    "plan-review",
    "review-1.md",
    "approved",
  );
  let state = await advanceWorkflow(
    created.state,
    {
      type: "PLAN_APPROVED",
      planRef: created.planRef,
      version: 1,
      reviewRef: planReviewRef,
    },
    started.stateStore,
  );
  const routingRef = await started.artifactStore.writeText(
    "execution-routing",
    "routing-1.md",
    "routing",
  );
  state = await advanceWorkflow(
    state,
    { type: "EXECUTION_ROUTED", decisionRef: routingRef },
    started.stateStore,
  );
  const implementationRef = await started.artifactStore.writeText(
    "implementation",
    "implementation-1.md",
    "implemented",
  );
  state = await advanceWorkflow(
    state,
    { type: "IMPLEMENTATION_COMPLETE", resultRef: implementationRef },
    started.stateStore,
  );
  const validationRef = await started.artifactStore.writeText(
    "validation",
    "validation-1.md",
    "passed",
  );
  state = await advanceWorkflow(
    state,
    { type: "VALIDATION_PASSED", resultRef: validationRef },
    started.stateStore,
  );
  const decisionRef = await started.artifactStore.writeText(
    "round-decision",
    "round-1.md",
    "complete",
  );
  state = await advanceWorkflow(
    state,
    { type: "REVIEW_COMPLETE", decisionRef },
    started.stateStore,
  );
  return { started, state, implementationRef };
}

function dependencies(
  started: Awaited<ReturnType<typeof makeAwaitingCodeReview>>,
  gate: FakePlannotatorGate,
  overrides: Partial<CodingOrchestratorDependencies> = {},
): CodingOrchestratorDependencies {
  return {
    artifactStore: started.started.artifactStore,
    stateStore: started.started.stateStore,
    jevDecisionClient: new FakeJevDecisionClient(),
    subagentExecutor: new FakeSubagentExecutor(),
    configuration,
    plannotatorGate: gate,
    ...overrides,
  };
}

function handle(
  started: Awaited<ReturnType<typeof makeAwaitingCodeReview>>,
): CodeReviewHandle {
  return {
    reviewId,
    implementationRef: started.implementationRef,
    implementationRevision: started.state.coding.implementationRevision,
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ORCH-017 Plannotator code gate", () => {
  test("persists the exact Human approval artifact before CODE_APPROVED", async () => {
    const started = await makeAwaitingCodeReview();
    const review = handle(started);
    const gate = new FakePlannotatorGate({
      openCodeReview: { type: "result", value: review },
      getCodeReview: {
        type: "result",
        value: { ...review, status: "approved" },
      },
    });
    const orchestrator = new CodingOrchestrator(dependencies(started, gate));
    const opened = await orchestrator.openCodeReview({ state: started.state });
    expect(opened.status).toBe("opened");
    if (opened.status !== "opened") throw new Error("expected opened");
    const order: string[] = [];
    const stateStore = {
      saveState: async (
        state: Parameters<typeof started.started.stateStore.saveState>[0],
        expectedRevision?: number,
      ) => {
        if (state.phase === "completed") {
          order.push("CODE_APPROVED");
          await expect(
            readFile(
              join(
                started.started.runDirectory,
                "code-reviews",
                "code-review-1.json",
              ),
              "utf8",
            ),
          ).resolves.toContain('"status":"approved"');
        }
        return started.started.stateStore.saveState(state, expectedRevision);
      },
    };
    const settled = await new CodingOrchestrator(
      dependencies(started, gate, { stateStore }),
    ).reconcileCodeReview({ state: opened.state, reviewId });

    expect(order).toEqual(["CODE_APPROVED"]);
    expect(settled.status).toBe("approved");
    expect(settled.state.phase).toBe("completed");
    expect(settled.state.coding.latestCodeReviewRef?.kind).toBe("code-review");
  });

  test("routes feedback to fixing without consuming automated retry budget", async () => {
    const started = await makeAwaitingCodeReview();
    const review = handle(started);
    const gate = new FakePlannotatorGate({
      openCodeReview: { type: "result", value: review },
      getCodeReview: {
        type: "result",
        value: {
          ...review,
          status: "feedback",
          feedback: "Please add a test.",
        },
      },
    });
    const orchestrator = new CodingOrchestrator(dependencies(started, gate));
    const opened = await orchestrator.openCodeReview({ state: started.state });
    if (opened.status !== "opened") throw new Error("expected opened");
    const result = await orchestrator.reconcileCodeReview({
      state: opened.state,
      reviewId,
    });

    expect(result.status).toBe("feedback");
    expect(result.state.phase).toBe("fixing");
    expect(result.state.counters.automatedFixRoundsUsed).toBe(0);
    expect(result.state.counters.humanCodeFeedbackRounds).toBe(1);
  });

  test("rejects approval or feedback bound to a stale implementation revision", async () => {
    const started = await makeAwaitingCodeReview();
    const review = handle(started);
    const gate = new FakePlannotatorGate({
      openCodeReview: { type: "result", value: review },
    });
    const orchestrator = new CodingOrchestrator(dependencies(started, gate));
    const opened = await orchestrator.openCodeReview({ state: started.state });
    if (opened.status !== "opened") throw new Error("expected opened");
    const staleStatuses: CodeReviewStatus[] = [
      {
        ...review,
        implementationRevision: review.implementationRevision - 1,
        status: "approved",
      },
      {
        ...review,
        implementationRevision: review.implementationRevision - 1,
        status: "feedback",
        feedback: "Please add a test.",
      },
    ];

    await Promise.all(
      staleStatuses.map((status) =>
        expect(
          orchestrator.applyCodeReview({
            state: opened.state,
            reviewId,
            status,
          }),
        ).rejects.toThrow(/revision|current implementation/iu),
      ),
    );
    expect(
      (await new StateStore(started.started.runDirectory).loadState()).phase,
    ).toBe("awaiting-code-review");
    await expect(
      readdir(join(started.started.runDirectory, "code-reviews")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("reconciles a persisted identity instead of reopening it", async () => {
    const started = await makeAwaitingCodeReview();
    const review = handle(started);
    const firstGate = new FakePlannotatorGate({
      openCodeReview: { type: "result", value: review },
    });
    const first = new CodingOrchestrator(dependencies(started, firstGate));
    const opened = await first.openCodeReview({ state: started.state });

    const status: CodeReviewStatus = { ...review, status: "pending" };
    const freshGate = new FakePlannotatorGate({
      openCodeReview: failure("infrastructure", "must not reopen"),
      getCodeReview: { type: "result", value: status },
    });
    const reconciled = await new CodingOrchestrator(
      dependencies(started, freshGate),
    ).openCodeReview({ state: opened.state });

    expect(reconciled.status).toBe("reconciled");
    expect(freshGate.calls.openCodeReview).toHaveLength(0);
    expect(freshGate.calls.getCodeReview).toEqual([reviewId]);
  });

  test("blocks when Plannotator is unavailable", async () => {
    const started = await makeAwaitingCodeReview();
    const gate = new FakePlannotatorGate({
      openCodeReview: failure("infrastructure", "Plannotator is unavailable"),
    });

    const result = await new CodingOrchestrator(
      dependencies(started, gate),
    ).openCodeReview({ state: started.state });

    expect(result.status).toBe("blocked");
    expect(result.state.phase).toBe("blocked");
    expect(result.state.block?.reason).toBe("human-gate-unavailable");
    expect(result.state.block?.blockedFrom).toBe("awaiting-code-review");
  });

  test("treats an already-applied settled result as an idempotent no-op", async () => {
    const started = await makeAwaitingCodeReview();
    const review = handle(started);
    const gate = new FakePlannotatorGate({
      openCodeReview: { type: "result", value: review },
      getCodeReview: {
        type: "result",
        value: { ...review, status: "approved" },
      },
    });
    const orchestrator = new CodingOrchestrator(dependencies(started, gate));
    const opened = await orchestrator.openCodeReview({ state: started.state });
    if (opened.status !== "opened") throw new Error("expected opened");
    const first = await orchestrator.reconcileCodeReview({
      state: opened.state,
      reviewId,
    });
    const second = await orchestrator.reconcileCodeReview({
      state: first.state,
      reviewId,
    });

    expect(second.status).toBe("approved");
    expect(second.state).toEqual(first.state);
    expect(gate.calls.getCodeReview).toHaveLength(2);
    expect(
      await readdir(join(started.started.runDirectory, "code-reviews")),
    ).toEqual(["code-review-1.json"]);
  });
});
