import { afterEach, describe, expect, test, vi } from "vitest";
import {
  phaseCWorkflow,
  reviewFinding,
  type PhaseCWorkflow,
  type WorkflowScript,
} from "../../fakes/phase-c-workflow.ts";
import { WorkflowOwnership } from "../../../src/runtime/orchestrator/workflow-ownership.ts";
import { WorkflowReconciler } from "../../../src/runtime/orchestrator/reconciler.ts";
import { PlannotatorIntegration } from "../../../src/runtime/integrations/plannotator.ts";
import type { CodeReviewResult } from "../../../src/runtime/ports/index.ts";

const workflows: PhaseCWorkflow[] = [];
async function setup(script: WorkflowScript = {}) {
  const workflow = await phaseCWorkflow(script);
  workflows.push(workflow);
  return workflow;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(workflows.splice(0).map((workflow) => workflow.cleanup()));
});

async function planGate(h: PhaseCWorkflow) {
  const waiting = await h.drive();
  expect(waiting.status).toBe("pending");
  expect(waiting.state.phase).toBe("awaiting-plan-review");
  expect(waiting.state.planning.approvedPlanRef).toBeUndefined();
  expect(h.children.filter((child) => child.agent === "worker")).toHaveLength(
    0,
  );
  return waiting;
}

describe("normal lifecycle driver over existing runners (not full v1)", () => {
  test.each([false, true])(
    "owned Git/non-Git (%s) Worker/fix evidence advances checkpoints without granting Main authority",
    async (nonGit) => {
      const h = await setup({
        nonGit,
        validations: ["failed", "passed"],
        rounds: [{ action: "RETRY" }],
      });
      const ownership = new WorkflowOwnership(h.repositoryCwd, "root-session");
      await ownership.initialize(await h.load(), h.stateStore);
      const gate = await h.drive({ ownership });
      expect(gate.state.phase).toBe("awaiting-plan-review");
      expect(
        h.children.filter((child) => child.agent === "worker"),
      ).toHaveLength(0);
      const done = await h.drive({ ownership });
      expect(done.state.phase).toBe("completed");
      expect(done.state.workspaceCheckpointRef).toBeDefined();
      expect(
        h.children.filter((child) => child.agent === "worker"),
      ).toHaveLength(2);
      expect(h.validations).toHaveLength(2);
    },
    20000,
  );

  test("drives accepted Plan approval to Code Gate and accepted Code approval to completion without reconciliation", async () => {
    const h = await setup();
    const reconcile = vi.spyOn(WorkflowReconciler.prototype, "reconcile");
    await planGate(h);
    const waiting = await h.drive();
    expect(waiting.status).toBe("advanced");
    expect(waiting.state.phase).toBe("completed");
    expect(waiting.state.planning.latestPlanReviewRef).toBeDefined();
    expect(waiting.state.coding.findingEvaluationRef).toBeDefined();
    expect(waiting.state.coding.acceptedFindingsRef).toBeDefined();
    expect(waiting.state.coding.latestCodeReviewRef).toBeDefined();
    const completed = await h.drive();
    expect(completed.state.phase).toBe("completed");
    expect((await h.drive()).state).toEqual(completed.state);
    expect(h.children.filter((child) => child.agent === "worker")).toHaveLength(
      1,
    );
    expect(h.validations).toHaveLength(1);
    expect(reconcile).not.toHaveBeenCalled();
  });

  test("a genuine synchronous Human Code wait preserves durable attempt and automatically continues only after settlement", async () => {
    const h = await setup();
    await planGate(h);
    const gate = new PlannotatorIntegration({
      events: h.gateEvents,
      planReader: h.artifactStore,
    });
    let settle!: (result: CodeReviewResult) => void;
    const answer = new Promise<CodeReviewResult>((resolve) => {
      settle = resolve;
    });
    const open = vi.fn(async () => answer);
    let finished = false;
    const progress = h
      .drive({
        plannotatorGate: {
          openPlanReview: gate.openPlanReview.bind(gate),
          getPlanReview: gate.getPlanReview.bind(gate),
          openCodeReview: open,
        },
      })
      .then((result) => {
        finished = true;
        return result;
      });
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce(), {
      timeout: 10000,
    });
    expect(finished).toBe(false);
    const waiting = await h.load();
    expect(waiting.phase).toBe("awaiting-code-review");
    expect(waiting.coding.codeReviewAttemptRef).toBeDefined();
    expect(waiting.coding.latestCodeReviewRef).toBeUndefined();
    settle({ approved: true });
    const completed = await progress;
    expect(completed.state.phase).toBe("completed");
    expect(completed.state.coding.latestCodeReviewRef).toBeDefined();
    expect(open).toHaveBeenCalledOnce();
  }, 10000);

  test.each([
    {
      name: "failed validation",
      validations: ["failed", "passed"],
      rounds: [{ action: "RETRY" }],
    },
    {
      name: "accepted review finding",
      reviews: [[reviewFinding("regression")], []],
      rounds: [{ action: "RETRY" }],
    },
    {
      name: "stronger profile",
      rounds: [{ action: "ESCALATE", reason: "implementation-capability" }],
    },
  ] satisfies (WorkflowScript & { name: string })[])(
    "automatically completes the safe $name fix loop",
    async (script) => {
      const h = await setup(script);
      await planGate(h);
      const result = await h.drive();
      expect(result.state.phase).toBe("completed");
      expect(result.state.coding.implementationRevision).toBe(2);
      expect(result.state.counters.automatedFixRoundsUsed).toBe(1);
      expect(
        h.children.filter((child) => child.agent === "worker"),
      ).toHaveLength(2);
      expect(h.validations).toHaveLength(2);
    },
  );

  test("Plan feedback automatically creates a new Plan and waits for fresh Human approval", async () => {
    const h = await setup({ planReviews: ["feedback", "approved"] });
    const first = await planGate(h);
    const second = await h.drive();
    expect(second.state.phase).toBe("awaiting-plan-review");
    expect(second.state.planning.currentPlanVersion).toBe(2);
    expect(second.state.planning.currentPlanRef).not.toEqual(
      first.state.planning.currentPlanRef,
    );
    expect(second.state.planning.approvedPlanRef).toBeUndefined();
    expect(h.children.filter((child) => child.agent === "worker")).toHaveLength(
      0,
    );
    expect((await h.drive()).state.phase).toBe("completed");
  });

  test("Human Code feedback automatically fixes, validates and reviews before a new Code Gate", async () => {
    const h = await setup({ codeReviews: ["feedback", "approved"] });
    await planGate(h);
    await h.drive();
    const fixed = await h.drive();
    expect(fixed.state.phase).toBe("completed");
    expect(fixed.state.coding.implementationRevision).toBe(2);
    expect(fixed.state.counters.humanCodeFeedbackRounds).toBe(1);
    expect(fixed.state.counters.automatedFixRoundsUsed).toBe(0);
    expect(
      h.gates.filter((gate) => gate.action === "code-review"),
    ).toHaveLength(2);
    expect((await h.drive()).state.phase).toBe("completed");
  });

  test("clarification is a genuine wait; only a confirmed durable answer continues to Planning", async () => {
    const h = await setup({ clarification: true });
    const state = await h.load();
    await h.stateStore.saveState(
      { ...state, phase: "clarifying" },
      state.stateRevision,
    );
    const waiting = await h.drive({
      clarificationPort: { request: async () => ({ status: "pending" }) },
    });
    expect(waiting.status).toBe("pending");
    expect(waiting.state.phase).toBe("clarifying");
    expect(waiting.state.planning.clarificationRequestRef).toBeDefined();
    expect(h.clarifications).toHaveLength(0);
    const answered = await h.drive();
    expect(answered.state.phase).toBe("awaiting-plan-review");
    expect(answered.state.planning.context.clarificationRef).toBeDefined();
    expect(h.clarifications).toHaveLength(1);
  });

  test("plan-conflict returns automatically to a fresh mandatory Plan Gate", async () => {
    const h = await setup({
      rounds: [{ action: "ESCALATE", reason: "plan-conflict" }],
    });
    await planGate(h);
    const result = await h.drive();
    expect(result.state.phase).toBe("awaiting-plan-review");
    expect(result.state.planning.currentPlanVersion).toBe(2);
    expect(result.state.planning.approvedPlanRef).toBeUndefined();
    expect(h.children.filter((child) => child.agent === "worker")).toHaveLength(
      1,
    );
  });

  test.each([
    {
      name: "retry budget",
      maxFixes: 1,
      validations: ["failed", "failed"],
      rounds: [{ action: "RETRY" }, { action: "RETRY" }],
    },
    {
      name: "validation infrastructure",
      validations: ["infrastructure-error"],
    },
    { name: "Worker timeout", workers: ["timeout"] },
    { name: "ambiguous Worker", workers: ["ambiguous"] },
  ] satisfies (WorkflowScript & { name: string })[])(
    "stops at $name and normal driving never unblocks or redispatches",
    async (script) => {
      const h = await setup(script);
      await planGate(h);
      const blocked = await h.drive();
      expect(blocked.status).toBe("blocked");
      const calls = h.children.length;
      expect((await h.drive()).state).toEqual(blocked.state);
      expect(h.children).toHaveLength(calls);
    },
  );

  test("shutdown stops continuation without claiming cancellation of the completed stage", async () => {
    const h = await setup();
    await planGate(h);
    const controller = new AbortController();
    const stopped = await h.drive({
      signal: controller.signal,
      validationExecutor: {
        execute: async (contract) => {
          const evidence = await h.validationExecutor.execute(contract);
          controller.abort();
          return evidence;
        },
      },
    });
    expect(stopped.status).toBe("pending");
    expect(stopped.state.phase).toBe("reviewing");
    expect(stopped.state.coding.validationRef).toBeDefined();
    expect(
      h.children.filter((child) => child.agent === "reviewer"),
    ).toHaveLength(0);
    expect(stopped.state.failure).toBeUndefined();
  });

  test.each(["intent", "binding"] as const)(
    "Plan Gate %s State failure prevents unsafe continuation/reopen",
    async (failure) => {
      const h = await setup();
      await expect(
        h.drive({
          stateStore: {
            saveState: (state, revision) => {
              if (
                failure === "intent"
                  ? state.external["plannotator.plan-review.v1.intent"]
                  : state.planning.planReview
              )
                throw Error("Gate State failure");
              return h.stateStore.saveState(state, revision);
            },
          },
        }),
      ).rejects.toThrow("Gate State failure");
      const opens = h.gates.filter(
        (gate) => gate.action === "plan-review",
      ).length;
      expect(opens).toBe(failure === "intent" ? 0 : 1);
      expect((await h.drive()).status).toBe("blocked");
      expect(
        h.gates.filter((gate) => gate.action === "plan-review"),
      ).toHaveLength(opens);
      expect(
        h.children.filter((child) => child.agent === "worker"),
      ).toHaveLength(0);
    },
  );

  test("does not start downstream side effects after a required State save fails", async () => {
    const h = await setup();
    await planGate(h);
    h.faults.routingState = true;
    await expect(h.drive()).rejects.toThrow("routing State failure");
    expect(h.children.filter((child) => child.agent === "worker")).toHaveLength(
      0,
    );
    expect(h.validations).toHaveLength(0);
  });

  test("validation failure reference must persist before Round Decision or another Worker", async () => {
    const h = await setup({ validations: ["failed"] });
    await planGate(h);
    await expect(
      h.drive({
        stateStore: {
          saveState: (state, revision) => {
            if (state.coding.validationRef)
              throw Error("validation State failure");
            return h.stateStore.saveState(state, revision);
          },
        },
      }),
    ).rejects.toThrow("validation State failure");
    expect(h.roundCalls()).toBe(0);
    expect(h.children.filter((child) => child.agent === "worker")).toHaveLength(
      1,
    );
  });
});
