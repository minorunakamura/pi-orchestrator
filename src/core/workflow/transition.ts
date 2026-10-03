import { getPlaybookStagePolicy } from "../playbooks/policy.ts";
import type { ArtifactRef } from "../artifacts/references.ts";
import { TransitionError, type TransitionErrorCode } from "./errors.ts";
import { assertStateInvariants, sameArtifactRef } from "./invariants.ts";
import {
  isWorkflowEvent,
  type WorkflowEvent,
  type WorkflowState,
} from "./state.ts";

export type TransitionResult =
  | { ok: true; state: WorkflowState }
  | { ok: false; error: TransitionError };

function fail(
  message: string,
  code: TransitionErrorCode = "invalid-transition",
): never {
  throw new TransitionError(message, code);
}

function cloneState(state: WorkflowState): WorkflowState {
  return structuredClone(state);
}

function requireCurrentPlan(state: WorkflowState): ArtifactRef<"plan"> {
  if (!state.planning.currentPlanRef) {
    fail("The workflow has no current plan", "invariant-violation");
  }
  return state.planning.currentPlanRef;
}

function requireApprovedPlan(state: WorkflowState): ArtifactRef<"plan"> {
  if (!state.planning.approvedPlanRef) {
    fail("The workflow has no approved plan", "invariant-violation");
  }
  return state.planning.approvedPlanRef;
}

function requireImplementation(state: WorkflowState): void {
  if (!state.coding.implementationRef) {
    fail("The workflow has no implementation result", "invariant-violation");
  }
}

function requireExecutionRouting(state: WorkflowState): void {
  if (!state.coding.executionRoutingRef) {
    fail(
      "The workflow has no execution routing decision",
      "invariant-violation",
    );
  }
}

function isRoundDecisionRef(
  ref: ArtifactRef | undefined,
): ref is ArtifactRef<"round-decision"> {
  return ref?.kind === "round-decision";
}

function setRoundDecision(
  state: WorkflowState,
  decisionRef: ArtifactRef<"round-decision">,
  findingsRef?: ArtifactRef<"accepted-findings">,
): void {
  state.coding.roundDecisionRef = decisionRef;
  if (findingsRef) state.coding.acceptedFindingsRef = findingsRef;
  else delete state.coding.acceptedFindingsRef;
}

function beginFix(
  state: WorkflowState,
  decisionRef: ArtifactRef<"round-decision">,
  findingsRef: ArtifactRef<"accepted-findings"> | undefined,
  stronger: boolean,
): void {
  setRoundDecision(state, decisionRef, findingsRef);
  state.counters.automatedFixRoundsUsed += 1;
  if (stronger) state.counters.strongerRetriesUsed += 1;
  state.phase = "fixing";
}

function invalidatePlan(state: WorkflowState): void {
  delete state.planning.approvedPlanRef;
  delete state.planning.approvedPlanVersion;
  delete state.coding.executionRoutingRef;
}

function invalidateArchitecture(state: WorkflowState): void {
  if (state.planning.stageDecisionRefs) {
    delete state.planning.stageDecisionRefs.architecture;
    delete state.planning.architectureRequired;
  }
}

function clearCurrentRoundEvidence(state: WorkflowState): void {
  delete state.coding.validationRef;
  delete state.coding.correctnessReviewRef;
  delete state.coding.ponytailReviewRef;
  delete state.coding.findingEvaluationRef;
  delete state.coding.acceptedFindingsRef;
  delete state.coding.roundDecisionRef;
  delete state.coding.latestCodeReviewRef;
  delete state.coding.codeReview;
}

function requireContextDecisions(state: WorkflowState): void {
  if (!state.planning.stageDecisionRefs) return; // Legacy State is diagnosed by runtime, not upgraded here.
  const { context, stageDecisionRefs, clarificationModeRef } = state.planning;
  if (
    !context.scoutRef ||
    !stageDecisionRefs.research ||
    !stageDecisionRefs.clarification ||
    !clarificationModeRef ||
    (state.planning.researchRequired && !context.researchRef) ||
    (["bugfix", "hotfix"].includes(state.playbook) && !context.diagnosisRef)
  )
    fail("Sequential planning requires durable context and decisions");
}

function setContextRefs(
  state: WorkflowState,
  event: Extract<
    WorkflowEvent,
    {
      type:
        | "CONTEXT_EVIDENCE_PERSISTED"
        | "CONTEXT_READY"
        | "CLARIFICATION_REQUIRED";
    }
  >,
): void {
  if (event.scoutRef) state.planning.context.scoutRef = event.scoutRef;
  if (event.researchRef) state.planning.context.researchRef = event.researchRef;
}

function applyTransition(
  state: WorkflowState,
  event: WorkflowEvent,
): WorkflowState {
  const next = cloneState(state);

  switch (event.type) {
    case "DIAGNOSIS_PERSISTED":
      if (
        state.phase !== "gathering-context" ||
        !["bugfix", "hotfix"].includes(state.playbook) ||
        !state.planning.context.scoutRef ||
        Object.keys(state.planning.stageDecisionRefs ?? {}).length > 0 ||
        (state.planning.context.diagnosisRef &&
          !sameArtifactRef(
            state.planning.context.diagnosisRef,
            event.diagnosisRef,
          ))
      )
        fail(
          "Diagnosis requires Scout, bugfix/hotfix and no later routing; evidence cannot be replaced",
        );
      next.planning.context.diagnosisRef = event.diagnosisRef;
      return next;

    case "STAGE_RESOLVED": {
      if (
        state.phase !==
          (event.stage === "architecture" ? "planning" : "gathering-context") ||
        !state.planning.context.scoutRef ||
        !next.planning.stageDecisionRefs
      )
        fail(
          "STAGE_RESOLVED requires the sequential planning phase and Scout evidence",
        );
      if (
        next.planning.stageDecisionRefs[event.stage] &&
        !sameArtifactRef(
          next.planning.stageDecisionRefs[event.stage],
          event.decisionRef,
        )
      )
        fail(
          "A stage decision cannot be replaced without explicit invalidation",
        );
      const policy = getPlaybookStagePolicy(state.playbook)[event.stage];
      if (
        (policy === "required" && !event.required) ||
        (policy === "skip" && event.required)
      )
        fail("A classifier cannot override deterministic stage policy");
      next.planning.stageDecisionRefs[event.stage] = event.decisionRef;
      next.planning[`${event.stage}Required`] = event.required;
      return next;
    }

    case "CLARIFICATION_MODE_RESOLVED":
      if (
        state.phase !== "gathering-context" ||
        !state.planning.stageDecisionRefs?.clarification
      )
        fail("Clarification mode requires its persisted stage decision");
      next.planning.clarificationModeRef = event.decisionRef;
      return next;

    case "CONTEXT_EVIDENCE_PERSISTED":
      if (state.phase !== "gathering-context") {
        fail(
          "CONTEXT_EVIDENCE_PERSISTED is only valid while gathering context",
        );
      }
      setContextRefs(next, event);
      return next;

    case "CONTEXT_READY":
      if (state.phase !== "gathering-context")
        fail("CONTEXT_READY is only valid while gathering context");
      setContextRefs(next, event);
      requireContextDecisions(next);
      if (
        next.planning.stageDecisionRefs &&
        next.planning.clarificationRequired !== false
      )
        fail("CONTEXT_READY requires an explicit clarification SKIP");
      next.phase = "planning";
      return next;

    case "CLARIFICATION_REQUIRED":
      if (
        state.phase !== "gathering-context" &&
        state.phase !== "validating" &&
        state.phase !== "reviewing"
      ) {
        fail("CLARIFICATION_REQUIRED is not valid in the current phase");
      }
      setContextRefs(next, event);
      if (state.phase === "gathering-context") {
        requireContextDecisions(next);
        if (
          next.planning.stageDecisionRefs &&
          next.planning.clarificationRequired !== true
        )
          fail("Clarification interaction requires a RUN decision");
      }
      if (isRoundDecisionRef(event.reasonRef)) {
        next.coding.roundDecisionRef = event.reasonRef;
      }
      delete next.planning.clarificationRequestRef;
      delete next.planning.clarificationProgressRef;
      delete next.planning.domainDocumentWriteRef;
      next.phase = "clarifying";
      return next;

    case "CLARIFICATION_COMPLETE":
      if (state.phase !== "clarifying")
        fail("CLARIFICATION_COMPLETE is only valid while clarifying");
      next.planning.context.clarificationRef = event.clarificationRef;
      invalidateArchitecture(next);
      next.phase = "planning";
      return next;

    case "PLAN_CREATED": {
      if (state.phase !== "planning")
        fail("PLAN_CREATED is only valid while planning");
      requireContextDecisions(state);
      if (
        state.planning.stageDecisionRefs &&
        (!state.planning.stageDecisionRefs.architecture ||
          (state.planning.clarificationRequired &&
            !state.planning.context.clarificationRef))
      )
        fail(
          "PLAN_CREATED requires Architecture routing and any confirmed Human answer",
        );
      if (event.version <= state.planning.currentPlanVersion) {
        fail("PLAN_CREATED must advance the plan version");
      }
      if (event.version !== state.planning.currentPlanVersion + 1) {
        fail("PLAN_CREATED must use the next plan version");
      }
      next.planning.currentPlanRef = event.planRef;
      next.planning.currentPlanVersion = event.version;
      delete next.planning.latestPlanReviewRef;
      delete next.planning.planReview;
      invalidatePlan(next);
      next.phase = "awaiting-plan-review";
      return next;
    }

    case "PLAN_FEEDBACK":
      if (state.phase !== "awaiting-plan-review")
        fail("PLAN_FEEDBACK is only valid while awaiting plan review");
      next.planning.latestPlanReviewRef = event.feedbackRef;
      invalidateArchitecture(next);
      next.phase = "planning";
      return next;

    case "PLAN_APPROVED": {
      if (state.phase !== "awaiting-plan-review")
        fail("PLAN_APPROVED is only valid while awaiting plan review");
      const currentPlan = requireCurrentPlan(state);
      if (
        event.version !== state.planning.currentPlanVersion ||
        !sameArtifactRef(event.planRef, currentPlan)
      ) {
        fail("PLAN_APPROVED must match the current plan and version");
      }
      next.planning.approvedPlanRef = event.planRef;
      next.planning.approvedPlanVersion = event.version;
      next.planning.latestPlanReviewRef = event.reviewRef;
      next.phase = "implementing";
      return next;
    }

    case "REPLAN_REQUIRED":
      if (state.phase !== "validating" && state.phase !== "reviewing") {
        fail("REPLAN_REQUIRED is only valid while validating or reviewing");
      }
      next.coding.roundDecisionRef = event.decisionRef;
      delete next.planning.latestPlanReviewRef;
      invalidatePlan(next);
      invalidateArchitecture(next);
      next.phase = "planning";
      return next;

    case "EXECUTION_ROUTED":
      if (state.phase !== "implementing" && state.phase !== "fixing")
        fail("EXECUTION_ROUTED is only valid while implementing or fixing");
      requireApprovedPlan(state);
      next.coding.executionRoutingRef = event.decisionRef;
      return next;

    case "IMPLEMENTATION_COMPLETE":
      if (state.phase !== "implementing" && state.phase !== "fixing") {
        fail(
          "IMPLEMENTATION_COMPLETE is only valid while implementing or fixing",
        );
      }
      requireApprovedPlan(state);
      requireExecutionRouting(state);
      next.coding.implementationRef = event.resultRef;
      next.coding.implementationRevision += 1;
      if (state.coding.roundDecisionRef)
        next.coding.previousRoundDecisionRef = state.coding.roundDecisionRef;
      clearCurrentRoundEvidence(next);
      next.phase = "validating";
      return next;

    case "VALIDATION_PASSED":
      if (state.phase !== "validating")
        fail("VALIDATION_PASSED is only valid while validating");
      requireImplementation(state);
      next.coding.validationRef = event.resultRef;
      next.coding.reviewRound += 1;
      next.phase = "reviewing";
      return next;

    case "REVIEW_ARTIFACTS_PERSISTED":
      if (state.phase !== "reviewing") {
        fail("REVIEW_ARTIFACTS_PERSISTED is only valid while reviewing");
      }
      requireImplementation(state);
      if (!state.coding.validationRef) {
        fail(
          "REVIEW_ARTIFACTS_PERSISTED requires validation evidence",
          "invariant-violation",
        );
      }
      next.coding.correctnessReviewRef = event.correctnessReviewRef;
      next.coding.ponytailReviewRef = event.ponytailReviewRef;
      return next;

    case "FINDING_EVALUATION_PERSISTED":
      if (state.phase !== "reviewing") {
        fail("FINDING_EVALUATION_PERSISTED is only valid while reviewing");
      }
      requireImplementation(state);
      if (!state.coding.validationRef) {
        fail(
          "FINDING_EVALUATION_PERSISTED requires validation evidence",
          "invariant-violation",
        );
      }
      next.coding.findingEvaluationRef = event.findingEvaluationRef;
      next.coding.acceptedFindingsRef = event.acceptedFindingsRef;
      return next;

    case "RETRY_REQUIRED":
      if (state.phase !== "validating")
        fail("RETRY_REQUIRED is only valid while validating");
      requireImplementation(state);
      beginFix(next, event.decisionRef, event.findingsRef, false);
      if (event.validationRef) next.coding.validationRef = event.validationRef;
      return next;

    case "REVIEW_RETRY_REQUIRED":
      if (state.phase !== "reviewing")
        fail("REVIEW_RETRY_REQUIRED is only valid while reviewing");
      requireImplementation(state);
      beginFix(next, event.decisionRef, event.findingsRef, false);
      return next;

    case "STRONGER_RETRY_REQUIRED":
      if (state.phase !== "validating" && state.phase !== "reviewing") {
        fail(
          "STRONGER_RETRY_REQUIRED is only valid while validating or reviewing",
        );
      }
      requireImplementation(state);
      if (event.executionRoutingRef) {
        next.coding.executionRoutingRef = event.executionRoutingRef;
      }
      beginFix(next, event.decisionRef, event.findingsRef, true);
      return next;

    case "REVIEW_COMPLETE":
      if (state.phase !== "reviewing")
        fail("REVIEW_COMPLETE is only valid while reviewing");
      requireImplementation(state);
      if (!state.coding.validationRef) {
        fail(
          "REVIEW_COMPLETE requires validation evidence",
          "invariant-violation",
        );
      }
      // acceptedFindingsRef is an artifact identity, not its semantic blocking status.
      // Round policy must decide whether COMPLETE is allowed before this event.
      next.coding.roundDecisionRef = event.decisionRef;
      next.phase = "awaiting-code-review";
      return next;

    case "CODE_FEEDBACK":
      if (state.phase !== "awaiting-code-review")
        fail("CODE_FEEDBACK is only valid while awaiting code review");
      requireImplementation(state);
      next.coding.latestCodeReviewRef = event.feedbackRef;
      next.counters.humanCodeFeedbackRounds += 1;
      next.phase = "fixing";
      return next;

    case "CODE_APPROVED":
      if (state.phase !== "awaiting-code-review")
        fail("CODE_APPROVED is only valid while awaiting code review");
      requireImplementation(state);
      next.coding.latestCodeReviewRef = event.reviewRef;
      next.phase = "completed";
      return next;

    case "BLOCK":
      if (
        state.phase === "blocked" ||
        state.phase === "completed" ||
        state.phase === "failed"
      ) {
        fail("BLOCK is only valid from a recoverable active phase");
      }
      next.block = {
        blockedFrom: state.phase,
        reason: event.reason,
        ...(event.evidenceRef ? { evidenceRef: event.evidenceRef } : {}),
      };
      next.phase = "blocked";
      return next;

    case "BLOCK_RESOLVED":
      if (state.phase !== "blocked" || !state.block) {
        fail("BLOCK_RESOLVED requires blocked state");
      }
      next.phase = state.block.blockedFrom;
      delete next.block;
      return next;

    case "FAIL":
      if (
        state.phase === "blocked" ||
        state.phase === "completed" ||
        state.phase === "failed"
      ) {
        fail("FAIL is only valid from an active phase");
      }
      next.failure = {
        reason: event.reason,
        ...(event.evidenceRef ? { evidenceRef: event.evidenceRef } : {}),
      };
      delete next.block;
      next.phase = "failed";
      return next;
  }

  return fail("Unsupported workflow event", "invalid-event");
}

export function transition(
  state: WorkflowState,
  event: WorkflowEvent,
): TransitionResult {
  try {
    assertStateInvariants(state);
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof TransitionError
          ? error
          : new TransitionError("Invalid workflow state", "invalid-state"),
    };
  }

  if (!isWorkflowEvent(event)) {
    return {
      ok: false,
      error: new TransitionError("Invalid workflow event", "invalid-event"),
    };
  }

  try {
    const next = applyTransition(state, event);
    assertStateInvariants(next);
    return { ok: true, state: next };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof TransitionError
          ? error
          : new TransitionError("Transition failed"),
    };
  }
}
