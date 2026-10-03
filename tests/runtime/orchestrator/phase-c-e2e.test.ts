import { afterEach, describe, expect, test } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  phaseCWorkflow,
  reviewFinding,
  type PhaseCWorkflow,
  type WorkflowScript,
} from "../../fakes/phase-c-workflow.ts";
import { contract } from "../../fakes/coding-scenario.ts";
import type { ArtifactRef } from "../../../src/core/artifacts/references.ts";

const workflows: PhaseCWorkflow[] = [];
async function setup(script: WorkflowScript = {}) {
  const h = await phaseCWorkflow(script);
  workflows.push(h);
  return h;
}
afterEach(async () => {
  await Promise.all(workflows.splice(0).map((h) => h.cleanup()));
});
const workers = (h: PhaseCWorkflow) =>
  h.children.filter((request) => request.agent === "worker");
const codeGates = (h: PhaseCWorkflow) =>
  h.gates.filter((request) => request.action === "code-review");
async function artifact(h: PhaseCWorkflow, ref: ArtifactRef | undefined) {
  expect(ref).toBeDefined();
  return JSON.parse(await h.artifactStore.readText(ref!));
}
async function approvePlan(h: PhaseCWorkflow) {
  const created = await h.createPlan();
  expect(created.state.phase).toBe("awaiting-plan-review");
  const count = workers(h).length;
  await expect(h.implement()).rejects.toThrow(/approved plan/iu);
  expect(workers(h)).toHaveLength(count);
  const approved = await h.settlePlan();
  expect(approved.state.phase).toBe("implementing");
  return approved;
}
async function reviewedRound(h: PhaseCWorkflow) {
  await h.implement();
  const validation = await h.validate();
  expect(validation.validation.status).toBe("passed");
  await h.review();
  await h.evaluate();
  return h.decide();
}
async function approveCode(h: PhaseCWorkflow) {
  const opened = await h.openCode();
  expect(opened.status).toBe("opened");
  expect((await h.load()).phase).toBe("awaiting-code-review");
  const completed = await h.settleCode();
  expect(completed.state.phase).toBe("completed");
  return completed;
}

describe("Phase C full fake end-to-end contract", () => {
  test("happy path crosses both Human Gates and every Phase C runner", async () => {
    const h = await setup();
    await approvePlan(h);
    const round = await reviewedRound(h);
    expect(round.state.phase).toBe("awaiting-code-review");
    expect(codeGates(h)).toHaveLength(0);
    for (const key of [
      "correctnessReviewRef",
      "ponytailReviewRef",
      "findingEvaluationRef",
    ] as const) {
      // Preserve the fixture's artifact assertion order.
      // oxlint-disable-next-line eslint/no-await-in-loop
      expect((await artifact(h, round.state.coding[key])).findings).toEqual([]);
    }
    expect(
      (await artifact(h, round.state.coding.acceptedFindingsRef)).accepted,
    ).toEqual([]);
    await approveCode(h);
    const agents = h.children.map((child) => child.agent);
    expect(agents.slice(0, 4)).toEqual([
      "workflow-scout",
      "planner",
      "plan-simplicity-reviewer",
      "worker",
    ]);
    // Parallel preflight/persistence does not promise reviewer dispatch order.
    expect(agents.slice(4).toSorted()).toEqual([
      "ponytail-reviewer",
      "reviewer",
    ]);
    expect(h.children.every((child) => child.context === "fresh")).toBe(true);
    expect(h.validations).toEqual([contract]);
    expect(h.jevRequests).toHaveLength(2);
    const state = await h.load();
    expect(state.jevUsage?.attemptsReserved).toBe(6);
    const attempt = await artifact(h, state.coding.workerAttemptRef);
    expect(attempt).toMatchObject({
      status: "succeeded",
      runId: "worker-1",
      launchStatus: "observed",
    });
    expect(attempt.after.snapshot.untracked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "implementation.txt" }),
      ]),
    );
    expect(h.listenerCount()).toBe(0);
  });

  test("Plan feedback re-enters planning and the next approved Plan Gate enables coding", async () => {
    const h = await setup({ planReviews: ["feedback", "approved"] });
    const first = await h.createPlan();
    expect(first.state.phase).toBe("awaiting-plan-review");
    const feedback = await h.settlePlan();
    expect(feedback.status).toBe("feedback");
    expect(feedback.state.phase).toBe("planning");
    expect(feedback.state.planning.approvedPlanRef).toBeUndefined();

    const second = await h.createPlan();
    expect(second.state.planning.currentPlanVersion).toBe(2);
    const approved = await h.settlePlan();
    expect(approved.status).toBe("approved");
    expect(approved.state.phase).toBe("implementing");
    await expect(h.implement()).resolves.toBeDefined();
    expect(workers(h)).toHaveLength(1);
    expect(
      h.gates.filter((gate) => gate.action === "plan-review"),
    ).toHaveLength(2);
  });

  test("validation failure routes through Round Decision before retry, then completes", async () => {
    const h = await setup({
      validations: ["failed", "passed"],
      rounds: [{ action: "COMPLETE" }, { action: "COMPLETE" }],
    });
    await approvePlan(h);
    await h.implement();
    const failed = await h.validate();
    expect(failed.state.phase).toBe("validating");
    expect(h.roundCalls()).toBe(0);
    expect(
      h.children.filter((child) => child.agent === "reviewer"),
    ).toHaveLength(0);
    expect(workers(h)).toHaveLength(1);
    const retry = await h.decide();
    expect(retry.state.phase).toBe("fixing");
    expect(retry.decision).toMatchObject({
      decision: "RETRY",
      reason: "validation-failed",
    });
    expect(retry.state.coding.validationRef).toEqual(failed.validationRef);
    expect(retry.state.counters.automatedFixRoundsUsed).toBe(1);
    const clean = await reviewedRound(h);
    expect(clean.state.phase).toBe("awaiting-code-review");
    await approveCode(h);
    expect(workers(h)).toHaveLength(2);
    expect(h.validations).toHaveLength(2);
  }, 15_000);

  test("review finding becomes accepted Fix authority, rejected findings stay out of Worker", async () => {
    const accepted = reviewFinding("C1");
    const rejected = reviewFinding("P1", "ponytail");
    const h = await setup({
      reviews: [[accepted, rejected], []],
      findings: { P1: { planConflict: true } },
      rounds: [{ action: "COMPLETE" }, { action: "COMPLETE" }],
    });
    await approvePlan(h);
    const retry = await reviewedRound(h);
    expect(retry.state.phase).toBe("fixing");
    const acceptedRef = retry.state.coding.acceptedFindingsRef;
    expect((await artifact(h, acceptedRef)).accepted).toEqual([accepted]);
    expect(
      (await artifact(h, retry.state.coding.findingEvaluationRef)).findings.map(
        (finding: { findingId: string; decision: string }) => [
          finding.findingId,
          finding.decision,
        ],
      ),
    ).toEqual([
      ["C1", "ACCEPT"],
      ["P1", "REJECT"],
    ]);
    const clean = await reviewedRound(h);
    await approveCode(h);
    expect(workers(h)[1].task).toContain(JSON.stringify(acceptedRef));
    expect(workers(h)[1].task).not.toContain(
      JSON.stringify(retry.state.coding.correctnessReviewRef),
    );
    expect(workers(h)[1].task).not.toContain(
      JSON.stringify(retry.state.coding.ponytailReviewRef),
    );
    const findingRequests = h.jevRequests.filter(
      (request) => "evidenceSupported" in request.questions,
    );
    expect(findingRequests).toHaveLength(2);
    expect(findingRequests[0].state).toMatchObject({
      finding: accepted,
      reviewRef: retry.state.coding.correctnessReviewRef,
      approvedPlanRef: retry.state.planning.approvedPlanRef,
      implementationRevision: 1,
      evidence: {
        plan: {
          ref: retry.state.planning.approvedPlanRef,
          content: await h.artifactStore.readText(
            retry.state.planning.approvedPlanRef!,
          ),
        },
        implementation: {
          ref: retry.state.coding.implementationRef,
          content: await h.artifactStore.readText(
            retry.state.coding.implementationRef!,
          ),
        },
        architecture: "included-in-plan",
        previousDecision: null,
      },
    });
    const roundRequests = h.jevRequests.filter(
      (request) => "decision" in request.questions,
    );
    expect(roundRequests).toHaveLength(2);
    expect(roundRequests[1].state).toMatchObject({
      approvedPlanRef: clean.state.planning.approvedPlanRef,
      implementationRevision: 2,
      evidence: {
        plan: {
          ref: clean.state.planning.approvedPlanRef,
          content: await h.artifactStore.readText(
            clean.state.planning.approvedPlanRef!,
          ),
        },
        implementation: {
          ref: clean.state.coding.implementationRef,
          content: await h.artifactStore.readText(
            clean.state.coding.implementationRef!,
          ),
        },
        previousDecision: {
          ref: retry.roundDecisionRef,
          content: await h.artifactStore.readText(retry.roundDecisionRef),
        },
        counters: {
          automatedFixRoundsUsed: 1,
          strongerRetriesUsed: 0,
          humanCodeFeedbackRounds: 0,
        },
      },
    });
  }, 10_000);

  test("stronger retry consumes both budgets and cannot downgrade on routing re-evaluation", async () => {
    const h = await setup({
      routes: [
        { model: "ECONOMY", reasoning: "LOW" },
        { model: "ECONOMY", reasoning: "LOW" },
      ],
      rounds: [
        { action: "ESCALATE", reason: "implementation-capability" },
        { action: "COMPLETE" },
      ],
    });
    await approvePlan(h);
    const retry = await reviewedRound(h);
    expect(retry.state.phase).toBe("fixing");
    expect(retry.state.counters).toMatchObject({
      automatedFixRoundsUsed: 1,
      strongerRetriesUsed: 1,
    });
    await reviewedRound(h);
    await approveCode(h);
    expect(workers(h)[0]).toMatchObject({
      model: "fake/economy:low",
    });
    expect(workers(h)[1]).toMatchObject({
      model: "fake/standard:medium",
      context: "fresh",
    });
  }, 10_000);

  test("plan-conflict invalidates approval and requires a new Plan Gate before coding", async () => {
    const h = await setup({
      rounds: [
        { action: "ESCALATE", reason: "plan-conflict" },
        { action: "COMPLETE" },
      ],
    });
    const first = await approvePlan(h);
    const conflict = await reviewedRound(h);
    expect(conflict.state.phase).toBe("planning");
    expect(conflict.state.planning.approvedPlanRef).toBeUndefined();
    const second = await approvePlan(h);
    expect(second.state.planning.approvedPlanVersion).toBe(2);
    expect(second.state.planning.approvedPlanRef).not.toEqual(
      first.state.planning.approvedPlanRef,
    );
    await reviewedRound(h);
    await approveCode(h);
    expect(workers(h)[1].task).toContain(
      JSON.stringify(second.state.planning.approvedPlanRef),
    );
    expect(h.gates.filter((g) => g.action === "plan-review")).toHaveLength(2);
  }, 10_000);

  test.each([
    "human-finding",
    "uncertain-finding",
    "low-action",
    "low-reason",
  ] as const)(
    "%s cannot bypass clarification and a new Human Plan Gate",
    async (mode) => {
      const hasFinding = mode.endsWith("finding");
      const h = await setup({
        reviews: hasFinding
          ? [[reviewFinding("A"), reviewFinding("H")], []]
          : undefined,
        findings: {
          H: mode === "human-finding" ? { human: true } : { confidence: 0.1 },
        },
        rounds: [
          mode === "low-reason"
            ? {
                action: "ESCALATE",
                reason: "implementation-capability",
                reasonConfidence: 0.1,
              }
            : {
                action: "RETRY",
                confidence: mode === "low-action" ? 0.1 : 0.99,
              },
          { action: "COMPLETE" },
        ],
      });
      await approvePlan(h);
      const escalation = await reviewedRound(h);
      expect(escalation.state.phase).toBe("clarifying");
      expect(escalation.state.counters.automatedFixRoundsUsed).toBe(0);
      expect(workers(h)).toHaveLength(1);
      const clarified = await h.clarify();
      expect(clarified.state.phase).toBe("planning");
      expect(h.clarifications).toHaveLength(1);
      await approvePlan(h);
      await reviewedRound(h);
      await approveCode(h);
      expect(workers(h)).toHaveLength(2);
    },
    10_000,
  );

  test("two distinct Human clarifications retain immutable answers and continue through the third Plan and Code Gates", async () => {
    const h = await setup({
      rounds: [
        { action: "ESCALATE", reason: "human-decision" },
        { action: "ESCALATE", reason: "human-decision" },
      ],
    });
    await approvePlan(h);
    expect((await reviewedRound(h)).state.phase).toBe("clarifying");
    const first = await h.clarify();
    const firstRef = first.state.planning.context.clarificationRef!;
    expect(await h.artifactStore.readText(firstRef)).toContain(
      "Approved scope choice 1",
    );
    await approvePlan(h);
    const second = await reviewedRound(h);
    expect(second.state.phase).toBe("clarifying");
    expect(second.state.coding.implementationRevision).toBe(2);
    const clarified = await h.clarify();
    expect(clarified.status).toBe("provided");
    const secondRef = clarified.state.planning.context.clarificationRef!;
    expect(secondRef).not.toEqual(firstRef);
    expect(secondRef.path).not.toBe(firstRef.path);
    expect(await h.artifactStore.readText(secondRef)).toContain(
      "Approved scope choice 2",
    );
    const state = await h.load();
    expect(state.phase).toBe("planning");
    expect(state.planning.context.clarificationRef).toEqual(secondRef);
    expect(await h.artifactStore.readText(firstRef)).toContain(
      "Approved scope choice 1",
    );
    expect(h.clarifications).toHaveLength(2);
    const third = await approvePlan(h);
    expect(third.state.planning.approvedPlanVersion).toBe(3);
    const planner = h.children.findLast((child) => child.agent === "planner")!;
    expect(planner.task).toContain(JSON.stringify(secondRef));
    expect(planner.task).not.toContain(JSON.stringify(firstRef));
    await reviewedRound(h);
    const completed = await approveCode(h);
    expect(completed.state.coding.implementationRevision).toBe(3);
    expect(completed.state.planning.context.clarificationRef).toEqual(
      secondRef,
    );
    expect(workers(h)).toHaveLength(3);
    expect(h.gates.filter((g) => g.action === "plan-review")).toHaveLength(3);
    expect(await h.artifactStore.readText(firstRef)).toContain(
      "Approved scope choice 1",
    );
    expect(await h.artifactStore.readText(secondRef)).toContain(
      "Approved scope choice 2",
    );
  }, 30000);

  test("Human Code Feedback returns to fixing without automated budget consumption", async () => {
    const h = await setup({ codeReviews: ["feedback", "approved"] });
    await approvePlan(h);
    await reviewedRound(h);
    await h.openCode();
    const feedback = await h.settleCode();
    expect(feedback.state.phase).toBe("fixing");
    const feedbackRef = feedback.state.coding.latestCodeReviewRef;
    expect(feedback.state.counters).toMatchObject({
      automatedFixRoundsUsed: 0,
      humanCodeFeedbackRounds: 1,
    });
    const clean = await reviewedRound(h);
    expect(clean.state.coding.implementationRevision).toBe(2);
    expect(clean.state.coding.codeReview).toBeUndefined();
    expect(workers(h)[1].task).toContain(JSON.stringify(feedbackRef));
    await approveCode(h);
    expect(codeGates(h)).toHaveLength(2);
  });

  test.each(["after-validation", "after-review"])(
    "review stage bypass %s is rejected before Round Jev or Code Gate",
    async (point) => {
      const h = await setup();
      await approvePlan(h);
      await h.implement();
      await h.validate();
      if (point === "after-review") await h.review();
      await expect(h.decide()).rejects.toThrow(/review|finding/iu);
      expect((await h.load()).phase).toBe("reviewing");
      expect(h.roundCalls()).toBe(0);
      expect(codeGates(h)).toHaveLength(0);
      expect(workers(h)).toHaveLength(1);
    },
  );

  test.each([
    "correctnessReviewRef",
    "ponytailReviewRef",
    "findingEvaluationRef",
    "acceptedFindingsRef",
  ] as const)(
    "missing current %s is rejected after the real review/evaluation stages",
    async (key) => {
      const h = await setup();
      await approvePlan(h);
      await h.implement();
      await h.validate();
      await h.review();
      await h.evaluate();
      const state = await h.load();
      delete state.coding[key];
      await h.stateStore.saveState(state, state.stateRevision);
      await expect(h.decide()).rejects.toThrow(/review|finding/iu);
      expect(h.roundCalls()).toBe(0);
      expect(codeGates(h)).toHaveLength(0);
      expect((await h.load()).phase).toBe("reviewing");
    },
  );

  test("Validation Contract substitution cannot reach the executor", async () => {
    const h = await setup();
    await approvePlan(h);
    await h.implement();
    await expect(
      h.validate({
        ...contract,
        checks: [{ ...contract.checks[0], command: "true" }],
      }),
    ).rejects.toThrow(/contract/iu);
    expect(h.validations).toHaveLength(0);
    expect((await h.load()).phase).toBe("validating");
    expect(h.roundCalls()).toBe(0);
    expect(codeGates(h)).toHaveLength(0);
  });

  test("stale execution-routing cannot be reused after a pre-dispatch persistence failure", async () => {
    const h = await setup();
    await approvePlan(h);
    h.faults.intentState = true;
    await expect(h.implement()).rejects.toThrow(
      "injected intent State failure",
    );
    const routed = await h.load();
    expect(routed.coding.executionRoutingRef).toBeDefined();
    expect(routed.coding.workerAttemptRef).toBeUndefined();
    expect(workers(h)).toHaveLength(0);
    await expect(h.implement("changed routing evidence")).rejects.toThrow(
      /stale|fresh/iu,
    );
    expect(workers(h)).toHaveLength(0);
    expect(h.jevRequests).toHaveLength(1);
  });

  test("identity-only Code Review State cannot be rebound after adapter restart", async () => {
    const h = await setup();
    await approvePlan(h);
    await reviewedRound(h);
    const opened = await h.openCode();
    if (opened.status !== "opened") throw Error("expected opened");
    const state = await h.load();
    delete state.coding.codeReview;
    await h.stateStore.saveState(state, state.stateRevision);
    const polls = h.gates.filter((g) => g.action === "review-status").length;
    await expect(
      h.coding(true).reconcileCodeReview({
        state: await h.load(),
        reviewId: opened.handle.reviewId,
      }),
    ).rejects.toThrow(/binding/iu);
    expect(h.gates.filter((g) => g.action === "review-status")).toHaveLength(
      polls,
    );
    expect((await h.load()).phase).toBe("awaiting-code-review");
  });

  test("same-revision mismatched implementation digest from the external Code Gate is rejected", async () => {
    const h = await setup({ staleCodeStatus: true });
    await approvePlan(h);
    await reviewedRound(h);
    await h.openCode();
    await expect(h.settleCode(true)).rejects.toThrow(/binding|stale/iu);
    expect((await h.load()).phase).toBe("awaiting-code-review");
    expect((await h.load()).coding.latestCodeReviewRef).toBeUndefined();
  });

  test("exact Code Review binding survives fresh adapter without reopening", async () => {
    const h = await setup();
    await approvePlan(h);
    await reviewedRound(h);
    await h.openCode();
    const result = await h
      .coding(true)
      .openCodeReview({ state: await h.load() });
    expect(result.status).toBe("reconciled");
    expect(result.state.phase).toBe("completed");
    expect(codeGates(h)).toHaveLength(1);
  });

  test("old revision Code Approval cannot complete a new revision", async () => {
    const h = await setup({ codeReviews: ["feedback", "approved"] });
    await approvePlan(h);
    await reviewedRound(h);
    const old = await h.openCode();
    if (old.status !== "opened") throw Error("expected opened");
    await h.settleCode();
    await reviewedRound(h);
    await h.openCode();
    await expect(
      h.coding(true).applyCodeReview({
        state: await h.load(),
        reviewId: old.handle.reviewId,
        status: { ...old.handle, status: "approved" },
      }),
    ).rejects.toThrow(/identity|revision|binding/iu);
    expect((await h.load()).phase).toBe("awaiting-code-review");
    expect((await h.settleCode(true)).state.phase).toBe("completed");
  });

  test.each(["timeout", "ambiguous"] as const)(
    "pi-subagents %s persists mutation evidence and blocks without validation",
    async (mode) => {
      const h = await setup({ workers: [mode] });
      await approvePlan(h);
      await expect(h.implement()).rejects.toThrow(/Worker did not succeed/iu);
      const state = await h.load();
      expect(state.block?.reason).toBe("agent-execution-ambiguous");
      expect(h.validations).toHaveLength(0);
      expect(h.roundCalls()).toBe(0);
      const terminal = await artifact(h, state.coding.workerAttemptRef);
      expect(terminal.status).toBe(
        mode === "timeout" ? "timed-out" : "ambiguous",
      );
      expect(terminal.runId).toBe("worker-1");
      const received = await artifact(h, terminal.previousRef);
      expect(received.after.status).toBe("pending");
      expect(received.dispatch.requestId).toBe(workers(h)[0].requestId);
      expect(terminal.after.snapshot.untracked).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "implementation.txt" }),
        ]),
      );
      expect(
        await readFile(join(h.repositoryCwd, "implementation.txt"), "utf8"),
      ).toContain("revision 1");
      expect(workers(h)).toHaveLength(1);
      expect(h.listenerCount()).toBe(0);
    },
  );

  test("partial reviewer timeout cannot fabricate a clean round", async () => {
    const h = await setup({ silentReviewer: true });
    await approvePlan(h);
    await h.implement();
    await h.validate();
    await expect(h.review()).rejects.toThrow();
    const state = await h.load();
    expect(state.phase).toBe("blocked");
    expect(state.coding.findingEvaluationRef).toBeUndefined();
    expect(h.roundCalls()).toBe(0);
    expect(codeGates(h)).toHaveLength(0);
    expect(h.listenerCount()).toBe(0);
  });

  test.each([true, false])(
    "validation infrastructure stop policy %s never becomes automated fixing",
    async (stop) => {
      const h = await setup({
        validations: ["infrastructure-error"],
        stopOnInfrastructureFailure: stop,
        rounds: [{ action: "RETRY" }],
      });
      await approvePlan(h);
      await h.implement();
      const result = await h.validate();
      expect((await artifact(h, result.validationRef)).status).toBe(
        "infrastructure-error",
      );
      if (stop) {
        expect(result.state.block?.reason).toBe(
          "validation-infrastructure-error",
        );
        expect(h.roundCalls()).toBe(0);
      } else {
        const round = await h.decide();
        expect(round.state.phase).toBe("clarifying");
        expect(round.decision).toMatchObject({
          decision: "ESCALATE",
          escalationReason: "uncertain",
        });
      }
      expect((await h.load()).counters.automatedFixRoundsUsed).toBe(0);
      expect(
        h.children.filter((child) => child.agent === "reviewer"),
      ).toHaveLength(0);
      expect(workers(h)).toHaveLength(1);
    },
  );

  test.each(["consent", "budget"])(
    "Jev %s failure sends no request and starts no Worker",
    async (kind) => {
      const h = await setup(kind === "budget" ? { maxRequests: 0 } : {});
      await approvePlan(h);
      if (kind === "consent")
        h.configuration.jev.runtimePolicy!.grant.active = false;
      await expect(h.implement()).rejects.toThrow(
        /consent|budget|operator attention/iu,
      );
      expect((await h.load()).block?.reason).toBe(
        "operator-attention-required",
      );
      expect(h.jevRequests).toHaveLength(0);
      expect(workers(h)).toHaveLength(0);
    },
  );

  test("budget exhausted between findings publishes no partial Fix authority", async () => {
    const h = await setup({
      maxRequests: 2,
      reviews: [[reviewFinding("C1"), reviewFinding("C2")]],
    });
    await approvePlan(h);
    await h.implement();
    await h.validate();
    await h.review();
    await expect(h.evaluate()).rejects.toThrow(/consent|budget/iu);
    const state = await h.load();
    expect(state.block?.reason).toBe("operator-attention-required");
    expect(state.jevUsage?.attemptsReserved).toBe(6);
    expect(h.jevRequests).toHaveLength(2);
    expect(state.coding.acceptedFindingsRef).toBeUndefined();
    expect(state.coding.findingEvaluationRef).toBeUndefined();
    expect(h.roundCalls()).toBe(0);
    expect(await artifact(h, state.jevUsage?.latestRequestRef)).toMatchObject({
      family: "finding",
      findingId: "C1",
      ordinal: 6,
    });
  });

  test("transport retry is charged before completing the normal workflow", async () => {
    const h = await setup({ jevFailures: 1, transportRetries: 1 });
    await approvePlan(h);
    await reviewedRound(h);
    await approveCode(h);
    expect(h.jevRequests).toHaveLength(3);
    expect((await h.load()).jevUsage?.attemptsReserved).toBe(7);
  });

  test("automated retry budget exhaustion stops the actual loop before another Worker", async () => {
    const h = await setup({
      maxFixes: 2,
      rounds: [{ action: "RETRY" }, { action: "RETRY" }, { action: "RETRY" }],
    });
    await approvePlan(h);
    expect((await reviewedRound(h)).state.phase).toBe("fixing");
    expect((await reviewedRound(h)).state.phase).toBe("fixing");
    const exhausted = await reviewedRound(h);
    expect(exhausted.state.block?.reason).toBe("retry-budget-exhausted");
    expect(exhausted.state.counters.automatedFixRoundsUsed).toBe(2);
    expect(workers(h)).toHaveLength(3);
    expect(codeGates(h)).toHaveLength(0);
  }, 30000);

  test("stronger retry budget and strongest profile are hard stops", async () => {
    const h = await setup({
      routes: [
        { model: "ECONOMY", reasoning: "LOW" },
        { model: "ECONOMY", reasoning: "LOW" },
      ],
      rounds: [
        { action: "ESCALATE", reason: "implementation-capability" },
        { action: "ESCALATE", reason: "implementation-capability" },
      ],
    });
    await approvePlan(h);
    await reviewedRound(h);
    const exhausted = await reviewedRound(h);
    expect(exhausted.state.block?.reason).toBe("retry-budget-exhausted");
    expect(exhausted.state.counters.strongerRetriesUsed).toBe(1);
    expect(workers(h)).toHaveLength(2);
    const strongest = await setup({
      routes: [{ model: "STRONG", reasoning: "HIGH" }],
      rounds: [{ action: "ESCALATE", reason: "implementation-capability" }],
    });
    await approvePlan(strongest);
    expect((await reviewedRound(strongest)).state.block?.reason).toBe(
      "stronger-profile-unavailable",
    );
    expect(workers(strongest)).toHaveLength(1);
  }, 30000);

  test("unavailable Jev and Code Gate block rather than bypass integrations", async () => {
    const jev = await setup({ jevFailures: 1 });
    await approvePlan(jev);
    await expect(jev.implement()).rejects.toThrow();
    expect((await jev.load()).block?.reason).toBe("integration-unavailable");
    expect(workers(jev)).toHaveLength(0);
    const gate = await setup({ codeGateUnavailable: true });
    await approvePlan(gate);
    await reviewedRound(gate);
    expect((await gate.openCode()).state.block?.reason).toBe(
      "human-gate-unavailable",
    );
    expect((await gate.load()).phase).not.toBe("completed");
  });

  test.each(["routingArtifact", "routingState"] as const)(
    "%s failure prevents Worker dispatch on the connected path",
    async (fault) => {
      const h = await setup();
      await approvePlan(h);
      h.faults[fault] = true;
      await expect(h.implement()).rejects.toThrow(/injected routing/iu);
      expect(workers(h)).toHaveLength(0);
      expect(h.validations).toHaveLength(0);
      expect((await h.load()).coding.executionRoutingRef).toBeUndefined();
    },
  );

  test("Code Approval State failure cannot complete until the identical durable result is applied", async () => {
    const h = await setup();
    await approvePlan(h);
    await reviewedRound(h);
    await h.openCode();
    h.faults.codeApprovalState = true;
    await expect(h.settleCode()).rejects.toThrow(
      "injected Code Approval State failure",
    );
    const state = await h.load();
    expect(state.phase).toBe("awaiting-code-review");
    expect(state.coding.latestCodeReviewRef).toBeUndefined();
    expect((await h.settleCode(true)).state.phase).toBe("completed");
    expect(codeGates(h)).toHaveLength(1);
  });

  test("repeated resume after completion does not duplicate Worker, review, or gate side effects", async () => {
    const h = await setup();
    await approvePlan(h);
    await reviewedRound(h);
    await approveCode(h);
    const before = {
      workers: workers(h).length,
      reviewers: h.children.filter(
        (child) =>
          child.agent === "reviewer" || child.agent === "ponytail-reviewer",
      ).length,
      codeGates: codeGates(h).length,
      planGates: h.gates.filter((gate) => gate.action === "plan-review").length,
      jev: h.jevRequests.length,
    };

    const firstResume = await h.resume();
    const afterFirstResume = await h.load();
    const secondResume = await h.resume();
    const afterSecondResume = await h.load();

    expect(firstResume.state.phase).toBe("completed");
    expect(secondResume.state.phase).toBe("completed");
    expect(afterSecondResume.stateRevision).toBe(
      afterFirstResume.stateRevision,
    );
    expect(workers(h)).toHaveLength(before.workers);
    expect(
      h.children.filter(
        (child) =>
          child.agent === "reviewer" || child.agent === "ponytail-reviewer",
      ),
    ).toHaveLength(before.reviewers);
    expect(codeGates(h)).toHaveLength(before.codeGates);
    expect(
      h.gates.filter((gate) => gate.action === "plan-review"),
    ).toHaveLength(before.planGates);
    expect(h.jevRequests).toHaveLength(before.jev);
  });

  test("unrecoverable review authority corruption reaches failed, not blocked continuation", async () => {
    const h = await setup();
    await approvePlan(h);
    await h.implement();
    await h.validate();
    await h.review();
    const state = await h.load();
    const reviewRef = state.coding.correctnessReviewRef;
    expect(reviewRef).toBeDefined();
    await writeFile(
      join(h.artifactStore.rootDirectory, reviewRef!.path),
      "{}",
      "utf8",
    );

    const result = await h.resume();

    expect(result.status).toBe("failed");
    expect(result.state.phase).toBe("failed");
    expect(result.state.failure?.reason).toBe("authoritative-artifact-corrupt");
    expect(result.state.block).toBeUndefined();
  });

  test("Code Gate identity persistence failure cannot publish approval", async () => {
    const h = await setup();
    await approvePlan(h);
    await reviewedRound(h);
    h.faults.codeIdentityState = true;
    const polls = h.gates.filter((g) => g.action === "review-status").length;
    await expect(h.openCode()).rejects.toThrow(
      "injected Code Review identity State failure",
    );
    expect(h.gates.filter((g) => g.action === "review-status")).toHaveLength(
      polls,
    );
    const state = await h.load();
    expect(state.phase).toBe("awaiting-code-review");
    expect(state.coding.codeReview).toBeUndefined();
    expect(state.coding.latestCodeReviewRef).toBeUndefined();
  });
});
