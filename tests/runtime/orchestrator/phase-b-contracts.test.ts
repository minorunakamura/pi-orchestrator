import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { WorkflowState } from "../../../src/core/workflow/state.ts";
import { advanceWorkflow } from "../../../src/runtime/orchestrator/advance-workflow.ts";
import { PlanningOrchestrator } from "../../../src/runtime/orchestrator/planning-orchestrator.ts";
import { startWorkflow } from "../../../src/runtime/orchestrator/start-workflow.ts";
import { StateStore } from "../../../src/runtime/persistence/state-store.ts";
import { PlannotatorIntegration } from "../../../src/runtime/integrations/plannotator.ts";
import type { PlanReviewStatus } from "../../../src/runtime/ports/index.ts";
import { plannotatorReviewId, subagentRunId } from "../../../src/types.ts";
import {
  FakePlannotatorGate,
  FakeSubagentExecutor,
  failure,
} from "../../fakes/index.ts";

const roots: string[] = [];
const reviewId = plannotatorReviewId("review-1");
const plan = `# Plan
## Scope / Requirements
Preserve authority boundaries.
## Architecture / Design
Use existing ports.
## Implementation Plan
Add regression tests and fix the contracts.
## Validation Contract
\`\`\`orchestrator-validation
{"schemaVersion":1,"checks":[{"id":"tests","type":"command","command":"pnpm test","cwd":".","required":true}]}
\`\`\`
`;
function success(output: string) {
  return {
    type: "result" as const,
    value: {
      status: "succeeded" as const,
      runId: subagentRunId("run-1"),
      output,
    },
  };
}
async function root() {
  const path = await mkdtemp(join(tmpdir(), "phase-b-contracts-"));
  roots.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function ready() {
  const executor = new FakeSubagentExecutor({
    run: [success("facts"), success(plan)],
  });
  const started = await startWorkflow(
    { task: "Fix contracts", playbook: "feature" },
    { runsDirectory: await root(), subagentExecutor: executor },
  );
  const dependencies = {
    artifactStore: started.artifactStore,
    stateStore: started.stateStore,
    subagentExecutor: executor,
  };
  const created = await new PlanningOrchestrator(dependencies).createPlan({
    state: started.state,
  });
  const handle = { reviewId, planRef: created.planRef, planVersion: 1 };
  const gate = new FakePlannotatorGate({
    openPlanReview: { type: "result", value: handle },
  });
  const store = new StateStore(started.runDirectory);
  return { started, dependencies, created, handle, gate, store };
}

test("B1: a fresh real adapter cannot relabel stale approval without a persisted exact binding", async () => {
  const { dependencies, created, store } = await ready();
  let queries = 0;
  const staleId = plannotatorReviewId("old-plan-approval");
  const gate = new PlannotatorIntegration({
    planReader: { readText: async () => plan },
    events: {
      emit(_channel, payload) {
        queries++;
        const respond =
          payload !== null && typeof payload === "object"
            ? Reflect.get(payload, "respond")
            : undefined;
        if (typeof respond !== "function") throw Error("Invalid gate request");
        respond({
          status: "handled",
          result: { status: "completed", reviewId: staleId, approved: true },
        });
      },
    },
  });
  const orchestrator = new PlanningOrchestrator({
    ...dependencies,
    plannotatorGate: gate,
  });
  const identities: WorkflowState["external"][] = [
    {},
    { "plannotator.plan-review.v1": staleId },
  ];
  for (const external of identities) {
    const state = { ...created.state, external };
    // Exercise each stale binding against the same persisted State in order.
    // oxlint-disable-next-line eslint/no-await-in-loop
    await expect(
      orchestrator.reconcilePlanReview({ state, reviewId: staleId }),
    ).rejects.toThrow(/binding/);
    // Even a current-plan-labelled result cannot bypass the runtime entry guard.
    // Check the second entry point only after the first has rejected this binding.
    // oxlint-disable-next-line eslint/no-await-in-loop
    await expect(
      orchestrator.applyPlanReview({
        state,
        reviewId: staleId,
        status: {
          reviewId: staleId,
          status: "approved",
          planRef: created.planRef,
          planVersion: 1,
        },
      }),
    ).rejects.toThrow(/binding/);
  }
  expect(queries).toBe(0);
  expect((await store.loadState()).planning.approvedPlanRef).toBeUndefined();
  expect(await readdir(store.rootDirectory)).not.toContain("plan-reviews");
});

test("B1: both entry points reject mismatched persisted id, version and artifact identity", async () => {
  const { dependencies, created, handle, gate, store } = await ready();
  const orchestrator = new PlanningOrchestrator({
    ...dependencies,
    plannotatorGate: gate,
  });
  const opened = await orchestrator.openPlanReview({ state: created.state });
  for (const binding of [
    { ...handle, reviewId: plannotatorReviewId("other") },
    { ...handle, planVersion: 2 },
    { ...handle, planRef: { ...handle.planRef, sha256: "b".repeat(64) } },
    { ...handle, planRef: { ...handle.planRef, path: "plans/other.md" } },
  ]) {
    const state = {
      ...opened.state,
      planning: { ...opened.state.planning, planReview: binding },
    };
    // Mismatched bindings share a persistent fixture; validate them serially.
    // oxlint-disable-next-line eslint/no-await-in-loop
    await expect(
      orchestrator.reconcilePlanReview({ state, reviewId }),
    ).rejects.toThrow(/binding/);
    // Complete the first rejection before probing the other entry point.
    // oxlint-disable-next-line eslint/no-await-in-loop
    await expect(
      orchestrator.applyPlanReview({
        state,
        reviewId,
        status: { ...handle, status: "approved" },
      }),
    ).rejects.toThrow(/binding/);
    // StateStore writes must not race the entry-point assertions on this fixture.
    // oxlint-disable-next-line eslint/no-await-in-loop
    await expect(store.saveState(state, state.stateRevision)).rejects.toThrow(
      /planReview/,
    );
  }
  expect(gate.calls.getPlanReview).toHaveLength(0);
});

test.each(["approved", "feedback"] as const)(
  "I1: duplicate %s preserves the current blocked State after restart",
  async (status) => {
    const { dependencies, created, handle, gate, store } = await ready();
    const original = new PlanningOrchestrator({
      ...dependencies,
      plannotatorGate: gate,
    });
    const opened = await original.openPlanReview({ state: created.state });
    const result: PlanReviewStatus =
      status === "approved"
        ? { ...handle, status }
        : { ...handle, status, feedback: "Revise scope" };
    const settled = await original.applyPlanReview({
      state: opened.state,
      reviewId,
      status: result,
    });
    expect(settled.state.planning.latestPlanReviewRef?.kind).toBe(
      "plan-review",
    );
    const blocked = await advanceWorkflow(
      settled.state,
      { type: "BLOCK", reason: "integration-unavailable" },
      store,
    );
    const current = await store.loadState();
    // Fail if a duplicate attempts any artifact or State write.
    const fresh = new PlanningOrchestrator({
      ...dependencies,
      artifactStore: {
        writeText: async () => {
          throw new Error("unexpected artifact write");
        },
      },
      stateStore: {
        saveState: async () => {
          throw new Error("unexpected State write");
        },
      },
    });
    for (const orchestrator of [original, fresh]) {
      // Verify duplicate handling on each runtime instance in fixture order.
      // oxlint-disable-next-line eslint/no-await-in-loop
      const duplicate = await orchestrator.applyPlanReview({
        state: current,
        reviewId,
        status: result,
      });
      expect(duplicate.state).toBe(current);
      expect(duplicate.state).toEqual(blocked);
    }
    expect(await store.loadState()).toEqual(current);
    if (status === "feedback") {
      await expect(
        fresh.applyPlanReview({
          state: current,
          reviewId,
          status: { ...handle, status, feedback: "Different feedback" },
        }),
      ).rejects.toThrow(/reused/);
    }
  },
);

test("explicit REPLAN_REQUIRED invalidation rejects old approval without restoring authority", async () => {
  const { dependencies, created, handle, gate, store } = await ready();
  const orchestrator = new PlanningOrchestrator({
    ...dependencies,
    plannotatorGate: gate,
  });
  const opened = await orchestrator.openPlanReview({ state: created.state });
  const status = { ...handle, status: "approved" as const };
  const settled = await orchestrator.applyPlanReview({
    state: opened.state,
    reviewId,
    status,
  });
  const decisionRef = await dependencies.artifactStore.writeText(
    "execution-routing",
    "routing.md",
    "Execution routing evidence fixture.",
  );
  const resultRef = await dependencies.artifactStore.writeText(
    "implementation",
    "result.md",
    "implementation evidence",
  );
  const replanRef = await dependencies.artifactStore.writeText(
    "round-decision",
    "replan.md",
    "Explicit replan decision evidence fixture.",
  );
  let state = await advanceWorkflow(
    settled.state,
    { type: "EXECUTION_ROUTED", decisionRef },
    store,
  );
  state = await advanceWorkflow(
    state,
    { type: "IMPLEMENTATION_COMPLETE", resultRef },
    store,
  );
  state = await advanceWorkflow(
    state,
    { type: "REPLAN_REQUIRED", decisionRef: replanRef },
    store,
  );
  expect(state.planning.currentPlanRef).toEqual(handle.planRef);
  expect(state.planning.planReview).toEqual(handle);
  expect(state.planning.approvedPlanRef).toBeUndefined();
  expect(state.planning.latestPlanReviewRef).toBeUndefined();
  const fresh = new PlanningOrchestrator(dependencies);
  await expect(
    fresh.applyPlanReview({ state, reviewId, status }),
  ).rejects.toThrow(/awaiting-plan-review/);
  expect(await store.loadState()).toEqual(state);
  expect(await readdir(join(store.rootDirectory, "plan-reviews"))).toEqual([
    "review-1.md",
  ]);

  const next = await new PlanningOrchestrator({
    ...dependencies,
    subagentExecutor: new FakeSubagentExecutor({ run: success(plan) }),
  }).createPlan({ state });
  expect(next.state.planning.currentPlanVersion).toBe(2);
  expect(next.state.planning.planReview).toBeUndefined();
  expect(next.state.planning.approvedPlanRef).toBeUndefined();
  await expect(
    fresh.applyPlanReview({ state: next.state, reviewId, status }),
  ).rejects.toThrow(/binding/);
  expect(await store.loadState()).toEqual(next.state);
});

test.each(["scout", "research"])(
  "I2: restart after %s failure retains required stages and reuses saved evidence",
  async (stage) => {
    const executor = new FakeSubagentExecutor({
      run:
        stage === "scout"
          ? failure("infrastructure")
          : [success("facts"), failure("infrastructure")],
    });
    const started = await startWorkflow(
      {
        task: "Needs a Human decision",
        playbook: "feature",
        context: {
          requiresResearch: true,
          requiresClarification: true,
          requiresArchitecture: true,
        },
      },
      { runsDirectory: await root(), subagentExecutor: executor },
    );
    const store = new StateStore(started.runDirectory);
    const blocked = await store.loadState();
    expect(blocked.phase).toBe("blocked");
    const restored = await advanceWorkflow(
      blocked,
      { type: "BLOCK_RESOLVED" },
      store,
    );
    const resumedExecutor = new FakeSubagentExecutor({
      run: [success("facts"), success("research")],
    });
    const resumed = await new PlanningOrchestrator({
      artifactStore: started.artifactStore,
      stateStore: store,
      subagentExecutor: resumedExecutor,
    }).gatherContext({ state: restored });
    expect(resumed.state.phase).toBe("clarifying");
    expect(resumed.state.planning).toMatchObject({
      researchRequired: true,
      clarificationRequired: true,
      architectureRequired: true,
    });
    expect(resumedExecutor.calls.run.map((call) => call.agent)).toEqual(
      stage === "scout"
        ? ["workflow-scout", "pi-ketch.researcher"]
        : ["pi-ketch.researcher"],
    );
    expect(resumed.state.planning.context.researchRef).toBeDefined();
    expect(await store.loadState()).toEqual(resumed.state);
  },
);

test("I2: missing legacy planning policy fails closed before any child", async () => {
  const { dependencies, started } = await ready();
  const state = structuredClone(started.state);
  delete state.planning.researchRequired;
  const executor = new FakeSubagentExecutor();
  const orchestrator = new PlanningOrchestrator({
    ...dependencies,
    subagentExecutor: executor,
  });
  await expect(orchestrator.createPlan({ state })).rejects.toThrow(
    /planning policy/,
  );
  state.phase = "gathering-context";
  await expect(orchestrator.gatherContext({ state })).rejects.toThrow(
    /planning policy/,
  );
  expect(executor.calls.run).toHaveLength(0);
});

test.each(["pending", "approved", "feedback", "unknown"] as const)(
  "I3: existing identity reconciles %s without opening or overwriting",
  async (status) => {
    const { dependencies, created, handle, gate, store } = await ready();
    const opened = await new PlanningOrchestrator({
      ...dependencies,
      plannotatorGate: gate,
    }).openPlanReview({ state: created.state });
    const result: PlanReviewStatus =
      status === "feedback"
        ? { ...handle, status, feedback: "Revise" }
        : { ...handle, status };
    const freshGate = new FakePlannotatorGate({
      getPlanReview: { type: "result", value: result },
    });
    const fresh = new PlanningOrchestrator({
      ...dependencies,
      plannotatorGate: freshGate,
    });
    const outcome = await fresh.openPlanReview({
      state: await store.loadState(),
    });
    expect(outcome.status).toBe("reconciled");
    if (outcome.status !== "reconciled")
      throw new Error("expected reconciliation");
    expect(outcome.outcome.status).toBe(status);
    expect(outcome.state.external).toEqual(opened.state.external);
    expect(outcome.state.planning.planReview).toEqual(handle);
    expect(freshGate.calls.openPlanReview).toHaveLength(0);
    expect(freshGate.calls.getPlanReview).toEqual([reviewId]);
  },
);

test("I3: legacy identity without exact binding is not reopened or overwritten", async () => {
  const { dependencies, created, gate } = await ready();
  const state = {
    ...created.state,
    external: { "plannotator.plan-review.v1": reviewId },
  };
  await expect(
    new PlanningOrchestrator({
      ...dependencies,
      plannotatorGate: gate,
    }).openPlanReview({ state }),
  ).rejects.toThrow(/binding/);
  expect(gate.calls.openPlanReview).toHaveLength(0);
  expect(gate.calls.getPlanReview).toHaveLength(0);
});

test("M1: Plan artifact persists but State save failure prevents Human Gate open", async () => {
  const executor = new FakeSubagentExecutor({
    run: [success("facts"), success(plan)],
  });
  const started = await startWorkflow(
    { task: "Plan", playbook: "feature" },
    { runsDirectory: await root(), subagentExecutor: executor },
  );
  const gate = new FakePlannotatorGate();
  const orchestrator = new PlanningOrchestrator({
    artifactStore: started.artifactStore,
    subagentExecutor: executor,
    plannotatorGate: gate,
    stateStore: {
      saveState: async () => {
        throw new Error("State disk failure");
      },
    },
  });
  await expect(
    orchestrator.createPlan({ state: started.state }),
  ).rejects.toThrow("State disk failure");
  expect(await readdir(join(started.runDirectory, "plans"))).toEqual([
    "plan-v1.md",
  ]);
  expect(await new StateStore(started.runDirectory).loadState()).toEqual(
    started.state,
  );
  expect(gate.calls.openPlanReview).toHaveLength(0);
});

test("M1: review identity save failure rejects and cannot grant authority, even with a live adapter binding", async () => {
  const { dependencies, created, store } = await ready();
  let queries = 0;
  const gate = new PlannotatorIntegration({
    planReader: { readText: async () => plan },
    events: {
      emit(_channel, payload) {
        const action =
          payload !== null && typeof payload === "object"
            ? Reflect.get(payload, "action")
            : undefined;
        const respond =
          payload !== null && typeof payload === "object"
            ? Reflect.get(payload, "respond")
            : undefined;
        if (typeof action !== "string" || typeof respond !== "function") {
          throw Error("Invalid gate request");
        }
        if (action === "review-status") queries++;
        respond({
          status: "handled",
          result:
            action === "plan-review"
              ? { status: "pending", reviewId }
              : { status: "completed", reviewId, approved: true },
        });
      },
    },
  });
  const orchestrator = new PlanningOrchestrator({
    ...dependencies,
    plannotatorGate: gate,
    stateStore: {
      saveState: async () => {
        throw new Error("identity disk failure");
      },
    },
  });
  await expect(
    orchestrator.openPlanReview({ state: created.state }),
  ).rejects.toThrow("identity disk failure");
  const current = await store.loadState();
  expect(current).toEqual(created.state);
  await expect(
    orchestrator.reconcilePlanReview({ state: current, reviewId }),
  ).rejects.toThrow(/binding/);
  await expect(
    orchestrator.applyPlanReview({
      state: current,
      reviewId,
      status: {
        reviewId,
        planRef: created.planRef,
        planVersion: 1,
        status: "approved",
      },
    }),
  ).rejects.toThrow(/binding/);
  expect(queries).toBe(0);
  expect(current.planning.approvedPlanRef).toBeUndefined();
});

test("M1: persisted settled artifact can be retried after approval State save failure", async () => {
  const { dependencies, created, handle, gate, store } = await ready();
  const opened = await new PlanningOrchestrator({
    ...dependencies,
    plannotatorGate: gate,
  }).openPlanReview({ state: created.state });
  const status = { ...handle, status: "approved" as const };
  const failing = new PlanningOrchestrator({
    ...dependencies,
    stateStore: {
      saveState: async () => {
        throw new Error("approval State failure");
      },
    },
  });
  await expect(
    failing.applyPlanReview({ state: opened.state, reviewId, status }),
  ).rejects.toThrow("approval State failure");
  expect((await store.loadState()).phase).toBe("awaiting-plan-review");
  const restored = await new PlanningOrchestrator(dependencies).applyPlanReview(
    { state: await store.loadState(), reviewId, status },
  );
  expect(restored.state.phase).toBe("implementing");
  expect(await readdir(join(store.rootDirectory, "plan-reviews"))).toEqual([
    "review-1.md",
  ]);
});
