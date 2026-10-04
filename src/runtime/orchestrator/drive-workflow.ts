import { runOracleAdvice } from "./oracle-advisory.ts";
import { assertStateInvariants } from "../../core/workflow/invariants.ts";
import type { WorkflowState } from "../../core/workflow/state.ts";
import { parseValidationResult } from "../../core/decisions/types.ts";
import { advanceWorkflow } from "./advance-workflow.ts";
import {
  PlanningOrchestrator,
  StalePlanReviewError,
} from "./planning-orchestrator.ts";
import { PlanningAgentPendingError } from "./planning-agent-run.ts";
import {
  CodingOrchestrator,
  CodeReviewOpenAttemptError,
  CodeReviewSourceError,
  CodeReviewAuthorityError,
  StaleCodeReviewError,
} from "./coding-orchestrator.ts";
import { ValidationRunner } from "./validation-runner.ts";
import { ReviewRunner } from "./review-runner.ts";
import { FindingEvaluationRunner } from "./finding-evaluation.ts";
import { RoundDecisionRunner } from "./round-decision.ts";
import type {
  ReconciliationResult,
  ResumeReconcilerDependencies,
} from "./reconciler.ts";
import type { ResumeStateStore } from "./resume-workflow.ts";

export type WorkflowDriverDependencies = ResumeReconcilerDependencies & {
  loadState: () => Promise<WorkflowState>;
  stateStore: ResumeStateStore;
  /** Stops continuation, never attests that an in-flight child was cancelled. */
  signal?: AbortSignal;
};

function result(state: WorkflowState, pending = false): ReconciliationResult {
  return {
    state,
    phase: state.phase,
    status:
      state.phase === "blocked" || state.phase === "failed"
        ? state.phase
        : pending
          ? "pending"
          : "advanced",
    reason: state.block?.reason ?? state.failure?.reason,
  };
}

/** Normal actions only. Recovery/orphan discovery belongs to WorkflowReconciler. */
async function advance(
  state: WorkflowState,
  deps: WorkflowDriverDependencies,
): Promise<ReconciliationResult> {
  if (
    state.oracle?.pendingRef &&
    !["completed", "failed"].includes(state.phase)
  ) {
    const next = await runOracleAdvice(state, deps);
    return result(next);
  }
  const planning = new PlanningOrchestrator({
    ...deps,
    plannotatorGate: undefined,
  });
  const cwd = deps.cwd ?? deps.repositoryCwd;
  const block = async (reason: NonNullable<WorkflowState["block"]>["reason"]) =>
    result(
      await advanceWorkflow(state, { type: "BLOCK", reason }, deps.stateStore),
    );
  const coding = () => {
    if (!deps.configuration || !deps.jevDecisionClient)
      throw Error("Coding requires configuration and JevDecisionClient");
    return new CodingOrchestrator({
      ...deps,
      configuration: deps.configuration,
      jevDecisionClient: deps.jevDecisionClient,
    });
  };
  switch (state.phase) {
    case "blocked":
    case "failed":
    case "completed":
      return result(state);
    case "gathering-context": {
      const next = await planning.gatherContext({ state, cwd });
      return result(next.state, next.state.phase === state.phase);
    }
    case "clarifying": {
      if (!deps.clarificationPort) return result(state, true);
      const next = await planning.requestClarification({
        state,
        prompt: deps.clarificationPrompt,
      });
      return result(
        next.state,
        next.status === "declined" || next.status === "pending",
      );
    }
    case "planning":
      return result((await planning.createPlan({ state, cwd })).state);
    case "awaiting-plan-review": {
      if (!deps.plannotatorGate) return block("human-gate-unavailable");
      try {
        const next = await new PlanningOrchestrator(deps).openPlanReview({
          state,
        });
        return result(next.state, next.state.phase === state.phase);
      } catch (error) {
        if (error instanceof StalePlanReviewError)
          return block("operator-attention-required");
        throw error;
      }
    }
    case "implementing":
    case "fixing":
      if (!deps.configuration || !deps.jevDecisionClient)
        return block("operator-attention-required");
      return result(
        (
          await coding().execute({
            state,
            cwd,
            changeScope: deps.changeScope,
            reconcileStaleRouting: true,
          })
        ).state,
      );
    case "validating": {
      if (!deps.validationExecutor)
        return block("validation-infrastructure-error");
      if (!state.coding.validationRef) {
        const next = await new ValidationRunner({
          ...deps,
          validationExecutor: deps.validationExecutor,
        }).execute({ state });
        return result(next.state);
      }
      break;
    }
    case "reviewing":
      if (!state.coding.correctnessReviewRef || !state.coding.ponytailReviewRef)
        return result(
          (await new ReviewRunner(deps).execute({ state, cwd })).state,
        );
      if (!deps.configuration || !deps.jevDecisionClient)
        return block("operator-attention-required");
      if (
        !state.coding.findingEvaluationRef ||
        !state.coding.acceptedFindingsRef
      )
        return result(
          (
            await new FindingEvaluationRunner({
              ...deps,
              configuration: deps.configuration,
              jevDecisionClient: deps.jevDecisionClient,
            }).execute({ state })
          ).state,
        );
      break;
    case "awaiting-code-review": {
      if (!deps.plannotatorGate) return block("human-gate-unavailable");
      if (!deps.configuration || !deps.jevDecisionClient)
        return block("operator-attention-required");
      try {
        const next = await coding().openCodeReview({ state });
        return result(next.state, next.state.phase === state.phase);
      } catch (error) {
        // Code opening persisted a pending local attempt before the Human side effect.
        const current = await deps.loadState();
        if (
          error instanceof CodeReviewOpenAttemptError ||
          error instanceof CodeReviewSourceError
        )
          return result(
            await advanceWorkflow(
              current,
              { type: "BLOCK", reason: "operator-attention-required" },
              deps.stateStore,
            ),
          );
        if (
          error instanceof CodeReviewAuthorityError ||
          error instanceof StaleCodeReviewError
        )
          return result(
            await advanceWorkflow(
              current,
              {
                type: "FAIL",
                reason:
                  error instanceof CodeReviewAuthorityError
                    ? "authoritative-artifact-corrupt"
                    : "authority-inconsistent",
                evidenceRef:
                  current.coding.codeReviewAttemptRef ??
                  current.coding.implementationRef,
              },
              deps.stateStore,
            ),
          );
        throw error;
      }
    }
  }
  if (!deps.configuration || !deps.jevDecisionClient)
    return block("operator-attention-required");
  const validationRef = state.coding.validationRef;
  if (!validationRef || !deps.artifactStore.readText)
    throw Error("Round Decision requires durable validation evidence");
  const validation = parseValidationResult(
    JSON.parse(await deps.artifactStore.readText(validationRef)),
  );
  return result(
    (
      await new RoundDecisionRunner({
        ...deps,
        configuration: deps.configuration,
        jevDecisionClient: deps.jevDecisionClient,
      }).execute({ state, validation, validationRef })
    ).state,
  );
}

/** Drive persisted authority until a genuine wait, block, failure or completion. */
export async function driveWorkflow(
  workflowId: string,
  deps: WorkflowDriverDependencies,
): Promise<ReconciliationResult> {
  // Each iteration is deliberately sequential: the previous save is the next action's authority.
  // oxlint-disable eslint/no-await-in-loop
  while (true) {
    const execute = async (): Promise<ReconciliationResult | WorkflowState> => {
      const state = await deps.loadState();
      if (state.workflowId !== workflowId)
        throw Error("Workflow driver identity mismatch");
      assertStateInvariants(state);
      if (
        deps.signal?.aborted &&
        !["completed", "failed", "blocked"].includes(state.phase)
      )
        return {
          ...result(state, true),
          reason:
            "Continuation stopped; in-flight work may require reconciliation",
        };
      // Planning children use durable CAS dispatch intents, without a lock across their wait.
      if (
        state.oracle?.pendingRef ||
        state.phase === "gathering-context" ||
        state.phase === "planning"
      )
        return state;
      return advance(
        state,
        deps.stateStore.withLock
          ? {
              ...deps,
              stateStore: {
                saveState: (next, revision) =>
                  deps.stateStore.saveState(next, revision, { lockHeld: true }),
              },
            }
          : deps,
      );
    };
    let next: ReconciliationResult;
    try {
      const selected = deps.stateStore.withLock
        ? await deps.stateStore.withLock(execute)
        : await execute();
      next = "state" in selected ? selected : await advance(selected, deps);
    } catch (error) {
      if (error instanceof PlanningAgentPendingError)
        return result(error.state, true);
      // Runners persist a block/failure before throwing; never retry an ambiguous side effect.
      const current = await deps.loadState();
      if (current.workflowId !== workflowId) throw error;
      if (current.phase === "blocked" || current.phase === "failed")
        return result(current);
      throw error;
    }
    if (next.status !== "advanced" || next.state.phase === "completed")
      return next;
  }
  // oxlint-enable eslint/no-await-in-loop
}
