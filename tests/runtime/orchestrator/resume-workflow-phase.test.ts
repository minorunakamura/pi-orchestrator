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

async function approvePlan(workflow: PhaseCWorkflow) {
  const created = await workflow.createPlan();
  const approved = await workflow.settlePlan();
  expect(created.state.phase).toBe("awaiting-plan-review");
  expect(approved.state.phase).toBe("implementing");
}

async function reachReview(workflow: PhaseCWorkflow) {
  await approvePlan(workflow);
  await workflow.implement();
  await workflow.validate();
  await workflow.review();
}

describe("ORCH-018 phase-specific reconciliation", () => {
  test("reconciles a persisted Code Gate identity without opening a second review", async () => {
    const workflow = await setup();
    await reachReview(workflow);
    await workflow.evaluate();
    const round = await workflow.decide();
    expect(round.state.phase).toBe("awaiting-code-review");
    const opened = await workflow.openCode();
    expect(opened.status).toBe("opened");
    const before = workflow.gates.filter(
      (gate) => gate.action === "code-review",
    ).length;

    const resumed = await workflow.resume();

    expect(resumed.status).toBe("advanced");
    expect(resumed.state.phase).toBe("completed");
    expect(
      workflow.gates.filter((gate) => gate.action === "code-review"),
    ).toHaveLength(before);
  });

  test("does not rerun deterministic validation when the exact result is durable", async () => {
    const workflow = await setup();
    await approvePlan(workflow);
    await workflow.implement();
    const validation = await workflow.validate();
    const state = await workflow.load();
    const interrupted = {
      ...state,
      phase: "validating" as const,
      coding: { ...state.coding, reviewRound: 0 },
    };
    await workflow.stateStore.saveState(interrupted, state.stateRevision);
    const calls = workflow.validations.length;

    const resumed = await workflow.resume();

    expect(resumed.status).toBe("advanced");
    expect(resumed.state.phase).toBe("reviewing");
    expect(resumed.state.coding.validationRef).toEqual(
      validation.validationRef,
    );
    expect(workflow.validations).toHaveLength(calls);
  });

  test("reuses complete automated review artifacts and does not fan out reviewers again", async () => {
    const workflow = await setup();
    await reachReview(workflow);
    const reviewerRuns = workflow.children.filter(
      (child) =>
        child.agent === "reviewer" || child.agent === "ponytail-reviewer",
    ).length;

    const resumed = await workflow.resume();

    expect(resumed.status).toBe("advanced");
    expect(resumed.state.phase).toBe("reviewing");
    expect(
      workflow.children.filter(
        (child) =>
          child.agent === "reviewer" || child.agent === "ponytail-reviewer",
      ),
    ).toHaveLength(reviewerRuns);
    expect(resumed.state.coding.findingEvaluationRef).toBeDefined();
  });

  test("reuses accepted-findings and a fresh round decision without another Jev call", async () => {
    const workflow = await setup();
    await reachReview(workflow);
    await workflow.evaluate();
    const round = await workflow.decide();
    const calls = workflow.roundCalls();
    const interrupted = { ...round.state, phase: "reviewing" as const };
    await workflow.stateStore.saveState(interrupted, round.state.stateRevision);

    const resumed = await workflow.resume();

    expect(resumed.status).toBe("advanced");
    expect(resumed.state.phase).toBe("awaiting-code-review");
    expect(workflow.roundCalls()).toBe(calls);
  });

  test("re-evaluates stale routing during resume instead of reusing it", async () => {
    const workflow = await setup();
    await approvePlan(workflow);
    workflow.faults.intentState = true;
    await expect(workflow.implement()).rejects.toThrow();
    const before = workflow.jevRequests.filter(
      (request) => "modelTier" in request.questions,
    ).length;

    const resumed = await workflow.resume({ changeScope: "changed scope" });

    expect(resumed.status).toBe("advanced");
    expect(resumed.state.phase).toBe("validating");
    expect(
      workflow.jevRequests.filter(
        (request) => "modelTier" in request.questions,
      ),
    ).toHaveLength(before + 1);
    expect(
      workflow.children.filter((child) => child.agent === "worker"),
    ).toHaveLength(1);
  });

  test("keeps an ambiguous Worker blocked and never dispatches a duplicate", async () => {
    const workflow = await setup({ workers: ["ambiguous"] });
    await approvePlan(workflow);
    await expect(workflow.implement()).rejects.toThrow();
    const before = workflow.children.filter(
      (child) => child.agent === "worker",
    ).length;

    const resumed = await workflow.resume();

    expect(resumed.status).toBe("blocked");
    expect(resumed.state.phase).toBe("blocked");
    expect(
      workflow.children.filter((child) => child.agent === "worker"),
    ).toHaveLength(before);
  });

  test("continues a blocked Jev workflow only after BLOCK_RESOLVED", async () => {
    const workflow = await setup({ jevFailures: 1 });
    await approvePlan(workflow);
    await expect(workflow.implement()).rejects.toThrow();
    expect((await workflow.load()).phase).toBe("blocked");

    const resumed = await workflow.resume();

    expect(resumed.status).toBe("advanced");
    expect(resumed.state.phase).toBe("validating");
    expect(resumed.state.block).toBeUndefined();
    expect(
      workflow.children.filter((child) => child.agent === "worker"),
    ).toHaveLength(1);
  });

  test("possible orphan Code Gate is blocked without reopening", async () => {
    const workflow = await setup();
    await reachReview(workflow);
    await workflow.evaluate();
    const round = await workflow.decide();
    workflow.faults.codeIdentityState = true;
    // The external open succeeds, but local identity persistence is faulted.
    await expect(workflow.openCode()).rejects.toThrow();
    const before = workflow.gates.filter(
      (gate) => gate.action === "code-review",
    ).length;
    const resumed = await workflow.resume();

    expect(resumed.status).toBe("blocked");
    expect(resumed.state.phase).toBe("blocked");
    expect(
      workflow.gates.filter((gate) => gate.action === "code-review"),
    ).toHaveLength(before);
    expect(round.state.phase).toBe("awaiting-code-review");
  });
});
