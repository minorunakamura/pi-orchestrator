import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import type { ArtifactRef } from "../../../src/core/artifacts/references.ts";
import type { WorkflowState } from "../../../src/core/workflow/state.ts";
import type { AgentRunResult } from "../../../src/runtime/ports/index.ts";
import { advanceWorkflow } from "../../../src/runtime/orchestrator/advance-workflow.ts";
import { PlanningOrchestrator } from "../../../src/runtime/orchestrator/planning-orchestrator.ts";
import { startWorkflow } from "../../../src/runtime/orchestrator/start-workflow.ts";
import { createArtifactRef } from "../../../src/runtime/persistence/artifact-store.ts";
import { StateStore } from "../../../src/runtime/persistence/state-store.ts";
import {
  FakePlannotatorGate,
  FakeSubagentExecutor,
  failure,
} from "../../../tests/fakes/index.ts";
import { plannotatorReviewId, subagentRunId } from "../../../src/types.ts";

const roots: string[] = [];
const runId = subagentRunId("run-1");
const reviewId = plannotatorReviewId("plan-review-1");
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

function planRef(content = validPlan, version = 1): ArtifactRef<"plan"> {
  return createArtifactRef("plan", `plans/plan-v${version}.md`, content);
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-orchestrator-plannotator-"));
  roots.push(root);
  return root;
}

async function makeStarted(
  runsDirectory: string,
  executor: FakeSubagentExecutor,
) {
  return startWorkflow(
    {
      task: "Implement the planning change",
      playbook: "feature",
    },
    {
      runsDirectory,
      subagentExecutor: executor,
      workflowIdFactory: () => "workflow-1",
    },
  );
}

async function createPlanWithGate(
  runsDirectory: string,
  gate: FakePlannotatorGate,
  executor = new FakeSubagentExecutor({
    run: [
      { type: "result", value: succeeded("local facts") },
      { type: "result", value: succeeded(validPlan) },
    ],
  }),
) {
  const started = await makeStarted(runsDirectory, executor);
  const orchestrator = new PlanningOrchestrator({
    artifactStore: started.artifactStore,
    stateStore: started.stateStore,
    subagentExecutor: executor,
    plannotatorGate: gate,
  });
  const created = await orchestrator.createPlan({ state: started.state });
  return { started, orchestrator, created };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("ORCH-009 Plannotator plan gate", () => {
  test.each(["missing", "hash", "schema"] as const)(
    "rejects %s Plan authority before direct approval or feedback",
    async (damage) => {
      const root = await makeRoot();
      const gate = new FakePlannotatorGate({
        openPlanReview: {
          type: "result",
          value: { reviewId, planRef: planRef(), planVersion: 1 },
        },
      });
      const { started, created, orchestrator } = await createPlanWithGate(
        root,
        gate,
      );
      let state = created.state;
      let ref = created.planRef;
      const path = join(started.runDirectory, ref.path);
      if (damage === "missing") await rm(path);
      else if (damage === "hash") await writeFile(path, validPlan + "tampered");
      else {
        ref = await started.artifactStore.writeText(
          "plan",
          "invalid-plan.md",
          "# No required sections",
        );
        state = await started.stateStore.saveState(
          {
            ...state,
            planning: {
              ...state.planning,
              currentPlanRef: ref,
              planReview: { ...state.planning.planReview!, planRef: ref },
            },
          },
          state.stateRevision,
        );
      }
      for (const status of ["approved", "feedback"] as const) {
        // Keep result applications sequential against the same durable authority.
        // oxlint-disable-next-line eslint/no-await-in-loop
        await expect(
          orchestrator.applyPlanReview({
            state,
            reviewId,
            status: {
              reviewId,
              planRef: ref,
              planVersion: 1,
              status,
              feedback: "revise",
            },
          }),
        ).rejects.toThrow();
      }
      expect(await new StateStore(started.runDirectory).loadState()).toEqual(
        state,
      );
      expect(await readdir(started.runDirectory)).not.toContain("plan-reviews");
    },
  );

  test("persists the Human approval artifact before PLAN_APPROVED", async () => {
    const root = await makeRoot();
    const expectedRef = planRef();
    const gate = new FakePlannotatorGate({
      openPlanReview: {
        type: "result",
        value: { reviewId, planRef: expectedRef, planVersion: 1 },
      },
      getPlanReview: {
        type: "result",
        value: {
          reviewId,
          planRef: expectedRef,
          planVersion: 1,
          status: "approved",
        },
      },
    });
    const { started, created } = await createPlanWithGate(root, gate);
    const order: string[] = [];
    const stateStore = {
      saveState: async (state: WorkflowState, expectedRevision?: number) => {
        if (state.phase === "implementing") {
          order.push("PLAN_APPROVED");
          await expect(
            readFile(
              join(root, "workflow-1", "plan-reviews", "plan-review-1.md"),
              "utf8",
            ),
          ).resolves.toContain('"status": "approved"');
        }
        return started.stateStore.saveState(state, expectedRevision);
      },
    };
    const orchestrator = new PlanningOrchestrator({
      artifactStore: started.artifactStore,
      stateStore,
      subagentExecutor: new FakeSubagentExecutor(),
      plannotatorGate: gate,
    });

    const settled = await orchestrator.reconcilePlanReview({
      state: created.state,
      reviewId,
    });

    expect(order).toEqual(["PLAN_APPROVED"]);
    if (settled.status !== "approved") throw new Error("expected approval");
    expect(settled.state.phase).toBe("implementing");
    expect(settled.state.planning.approvedPlanRef).toEqual(expectedRef);
    expect(settled.state.external["plannotator.plan-review.v1"]).toBe(reviewId);
  });

  test("routes feedback to planning and creates the next immutable plan version", async () => {
    const root = await makeRoot();
    const expectedRef = planRef();
    const secondContent = validPlan.replace("# Plan", "# Plan v2");
    const secondRef = planRef(secondContent, 2);
    const executor = new FakeSubagentExecutor({
      run: [
        { type: "result", value: succeeded("local facts") },
        { type: "result", value: succeeded(validPlan) },
        { type: "result", value: succeeded(secondContent) },
      ],
    });
    const gate = new FakePlannotatorGate({
      openPlanReview: [
        {
          type: "result",
          value: { reviewId, planRef: expectedRef, planVersion: 1 },
        },
        {
          type: "result",
          value: {
            reviewId: plannotatorReviewId("plan-review-2"),
            planRef: secondRef,
            planVersion: 2,
          },
        },
      ],
      getPlanReview: {
        type: "result",
        value: {
          reviewId,
          planRef: expectedRef,
          planVersion: 1,
          status: "feedback",
          feedback: "Clarify the validation boundary.",
        },
      },
    });
    const { orchestrator, created } = await createPlanWithGate(
      root,
      gate,
      executor,
    );

    const feedback = await orchestrator.reconcilePlanReview({
      state: created.state,
      reviewId,
    });
    const second = await orchestrator.createPlan({ state: feedback.state });

    expect(feedback.status).toBe("feedback");
    expect(feedback.state.phase).toBe("planning");
    expect(feedback.state.planning.latestPlanReviewRef?.kind).toBe(
      "plan-review",
    );
    expect(second.planRef.path).toBe("plans/plan-v2.md");
    expect(second.state.planning.currentPlanVersion).toBe(2);
  });

  test("rejects an approval bound to an older plan before writing its artifact", async () => {
    const root = await makeRoot();
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
    const started = await makeStarted(root, executor);
    const firstOrchestrator = new PlanningOrchestrator({
      artifactStore: started.artifactStore,
      stateStore: started.stateStore,
      subagentExecutor: executor,
    });
    const first = await firstOrchestrator.createPlan({ state: started.state });
    const feedbackRef = await started.artifactStore.writeText(
      "plan-review",
      "feedback-before-v2.md",
      "revise",
    );
    const planning = await advanceWorkflow(
      first.state,
      { type: "PLAN_FEEDBACK", feedbackRef },
      started.stateStore,
    );
    const second = await firstOrchestrator.createPlan({ state: planning });
    second.state = await started.stateStore.saveState(
      {
        ...second.state,
        planning: {
          ...second.state.planning,
          planReview: { reviewId, planRef: second.planRef, planVersion: 2 },
        },
        external: { "plannotator.plan-review.v2": reviewId },
      },
      second.state.stateRevision,
    );
    const gate = new FakePlannotatorGate({
      getPlanReview: {
        type: "result",
        value: {
          reviewId,
          planRef: first.planRef,
          planVersion: 1,
          status: "approved",
        },
      },
    });
    const orchestrator = new PlanningOrchestrator({
      artifactStore: started.artifactStore,
      stateStore: started.stateStore,
      subagentExecutor: executor,
      plannotatorGate: gate,
    });

    await expect(
      orchestrator.reconcilePlanReview({ state: second.state, reviewId }),
    ).rejects.toThrow(/current plan and version/iu);
    await expect(
      readdir(join(root, "workflow-1", "plan-reviews")),
    ).resolves.toEqual(["feedback-before-v2.md"]);
    expect(
      (await new StateStore(join(root, "workflow-1")).loadState()).phase,
    ).toBe("awaiting-plan-review");
  });

  test("blocks when Plannotator cannot open the review", async () => {
    const root = await makeRoot();
    const gate = new FakePlannotatorGate({
      openPlanReview: failure("infrastructure", "Plannotator is unavailable"),
    });
    const { created } = await createPlanWithGate(root, gate);

    expect(created.state.phase).toBe("blocked");
    expect(created.state.block?.reason).toBe("human-gate-unavailable");
    expect(created.state.block?.blockedFrom).toBe("awaiting-plan-review");
  });

  test("does not apply the same settled review twice", async () => {
    const root = await makeRoot();
    const expectedRef = planRef();
    const gate = new FakePlannotatorGate({
      openPlanReview: {
        type: "result",
        value: { reviewId, planRef: expectedRef, planVersion: 1 },
      },
      getPlanReview: [
        {
          type: "result",
          value: {
            reviewId,
            planRef: expectedRef,
            planVersion: 1,
            status: "approved",
          },
        },
        {
          type: "result",
          value: {
            reviewId,
            planRef: expectedRef,
            planVersion: 1,
            status: "approved",
          },
        },
      ],
    });
    const { started, orchestrator, created } = await createPlanWithGate(
      root,
      gate,
    );

    const first = await orchestrator.reconcilePlanReview({
      state: created.state,
      reviewId,
    });
    const second = await orchestrator.reconcilePlanReview({
      state: first.state,
      reviewId,
    });

    expect(first.state).toEqual(second.state);
    expect(
      (await new StateStore(join(root, "workflow-1")).loadState()).phase,
    ).toBe("implementing");
    expect(gate.calls.getPlanReview).toHaveLength(2);
    await expect(
      readdir(join(root, "workflow-1", "plan-reviews")),
    ).resolves.toEqual(["plan-review-1.md"]);
    void started;
  });

  test("reuses durable review state after recreating the orchestrator", async () => {
    const root = await makeRoot();
    const expectedRef = planRef();
    const firstGate = new FakePlannotatorGate({
      openPlanReview: {
        type: "result",
        value: { reviewId, planRef: expectedRef, planVersion: 1 },
      },
      getPlanReview: {
        type: "result",
        value: {
          reviewId,
          planRef: expectedRef,
          planVersion: 1,
          status: "approved",
        },
      },
    });
    const { started, orchestrator, created } = await createPlanWithGate(
      root,
      firstGate,
    );
    const first = await orchestrator.reconcilePlanReview({
      state: created.state,
      reviewId,
    });
    const reloaded = await new StateStore(join(root, "workflow-1")).loadState();
    const secondGate = new FakePlannotatorGate({
      getPlanReview: {
        type: "result",
        value: {
          reviewId,
          planRef: expectedRef,
          planVersion: 1,
          status: "approved",
        },
      },
    });
    const fresh = new PlanningOrchestrator({
      artifactStore: started.artifactStore,
      stateStore: started.stateStore,
      subagentExecutor: new FakeSubagentExecutor(),
      plannotatorGate: secondGate,
    });

    const second = await fresh.reconcilePlanReview({
      state: reloaded,
      reviewId,
    });

    expect(first.state.phase).toBe("implementing");
    if (second.status !== "approved") throw new Error("expected approval");
    expect(second.state).toEqual(reloaded);
    expect(second.reviewRef.path).toBe("plan-reviews/plan-review-1.md");
    expect(
      (await new StateStore(join(root, "workflow-1")).loadState())
        .stateRevision,
    ).toBe(reloaded.stateRevision);
    await expect(
      readdir(join(root, "workflow-1", "plan-reviews")),
    ).resolves.toEqual(["plan-review-1.md"]);
  });

  test("does not emit an event when review artifact persistence fails", async () => {
    const root = await makeRoot();
    const executor = new FakeSubagentExecutor({
      run: [
        { type: "result", value: succeeded("local facts") },
        { type: "result", value: succeeded(validPlan) },
      ],
    });
    const started = await makeStarted(root, executor);
    const created = await new PlanningOrchestrator({
      artifactStore: started.artifactStore,
      stateStore: started.stateStore,
      subagentExecutor: executor,
    }).createPlan({ state: started.state });
    const expectedRef = planRef();
    const gate = new FakePlannotatorGate({
      openPlanReview: {
        type: "result",
        value: { reviewId, planRef: expectedRef, planVersion: 1 },
      },
      getPlanReview: {
        type: "result",
        value: {
          reviewId,
          planRef: expectedRef,
          planVersion: 1,
          status: "approved",
        },
      },
    });
    const opened = await new PlanningOrchestrator({
      artifactStore: started.artifactStore,
      stateStore: started.stateStore,
      subagentExecutor: executor,
      plannotatorGate: gate,
    }).openPlanReview({ state: created.state });
    const orchestrator = new PlanningOrchestrator({
      artifactStore: {
        readText: started.artifactStore.readText!.bind(started.artifactStore),
        writeText: async () => {
          throw new Error("disk full");
        },
      },
      stateStore: started.stateStore,
      subagentExecutor: executor,
      plannotatorGate: gate,
    });

    await expect(
      orchestrator.reconcilePlanReview({ state: opened.state, reviewId }),
    ).rejects.toThrow("disk full");
    expect(
      (await new StateStore(join(root, "workflow-1")).loadState()).phase,
    ).toBe("awaiting-plan-review");
  });
});
