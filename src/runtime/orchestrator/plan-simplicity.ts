import {
  isArtifactRef,
  type ArtifactRef,
} from "../../core/artifacts/references.ts";
import { agentLaunchPolicy } from "../../core/agent-launch.ts";
import {
  parseSimplicityReport,
  isSimplicityReport,
  type SimplicityReport,
} from "../../core/planning/simplicity.ts";
import { isRecord, hasOnlyKeys, parseSchema } from "../../core/schema.ts";
import { sameArtifactRef } from "../../core/workflow/invariants.ts";
import type { WorkflowState } from "../../core/workflow/state.ts";
import { authoritativeText } from "./coding-evidence.ts";
import {
  ArtifactImmutableError,
  createArtifactRef,
} from "../persistence/artifact-store.ts";
import { advanceWorkflow } from "./advance-workflow.ts";
import {
  runPlanningAgent,
  planningAgentInputHash,
} from "./planning-agent-run.ts";
import type { PlanningOrchestratorDependencies } from "./planning-orchestrator.ts";
import type { AgentRunRequest } from "../ports/subagent-executor.ts";

export interface SimplicityArtifact extends SimplicityReport {
  workflowId: string;
  cycleId: string;
  planRef: ArtifactRef<"plan">;
  planVersion: number;
  inputRefs: readonly ArtifactRef[];
  inputHash: string;
  launchContractDigest: string;
  runId: string;
}
function isSimplicityArtifact(value: unknown): value is SimplicityArtifact {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "workflowId",
      "cycleId",
      "planRef",
      "planVersion",
      "inputRefs",
      "inputHash",
      "launchContractDigest",
      "runId",
      "findings",
    ]) ||
    ![value.workflowId, value.cycleId, value.runId].every(
      (v) => typeof v === "string" && v.length > 0,
    ) ||
    !isArtifactRef(value.planRef) ||
    value.planRef.kind !== "plan" ||
    !Number.isSafeInteger(value.planVersion) ||
    Number(value.planVersion) <= 0 ||
    !Array.isArray(value.inputRefs) ||
    !value.inputRefs.every(isArtifactRef) ||
    ![value.inputHash, value.launchContractDigest].every(
      (v) => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v),
    )
  )
    return false;
  return isSimplicityReport({
    schemaVersion: value.schemaVersion,
    findings: value.findings,
  });
}
export function parseSimplicityArtifact(value: unknown): SimplicityArtifact {
  return parseSchema(value, isSimplicityArtifact, "SimplicityArtifact");
}
export function simplicityRequest(state: WorkflowState): AgentRunRequest {
  const p = state.planning;
  if (
    !p.currentPlanRef ||
    !p.context.scoutRef ||
    !p.cycleId ||
    p.candidateCycleId !== p.cycleId
  )
    throw Error("Simplicity requires a current candidate and durable cycle");
  const candidates: (ArtifactRef | undefined)[] = [
    state.taskRef,
    p.context.scoutRef,
    p.context.diagnosisRef,
    p.context.researchRef,
    p.context.clarificationRef,
    p.domainDocumentWriteRef,
    p.stageDecisionRefs?.architecture,
    p.developmentMethodRef,
    p.currentPlanRef,
  ];
  const refs = candidates.filter(
    (ref): ref is ArtifactRef => ref !== undefined,
  );
  return {
    agent: "plan-simplicity-reviewer",
    launchPolicy: agentLaunchPolicy("plan-simplicity-reviewer"),
    cwd: state.projectRoot,
    inputRefs: refs,
    task: `Review candidate Plan version ${p.currentPlanVersion}, hash ${p.currentPlanRef.sha256}, cycle ${p.cycleId}. Evaluate strategy simplicity only against supplied durable repository evidence. Return ONLY JSON {"schemaVersion":1,"findings":[]}. Findings require id/category/summary/planSection/repositoryEvidence/alternative. Each citation is {ref,location,excerpt} with an exact supplied scout/diagnosis ref, a repository path/line location and verbatim excerpt containing that location. Categories: unnecessary-abstraction/speculative-flexibility/avoidable-dependency/ignored-pattern/broad-change-surface/duplicated-responsibility. No preference-only findings, file writes, State mutation, approval or implementation authority. Human Plan Gate remains mandatory.`,
  };
}
async function validateInputs(
  deps: PlanningOrchestratorDependencies,
  request: AgentRunRequest,
  report?: SimplicityReport,
) {
  const contents = await Promise.all(
    request.inputRefs!.map((ref) => authoritativeText(deps.artifactStore, ref)),
  );
  // Fail closed rather than silently trim away evidence or inflate child context.
  if (
    contents.some((body) => body.length > 64_000) ||
    contents.reduce((n, body) => n + body.length, 0) > 128_000
  )
    throw Error("Simplicity input evidence exceeds bounded context");
  for (const finding of report?.findings ?? []) {
    if (!contents[contents.length - 1].includes(`## ${finding.planSection}`))
      throw Error("Simplicity finding cites an absent Plan section");
    for (const citation of finding.repositoryEvidence) {
      const index = request.inputRefs!.findIndex((ref) =>
        sameArtifactRef(ref, citation.ref),
      );
      if (
        index < 0 ||
        !contents[index].includes(citation.excerpt) ||
        !citation.excerpt.includes(citation.location)
      )
        throw Error(
          "Simplicity finding lacks concrete exact-bound repository evidence",
        );
    }
  }
}
export async function simplicityEvidence(
  state: WorkflowState,
  deps: PlanningOrchestratorDependencies,
): Promise<SimplicityArtifact> {
  const ref = state.planning.simplicityReviewRef;
  if (!ref) throw Error("Fresh Plan Simplicity evidence is required");
  const body = parseSimplicityArtifact(
    JSON.parse(await authoritativeText(deps.artifactStore, ref)),
  );
  const request = simplicityRequest(state);
  const stage = `simplicity-v${state.planning.currentPlanVersion}`;
  const attempt = state.planning.agentAttempts?.[stage];
  if (
    body.workflowId !== state.workflowId ||
    body.cycleId !== state.planning.cycleId ||
    body.planVersion !== state.planning.currentPlanVersion ||
    JSON.stringify(body.planRef) !==
      JSON.stringify(state.planning.currentPlanRef) ||
    !attempt?.launch ||
    !attempt.receipt ||
    attempt.notDispatched ||
    attempt.dispatch.ownerRunId !== state.workflowId ||
    attempt.dispatch.nodeId !== stage ||
    attempt.receipt.requestId !== attempt.dispatch.requestId ||
    attempt.receipt.agent !== request.agent ||
    attempt.receipt.cwd !== request.cwd ||
    body.runId !== attempt.receipt.runId ||
    body.inputHash !== attempt.inputHash ||
    body.inputHash !== planningAgentInputHash(state, request) ||
    body.launchContractDigest !== attempt.launch.launchContractDigest ||
    body.launchContractDigest !== attempt.receipt.launchContractDigest ||
    JSON.stringify(body.inputRefs) !== JSON.stringify(request.inputRefs) ||
    JSON.stringify(attempt.inputRefs) !== JSON.stringify(request.inputRefs)
  )
    throw Error(
      "Simplicity evidence is missing, invalid or stale; never rerun blindly",
    );
  const report = parseSimplicityReport({
    schemaVersion: body.schemaVersion,
    findings: body.findings,
  });
  await validateInputs(deps, request, report);
  const current = await deps.subagentExecutor.preflight({
    ...request,
    dispatch: attempt.dispatch,
    onStarted: async () => {},
  });
  if (JSON.stringify(current) !== JSON.stringify(attempt.launch))
    throw Error("Simplicity launch contract changed");
  return body;
}
export async function reviewCandidate(
  state: WorkflowState,
  deps: PlanningOrchestratorDependencies,
): Promise<WorkflowState> {
  if (state.planning.simplicityReviewRef) {
    await simplicityEvidence(state, deps);
    return state;
  }
  const request = simplicityRequest(state);
  await validateInputs(deps, request);
  const outcome = await runPlanningAgent(
    state,
    `simplicity-v${state.planning.currentPlanVersion}`,
    request,
    deps,
  );
  state = outcome.state;
  if (outcome.result.status !== "succeeded")
    return advanceWorkflow(
      state,
      {
        type: "BLOCK",
        reason:
          outcome.result.status === "ambiguous"
            ? "agent-execution-ambiguous"
            : "agent-infrastructure-unavailable",
      },
      deps.stateStore,
    );
  let report: SimplicityReport;
  try {
    if (outcome.result.output.length > 64_000)
      throw Error("Simplicity output exceeds bound");
    report = parseSimplicityReport(JSON.parse(outcome.result.output));
    await validateInputs(deps, request, report);
  } catch {
    return advanceWorkflow(
      state,
      { type: "BLOCK", reason: "operator-attention-required" },
      deps.stateStore,
    );
  }
  const attempt =
    state.planning.agentAttempts![
      `simplicity-v${state.planning.currentPlanVersion}`
    ];
  if (!attempt.launch || !attempt.receipt)
    return advanceWorkflow(
      state,
      { type: "BLOCK", reason: "agent-execution-ambiguous" },
      deps.stateStore,
    );
  const artifact: SimplicityArtifact = {
    ...report,
    workflowId: state.workflowId,
    cycleId: state.planning.cycleId!,
    planRef: state.planning.currentPlanRef!,
    planVersion: state.planning.currentPlanVersion,
    inputRefs: attempt.inputRefs,
    inputHash: attempt.inputHash,
    launchContractDigest: attempt.launch.launchContractDigest,
    runId: attempt.receipt.runId,
  };
  const name = `simplicity-v${artifact.planVersion}.json`;
  const content = JSON.stringify(artifact);
  const ref = createArtifactRef(
    "plan-simplicity-review",
    `plan-reviews/${name}`,
    content,
  );
  try {
    const store = deps.artifactStore;
    const written = store.writeJson
      ? await store.writeJson(
          "plan-simplicity-review",
          name,
          artifact,
          parseSimplicityArtifact,
        )
      : await store.writeText("plan-simplicity-review", name, content);
    if (!sameArtifactRef(written, ref))
      throw Error("Simplicity writer returned a mismatched ref");
  } catch (error) {
    if (
      !(error instanceof ArtifactImmutableError) ||
      (await authoritativeText(deps.artifactStore, ref)) !== content
    )
      throw error;
  }
  state = await advanceWorkflow(
    state,
    { type: "PLAN_SIMPLICITY_REVIEWED", reviewRef: ref },
    deps.stateStore,
  );
  await simplicityEvidence(state, deps);
  return state;
}

export function simplicityPresentation(
  review: SimplicityArtifact,
  refinements: number,
): string {
  return `\n\n## Plan Simplicity Review (evidence only)\n\nPlan v${review.planVersion} / SHA-256 ${review.planRef.sha256}. Automatic refinements used: ${refinements}/1. Human approval is required.\n\n${review.findings.length === 0 ? "No unresolved evidence-backed findings." : `Unresolved findings (not approval or Fix authority):\n\n\`\`\`json\n${JSON.stringify(review.findings, null, 2)}\n\`\`\``}\n`;
}
