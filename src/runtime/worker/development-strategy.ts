import { RuntimePortError } from "../ports/errors.ts";
import type { WorkflowState } from "../../core/workflow/state.ts";
import { sameArtifactRef } from "../../core/workflow/invariants.ts";
import { parsePlanningDecisionArtifact } from "../../core/decisions/planning-routing.ts";
import { parsePlan, type ParsedPlan } from "../planning/plan-parser.ts";
import { authoritativeText } from "../orchestrator/coding-evidence.ts";
import { createWorkerRequest } from "../integrations/subagents.ts";
import type { WorkflowArtifactWriter } from "../orchestrator/planning-orchestrator.ts";
import type { WorkerAttemptEvidence } from "./attempt-evidence.ts";
import type { SubagentExecutor } from "../ports/subagent-executor.ts";

/** Historical method/seams/skills stay bound to the exact immutable Plan and launch. */
export async function validateWorkerStrategy(
  store: WorkflowArtifactWriter,
  state: WorkflowState,
  attempt: WorkerAttemptEvidence,
  executor?: SubagentExecutor,
): Promise<ParsedPlan> {
  const plan = parsePlan(
    await authoritativeText(store, attempt.approvedPlanRef),
  );
  const refs = attempt.inputRefs.filter(
    (ref) => ref.kind === "development-method",
  );
  if (refs.length !== 1)
    throw Error("Worker requires exact Development Method evidence");
  const method = parsePlanningDecisionArtifact(
    JSON.parse(await authoritativeText(store, refs[0])),
  );
  if (
    method.family !== "method" ||
    method.workflowId !== state.workflowId ||
    method.playbook !== state.playbook ||
    method.outcome !== plan.developmentMethod
  )
    throw Error("Worker method contradicts approved Plan");
  const skills =
    plan.developmentMethod === "TDD" ? ["tdd", ...plan.supportingSkills] : [];
  if (
    attempt.launch &&
    (attempt.launch.inheritSkills ||
      JSON.stringify(attempt.launch.policy.skills) !== JSON.stringify(skills) ||
      attempt.launch.skills.length !== skills.length ||
      skills.some(
        (name) => !attempt.launch!.skills.some((skill) => skill.name === name),
      ))
  )
    throw Error("Worker launch does not select exactly the approved skills");
  if (executor && attempt.launch) {
    const request = createWorkerRequest(
      {
        approvedPlanRef: attempt.approvedPlanRef,
        deviationBinding: {
          workflowId: attempt.workflowId,
          attemptId: attempt.attemptId,
          approvedPlanRef: attempt.approvedPlanRef,
          planVersion: attempt.planVersion,
          inputRevision: attempt.inputRevision,
        },
        developmentMethod: plan.developmentMethod,
        testSeams: plan.testSeams,
        skills: plan.supportingSkills,
        contextRefs: [],
        executionProfile: attempt.executionProfile,
      },
      { cwd: attempt.before.cwd },
    );
    try {
      const launch = await executor.preflight({
        ...request,
        inputRefs: attempt.inputRefs,
        dispatch: attempt.dispatch,
        onStarted: async () => {},
      });
      if (JSON.stringify(launch) !== JSON.stringify(attempt.launch))
        throw Error("Launch drift");
    } catch (cause) {
      // Valid historical evidence does not become corrupt when current capabilities change.
      throw new RuntimePortError(
        "reconciliation",
        "Historical Worker launch is stale; do not redispatch",
        { cause },
      );
    }
  }
  // Active attempts cannot recover against a different current method reference.
  if (
    sameArtifactRef(attempt.approvedPlanRef, state.planning.approvedPlanRef) &&
    !sameArtifactRef(refs[0], state.planning.developmentMethodRef)
  )
    throw Error("Worker Development Method reference changed");
  return plan;
}
