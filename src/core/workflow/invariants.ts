import { isArtifactRef, type ArtifactRef } from "../artifacts/references.ts";
import { InvariantViolationError } from "./errors.ts";
import { isWorkflowState, type WorkflowState } from "./state.ts";
import type { WorkflowPhase } from "./phase.ts";

const implementationPhases = new Set<WorkflowPhase>([
  "implementing",
  "validating",
  "reviewing",
  "fixing",
  "awaiting-code-review",
]);

function fail(message: string): never {
  throw new InvariantViolationError(message);
}

export function sameArtifactRef(
  left: ArtifactRef | undefined,
  right: ArtifactRef | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.kind === right.kind &&
    left.path === right.path &&
    left.schemaVersion === right.schemaVersion &&
    left.sha256 === right.sha256
  );
}

export function assertStateInvariants(state: WorkflowState): void {
  if (!isWorkflowState(state)) {
    fail("State does not match the WorkflowState schema");
  }

  const { phase, planning, coding } = state;
  for (const [stage, attempt] of Object.entries(planning.agentAttempts ?? {})) {
    if (
      attempt.dispatch.ownerRunId !== state.workflowId ||
      attempt.dispatch.nodeId !== stage ||
      (attempt.receipt &&
        attempt.receipt.requestId !== attempt.dispatch.requestId)
    ) {
      fail("Planning attempt must belong to its Workflow and stage");
    }
  }

  if (planning.currentPlanVersion === 0 && planning.currentPlanRef) {
    fail("currentPlanRef requires a positive currentPlanVersion");
  }
  if (planning.currentPlanVersion > 0 && !planning.currentPlanRef) {
    fail("currentPlanVersion requires currentPlanRef");
  }
  if (
    planning.planReview &&
    (!sameArtifactRef(planning.planReview.planRef, planning.currentPlanRef) ||
      planning.planReview.planVersion !== planning.currentPlanVersion ||
      !sameArtifactRef(
        planning.planReview.simplicityReviewRef,
        planning.simplicityReviewRef,
      ) ||
      state.external[
        `plannotator.plan-review.v${planning.planReview.planVersion}`
      ] !== planning.planReview.reviewId)
  ) {
    fail(
      "planReview must match the current plan and persisted external identity",
    );
  }
  if (planning.approvedPlanRef) {
    if (
      planning.approvedPlanVersion === undefined ||
      !planning.currentPlanRef ||
      !sameArtifactRef(planning.approvedPlanRef, planning.currentPlanRef) ||
      planning.approvedPlanVersion !== planning.currentPlanVersion
    ) {
      fail("approvedPlanRef must match the current plan and version");
    }
  } else if (planning.approvedPlanVersion !== undefined) {
    fail("approvedPlanVersion requires approvedPlanRef");
  }

  if (phase === "blocked") {
    if (!state.block) fail("blocked state requires block metadata");
    if (state.failure) fail("blocked state cannot contain failure metadata");
    if (
      state.block.blockedFrom === "blocked" ||
      state.block.blockedFrom === "completed" ||
      state.block.blockedFrom === "failed"
    ) {
      fail("blockedFrom must identify a resumable active phase");
    }
  } else if (state.block) {
    fail("block metadata is only valid in blocked state");
  }

  if (phase === "failed") {
    if (!state.failure) fail("failed state requires failure metadata");
    if (state.block) fail("failed state cannot contain block metadata");
  } else if (state.failure) {
    fail("failure metadata is only valid in failed state");
  }

  const resumedPhase = phase === "blocked" ? state.block?.blockedFrom : phase;
  if (
    resumedPhase &&
    implementationPhases.has(resumedPhase) &&
    !planning.approvedPlanRef
  ) {
    fail(`${resumedPhase} requires approvedPlanRef`);
  }

  if (
    coding.codeReview &&
    (coding.codeReview.implementationRevision !==
      coding.implementationRevision ||
      !sameArtifactRef(
        coding.codeReview.implementationRef,
        coding.implementationRef,
      ) ||
      !coding.codeReviewAttemptRef)
  )
    fail(
      "Code Review binding must match the current implementation and local attempt",
    );

  if (
    resumedPhase === "awaiting-plan-review" &&
    (!planning.currentPlanRef ||
      !planning.simplicityReviewRef ||
      !planning.cycleId ||
      planning.candidateCycleId !== planning.cycleId ||
      sameArtifactRef(
        planning.refinementReviewRef,
        planning.simplicityReviewRef,
      ))
  ) {
    fail(
      "awaiting-plan-review requires a review-ready candidate and fresh simplicity evidence",
    );
  }
  if (planning.refinementReviewRef && planning.automaticRefinementsUsed !== 1)
    fail("Refinement evidence requires consumed one-shot budget");

  if (
    (phase === "validating" ||
      phase === "reviewing" ||
      phase === "fixing" ||
      phase === "awaiting-code-review") &&
    (!coding.implementationRef || !coding.executionRoutingRef)
  ) {
    fail(`${phase} requires implementation and execution-routing evidence`);
  }

  if (phase === "reviewing" && !coding.validationRef) {
    fail("reviewing requires validation evidence");
  }

  if (phase === "fixing" && !coding.roundDecisionRef) {
    fail("fixing requires round-decision evidence");
  }

  if (phase === "awaiting-code-review") {
    if (!coding.validationRef || !coding.roundDecisionRef) {
      fail(
        "awaiting-code-review requires validation and round-decision evidence",
      );
    }
  }

  if (phase === "completed") {
    if (
      !planning.approvedPlanRef ||
      !coding.implementationRef ||
      !coding.validationRef ||
      !coding.roundDecisionRef ||
      !coding.latestCodeReviewRef
    ) {
      fail("completed requires all implementation and code-approval evidence");
    }
  }

  if (
    state.counters.strongerRetriesUsed > state.counters.automatedFixRoundsUsed
  ) {
    fail("strongerRetriesUsed cannot exceed automatedFixRoundsUsed");
  }

  if (
    state.block &&
    !isArtifactRef(state.block.evidenceRef) &&
    state.block.evidenceRef !== undefined
  ) {
    fail("block evidenceRef must be an artifact reference");
  }
}
