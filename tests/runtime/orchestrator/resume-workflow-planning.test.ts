import { afterEach, describe, expect, test } from "vitest";
import {
  phaseCWorkflow,
  type PhaseCWorkflow,
} from "../../fakes/phase-c-workflow.ts";

const workflows: PhaseCWorkflow[] = [];
async function setup(script = {}) {
  const workflow = await phaseCWorkflow(script);
  workflows.push(workflow);
  return workflow;
}
afterEach(async () => {
  await Promise.all(workflows.splice(0).map((workflow) => workflow.cleanup()));
});

describe("ORCH-018 planning/context reconciliation", () => {
  test("reuses durable context evidence instead of rerunning the scout", async () => {
    const workflow = await setup();
    const state = await workflow.load();
    const interrupted = {
      ...state,
      phase: "gathering-context" as const,
      planning: { ...state.planning, context: {} },
    };
    await workflow.stateStore.saveState(interrupted, state.stateRevision);
    const scouts = workflow.children.filter(
      (child) => child.agent === "workflow-scout",
    ).length;

    const resumed = await workflow.resume();

    expect(resumed.status).toBe("pending");
    expect(resumed.state.phase).toBe("awaiting-plan-review");
    expect(
      workflow.children.filter((child) => child.agent === "workflow-scout"),
    ).toHaveLength(scouts);
    expect(resumed.state.planning.context.scoutRef).toBeDefined();
  });

  test("reconciles a durable orphan Plan artifact before invoking the planner", async () => {
    const workflow = await setup();
    const created = await workflow.createPlan();
    const state = await workflow.load();
    const interrupted = {
      ...state,
      phase: "planning" as const,
      planning: { ...state.planning, currentPlanVersion: 0 },
    };
    delete interrupted.planning.currentPlanRef;
    delete interrupted.planning.planReview;
    await workflow.stateStore.saveState(interrupted, state.stateRevision);
    const planners = workflow.children.filter(
      (child) => child.agent === "planner",
    ).length;

    const resumed = await workflow.resume();

    // Recovering the Plan alone cannot reconstruct its missing Human binding.
    expect(resumed.status).toBe("blocked");
    expect(resumed.state.block?.reason).toBe("operator-attention-required");
    expect(resumed.state.planning.currentPlanRef).toEqual(created.planRef);
    expect(
      workflow.children.filter((child) => child.agent === "planner"),
    ).toHaveLength(planners);
  });

  test("clarification resume requires explicit Human prompt and never infers an answer", async () => {
    const workflow = await setup();
    const state = await workflow.load();
    const interrupted = { ...state, phase: "clarifying" as const };
    await workflow.stateStore.saveState(interrupted, state.stateRevision);

    const blocked = await workflow.resume();
    expect(blocked.status).toBe("blocked");
    expect(blocked.state.block?.reason).toBe("operator-attention-required");

    // A second workflow demonstrates the explicit prompt path without relying on transient hints.
    const next = await setup({ clarification: true });
    const nextState = await next.load();
    await next.stateStore.saveState(
      { ...nextState, phase: "clarifying" as const },
      nextState.stateRevision,
    );
    const resumed = await next.resume({
      clarificationPrompt: "Choose the scope",
    });
    expect(resumed.status).toBe("pending");
    expect(resumed.state.phase).toBe("awaiting-plan-review");
    expect(resumed.state.planning.context.clarificationRef).toBeDefined();
  });
});
