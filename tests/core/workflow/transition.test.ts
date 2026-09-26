import { expect, test } from "vitest";
import type { ArtifactRef } from "../../../src/core/artifacts/references.ts";
import { assertStateInvariants } from "../../../src/core/workflow/invariants.ts";
import { transition } from "../../../src/core/workflow/transition.ts";
import type {
  WorkflowEvent,
  WorkflowState,
} from "../../../src/core/workflow/state.ts";
import { parseWorkflowState } from "../../../src/core/workflow/state.ts";

const hash = "a".repeat(64);

function ref<K extends ArtifactRef["kind"]>(
  kind: K,
  path: string,
): ArtifactRef<K> {
  return { kind, path, schemaVersion: 1, sha256: hash };
}

function initialState(): WorkflowState {
  return parseWorkflowState({
    schemaVersion: 1,
    workflowId: "workflow-1",
    stateRevision: 0,
    playbook: "feature",
    phase: "gathering-context",
    taskRef: ref("task", "context/task.json"),
    planning: {
      context: {},
      currentPlanVersion: 0,
    },
    coding: {
      implementationRevision: 0,
      reviewRound: 0,
    },
    counters: {
      automatedFixRoundsUsed: 0,
      strongerRetriesUsed: 0,
      humanCodeFeedbackRounds: 0,
    },
    external: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

function apply(state: WorkflowState, event: WorkflowEvent): WorkflowState {
  const result = transition(state, event);
  if (!result.ok) throw result.error;
  return result.state;
}

const planRef = ref("plan", "plans/plan-v1.md");
const planV2Ref = ref("plan", "plans/plan-v2.md");
const reviewRef = ref("plan-review", "plan-reviews/review-1.md");
const routingRef = ref(
  "execution-routing",
  "decisions/execution-routing-1.json",
);
const implementationRef = ref(
  "implementation",
  "implementations/implementation-1.json",
);
const validationRef = ref("validation", "validation/validation-1.json");
const correctnessReviewRef = ref(
  "correctness-review",
  "reviews/correctness-1.json",
);
const ponytailReviewRef = ref("ponytail-review", "reviews/ponytail-1.json");
const findingEvaluationRef = ref(
  "finding-evaluation",
  "reviews/finding-evaluation-1.json",
);
const decisionRef = ref("round-decision", "decisions/round-decision-1.json");
const findingsRef = ref(
  "accepted-findings",
  "findings/accepted-findings-1.json",
);
const codeReviewRef = ref("code-review", "reviews/code-review-1.json");
const reconciliationRef = ref("reconciliation", "reconciliation/1.json");

function approvedState(): WorkflowState {
  let state = apply(initialState(), { type: "CONTEXT_READY" });
  state = apply(state, { type: "PLAN_CREATED", planRef, version: 1 });
  return apply(state, {
    type: "PLAN_APPROVED",
    planRef,
    version: 1,
    reviewRef,
  });
}

function validatingState(): WorkflowState {
  let state = approvedState();
  state = apply(state, { type: "EXECUTION_ROUTED", decisionRef: routingRef });
  return apply(state, {
    type: "IMPLEMENTATION_COMPLETE",
    resultRef: implementationRef,
  });
}

function reviewingState(): WorkflowState {
  return apply(validatingState(), {
    type: "VALIDATION_PASSED",
    resultRef: validationRef,
  });
}

function codeReviewState(): WorkflowState {
  return apply(reviewingState(), {
    type: "REVIEW_COMPLETE",
    decisionRef,
  });
}

test("transitions CONTEXT_READY without mutating the input", () => {
  const state = initialState();
  const result = transition(state, { type: "CONTEXT_READY" });

  expect(result).toEqual({
    ok: true,
    state: { ...state, phase: "planning" },
  });
  expect(state.phase).toBe("gathering-context");
});

test("follows the complete happy-path transition table", () => {
  const state = codeReviewState();
  const completed = apply(state, {
    type: "CODE_APPROVED",
    reviewRef: codeReviewRef,
  });

  expect(completed.phase).toBe("completed");
  expect(completed.coding.latestCodeReviewRef).toEqual(codeReviewRef);
  expect(completed.planning.approvedPlanRef).toEqual(planRef);
  expect(completed.coding.implementationRevision).toBe(1);
  expect(completed.coding.reviewRound).toBe(1);
});

test("routes clarification from context gathering and returns to planning", () => {
  const clarifying = apply(initialState(), {
    type: "CLARIFICATION_REQUIRED",
    reasonRef: ref("round-decision", "decisions/context-question.json"),
  });
  expect(clarifying.phase).toBe("clarifying");
  expect(clarifying.coding.roundDecisionRef?.kind).toBe("round-decision");

  const planning = apply(clarifying, {
    type: "CLARIFICATION_COMPLETE",
    clarificationRef: ref("clarification", "context/clarification.json"),
  });
  expect(planning.phase).toBe("planning");
  expect(planning.planning.context.clarificationRef?.kind).toBe(
    "clarification",
  );
});

test("routes plan feedback back to planning", () => {
  let state = apply(initialState(), { type: "CONTEXT_READY" });
  state = apply(state, { type: "PLAN_CREATED", planRef, version: 1 });
  state = apply(state, {
    type: "PLAN_FEEDBACK",
    feedbackRef: ref("plan-review", "reviews/plan-feedback-1.json"),
  });

  expect(state.phase).toBe("planning");
  expect(state.planning.latestPlanReviewRef?.kind).toBe("plan-review");
});

test("requires PLAN_APPROVED to match the current plan and version", () => {
  const state = apply(initialState(), { type: "CONTEXT_READY" });
  const awaitingReview = apply(state, {
    type: "PLAN_CREATED",
    planRef,
    version: 1,
  });
  const result = transition(awaitingReview, {
    type: "PLAN_APPROVED",
    reviewRef,
    planRef: planV2Ref,
    version: 2,
  });

  expect(result.ok).toBe(false);
  expect(awaitingReview.phase).toBe("awaiting-plan-review");
});

test("requires sequential plan versions and invalidates old authority", () => {
  let state = apply(initialState(), { type: "CONTEXT_READY" });
  state = apply(state, { type: "PLAN_CREATED", planRef, version: 1 });
  state = apply(state, {
    type: "PLAN_APPROVED",
    planRef,
    version: 1,
    reviewRef,
  });
  state = apply(state, { type: "EXECUTION_ROUTED", decisionRef: routingRef });
  state = apply(state, {
    type: "IMPLEMENTATION_COMPLETE",
    resultRef: implementationRef,
  });
  state = apply(state, {
    type: "REPLAN_REQUIRED",
    decisionRef,
  });

  expect(state.phase).toBe("planning");
  expect(state.planning.approvedPlanRef).toBeUndefined();
  expect(state.planning.approvedPlanVersion).toBeUndefined();
  expect(state.coding.executionRoutingRef).toBeUndefined();

  state = apply(state, {
    type: "PLAN_CREATED",
    planRef: planV2Ref,
    version: 2,
  });
  state = apply(state, {
    type: "PLAN_APPROVED",
    reviewRef,
    planRef: planV2Ref,
    version: 2,
  });
  expect(
    transition(state, {
      type: "IMPLEMENTATION_COMPLETE",
      resultRef: implementationRef,
    }).ok,
  ).toBe(false);
  state = apply(state, {
    type: "EXECUTION_ROUTED",
    decisionRef: ref("execution-routing", "decisions/execution-routing-2.json"),
  });
  expect(
    transition(state, {
      type: "IMPLEMENTATION_COMPLETE",
      resultRef: implementationRef,
    }).ok,
  ).toBe(true);
  expect(
    transition(state, { type: "PLAN_CREATED", planRef: planV2Ref, version: 3 })
      .ok,
  ).toBe(false);
});

test("routes coding clarification and review escalation events", () => {
  let state = validatingState();
  state = apply(state, {
    type: "CLARIFICATION_REQUIRED",
    reasonRef: decisionRef,
  });
  expect(state.phase).toBe("clarifying");

  state = reviewingState();
  state = apply(state, {
    type: "CLARIFICATION_REQUIRED",
    reasonRef: decisionRef,
  });
  expect(state.phase).toBe("clarifying");

  state = reviewingState();
  state = apply(state, {
    type: "STRONGER_RETRY_REQUIRED",
    decisionRef,
    executionRoutingRef: ref(
      "execution-routing",
      "decisions/execution-routing-stronger.json",
    ),
  });
  expect(state.phase).toBe("fixing");
  expect(state.counters.strongerRetriesUsed).toBe(1);
  expect(state.coding.executionRoutingRef?.path).toBe(
    "decisions/execution-routing-stronger.json",
  );

  state = reviewingState();
  state = apply(state, { type: "REPLAN_REQUIRED", decisionRef });
  expect(state.phase).toBe("planning");
  expect(state.planning.approvedPlanRef).toBeUndefined();
});

test("records raw review artifacts without granting Fix authority", () => {
  const state = apply(reviewingState(), {
    type: "REVIEW_ARTIFACTS_PERSISTED",
    correctnessReviewRef,
    ponytailReviewRef,
  });

  expect(state.phase).toBe("reviewing");
  expect(state.coding.correctnessReviewRef).toEqual(correctnessReviewRef);
  expect(state.coding.ponytailReviewRef).toEqual(ponytailReviewRef);
  expect(state.coding.acceptedFindingsRef).toBeUndefined();
});

test("publishes evaluation and accepted refs without changing the reviewing phase", () => {
  const state = apply(reviewingState(), {
    type: "FINDING_EVALUATION_PERSISTED",
    findingEvaluationRef,
    acceptedFindingsRef: findingsRef,
  });

  expect(state.phase).toBe("reviewing");
  expect(state.coding.findingEvaluationRef).toEqual(findingEvaluationRef);
  expect(state.coding.acceptedFindingsRef).toEqual(findingsRef);
});

test("routes validation and review retries while accounting for counters", () => {
  let state = validatingState();
  state = apply(state, {
    type: "RETRY_REQUIRED",
    decisionRef,
    validationRef,
  });
  expect(state.phase).toBe("fixing");
  expect(state.counters.automatedFixRoundsUsed).toBe(1);
  expect(state.coding.roundDecisionRef).toEqual(decisionRef);
  expect(state.coding.validationRef).toEqual(validationRef);

  state = apply(state, {
    type: "IMPLEMENTATION_COMPLETE",
    resultRef: ref("implementation", "implementations/implementation-2.json"),
  });
  state = apply(state, {
    type: "VALIDATION_PASSED",
    resultRef: ref("validation", "validation/validation-2.json"),
  });
  state = apply(state, {
    type: "REVIEW_RETRY_REQUIRED",
    decisionRef: ref("round-decision", "decisions/round-decision-2.json"),
    findingsRef,
  });

  expect(state.phase).toBe("fixing");
  expect(state.counters.automatedFixRoundsUsed).toBe(2);
  expect(state.coding.acceptedFindingsRef).toEqual(findingsRef);
});

test("counts stronger retries separately and preserves human feedback accounting", () => {
  let state = validatingState();
  state = apply(state, {
    type: "STRONGER_RETRY_REQUIRED",
    decisionRef,
  });
  expect(state.counters).toEqual({
    automatedFixRoundsUsed: 1,
    strongerRetriesUsed: 1,
    humanCodeFeedbackRounds: 0,
  });

  state = codeReviewState();
  state = apply(state, { type: "CODE_FEEDBACK", feedbackRef: codeReviewRef });
  expect(state.phase).toBe("fixing");
  expect(state.counters.humanCodeFeedbackRounds).toBe(1);
  expect(state.counters.automatedFixRoundsUsed).toBe(0);
});

test("records and resolves a recoverable block", () => {
  const awaitingReview = apply(
    apply(initialState(), { type: "CONTEXT_READY" }),
    { type: "PLAN_CREATED", planRef, version: 1 },
  );
  const blocked = apply(awaitingReview, {
    type: "BLOCK",
    reason: "integration-unavailable",
    evidenceRef: reconciliationRef,
  });

  expect(blocked.phase).toBe("blocked");
  expect(blocked.block).toEqual({
    blockedFrom: "awaiting-plan-review",
    reason: "integration-unavailable",
    evidenceRef: reconciliationRef,
  });
  expect(
    transition(blocked, { type: "FAIL", reason: "state-corrupt" }).ok,
  ).toBe(false);

  const resumed = apply(blocked, {
    type: "BLOCK_RESOLVED",
    evidenceRef: reconciliationRef,
  });
  expect(resumed.phase).toBe("awaiting-plan-review");
  expect(resumed.block).toBeUndefined();
});

test("reaches terminal failed but never changes a terminal state", () => {
  const failed = apply(initialState(), {
    type: "FAIL",
    reason: "state-corrupt",
    evidenceRef: reconciliationRef,
  });
  expect(failed.phase).toBe("failed");
  expect(failed.failure?.reason).toBe("state-corrupt");
  expect(
    transition(failed, { type: "FAIL", reason: "invalid-transition" }).ok,
  ).toBe(false);
});

test("rejects invalid events and structurally invalid states", () => {
  const state = initialState();
  expect(
    transition(state, { type: "PLAN_APPROVED", planRef, version: 1, reviewRef })
      .ok,
  ).toBe(false);
  expect(() => assertStateInvariants({ ...state, phase: "blocked" })).toThrow();
});

test("routes validation failure clarification back through planning", () => {
  const result = transition(validatingState(), {
    type: "CLARIFICATION_REQUIRED",
    reasonRef: decisionRef,
  });

  expect(result.ok).toBe(true);
  if (result.ok) expect(result.state.phase).toBe("clarifying");
});

test("does not infer a blocking finding from an accepted findings artifact ref", () => {
  const state = reviewingState();
  state.coding.acceptedFindingsRef = findingsRef;

  const result = transition(state, { type: "REVIEW_COMPLETE", decisionRef });

  expect(result.ok).toBe(true);
  if (result.ok) expect(result.state.phase).toBe("awaiting-code-review");
});

test("asserts authority and terminal-state invariants", () => {
  const approved = approvedState();
  expect(() =>
    assertStateInvariants({
      ...approved,
      phase: "validating",
      planning: { ...approved.planning, approvedPlanRef: undefined },
    }),
  ).toThrow();

  expect(() =>
    assertStateInvariants({
      ...initialState(),
      phase: "failed",
    }),
  ).toThrow();

  expect(() =>
    assertStateInvariants({
      ...initialState(),
      phase: "blocked",
      block: {
        blockedFrom: "completed",
        reason: "operator-attention-required",
      },
    }),
  ).toThrow();

  expect(() =>
    assertStateInvariants({
      ...initialState(),
      counters: {
        automatedFixRoundsUsed: 0,
        strongerRetriesUsed: 1,
        humanCodeFeedbackRounds: 0,
      },
    }),
  ).toThrow();
});
