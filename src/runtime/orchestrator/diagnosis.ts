import { agentLaunchPolicy } from "../../core/agent-launch.ts";
import {
  parseDiagnosisReport,
  type DiagnosisReport,
} from "../../core/planning/diagnosis.ts";
import { isRecord, hasOnlyKeys } from "../../core/schema.ts";
import { sameArtifactRef } from "../../core/workflow/invariants.ts";
import type { WorkflowState } from "../../core/workflow/state.ts";
import {
  ArtifactImmutableError,
  createArtifactRef,
} from "../persistence/artifact-store.ts";
import { RuntimePortError } from "../ports/errors.ts";
import type {
  AgentRunRequest,
  SubagentExecutor,
} from "../ports/subagent-executor.ts";
import { authoritativeText } from "./coding-evidence.ts";
import {
  advanceWorkflow,
  type WorkflowStateWriter,
} from "./advance-workflow.ts";
import {
  runPlanningAgent,
  planningAgentInputHash,
} from "./planning-agent-run.ts";
import type { WorkflowArtifactWriter } from "./planning-orchestrator.ts";

interface Dependencies {
  artifactStore: WorkflowArtifactWriter;
  stateStore: WorkflowStateWriter;
  subagentExecutor?: SubagentExecutor;
}
export function requiresDiagnosis(state: WorkflowState): boolean {
  return state.playbook === "bugfix" || state.playbook === "hotfix";
}
export function diagnosisRequest(state: WorkflowState): AgentRunRequest {
  if (!state.planning.context.scoutRef || !state.projectRoot)
    throw new RuntimePortError(
      "policy",
      "Diagnosis requires Scout and project identity",
    );
  return {
    agent: "workflow-scout",
    launchPolicy: agentLaunchPolicy("workflow-scout"),
    cwd: state.projectRoot,
    inputRefs: [state.taskRef, state.planning.context.scoutRef],
    task: `Diagnose the ${state.playbook} task read-only. Do not mutate files or State, make Human scope/architecture choices, or implement. Inspect existing code/tests/logs for reproduction and competing root causes. You cannot execute commands: mark reproduction unavailable with a reason unless supplied/recorded evidence proves it. Cite workspace paths/line ranges and distinguish observed evidence from hypotheses. If a hotfix needs architecture or scope redesign, report scope-exceeded; uncertain boundaries are unknown. Return ONLY a JSON object (no Markdown fences) with this shape: ${JSON.stringify({ observedSymptom: "observed symptom", expectedBehavior: null, reproduction: { status: "unavailable", steps: [], evidence: "why reproduction is unavailable, or observed failure evidence" }, workspaceEvidence: ["path:lines and observation"], rootCause: { status: "suspected", explanation: "hypothesis and alternatives", evidenceStrength: "limited", supportingEvidence: [], contradictingEvidence: [] }, unresolvedFactualGaps: [], externalDependencySignals: [], affectedScope: ["affected surface"], hotfix: { scope: "unknown", reason: "bounded fix vs redesign assessment", riskNotes: [] } })}. Allowed reproduction statuses: reproduced/not-reproduced/unavailable. Root cause statuses: suspected/confirmed/unknown; strength: strong/limited/none. Confirmed requires strong supporting evidence. Hotfix scope: within-scope/scope-exceeded/unknown. Unknown expected behavior is null; empty arrays mean explicitly none.`,
  };
}

/** Validate durable output and its exact input/launch provenance before reuse or routing. */
export async function diagnosisEvidence(
  state: WorkflowState,
  deps: Dependencies,
): Promise<DiagnosisReport | undefined> {
  const ref = state.planning.context.diagnosisRef;
  if (!ref) {
    if (requiresDiagnosis(state))
      throw new RuntimePortError(
        "policy",
        "Bugfix/Hotfix require durable Diagnosis evidence",
      );
    return undefined;
  }
  try {
    const body: unknown = JSON.parse(
      await authoritativeText(deps.artifactStore, ref),
    );
    const attempt = state.planning.agentAttempts?.diagnosis;
    const request = diagnosisRequest(state);
    if (
      !isRecord(body) ||
      !hasOnlyKeys(body, [
        "schemaVersion",
        "inputRefs",
        "inputHash",
        "launchContractDigest",
        "report",
      ]) ||
      body.schemaVersion !== 1 ||
      !attempt?.launch ||
      !attempt.receipt ||
      attempt.notDispatched ||
      attempt.dispatch.ownerRunId !== state.workflowId ||
      attempt.dispatch.nodeId !== "diagnosis" ||
      attempt.receipt.requestId !== attempt.dispatch.requestId ||
      attempt.receipt.agent !== request.agent ||
      attempt.receipt.cwd !== request.cwd ||
      attempt.receipt.launchContractDigest !==
        attempt.launch.launchContractDigest ||
      body.inputHash !== attempt.inputHash ||
      body.launchContractDigest !== attempt.launch.launchContractDigest ||
      JSON.stringify(body.inputRefs) !== JSON.stringify(request.inputRefs) ||
      JSON.stringify(attempt.inputRefs) !== JSON.stringify(request.inputRefs) ||
      !deps.subagentExecutor
    )
      throw Error("Diagnosis provenance is missing or stale");
    const expectedHash = planningAgentInputHash(state, request);
    if (attempt.inputHash !== expectedHash)
      throw Error("Diagnosis input contract changed");
    await Promise.all(
      request.inputRefs!.map((inputRef) =>
        authoritativeText(deps.artifactStore, inputRef),
      ),
    );
    const current = await deps.subagentExecutor.preflight({
      ...request,
      dispatch: attempt.dispatch,
      onStarted: async () => {},
    });
    if (JSON.stringify(current) !== JSON.stringify(attempt.launch))
      throw Error("Diagnosis launch contract changed");
    return parseDiagnosisReport(body.report);
  } catch (error) {
    throw new RuntimePortError(
      "policy",
      "Diagnosis evidence is invalid, unavailable or stale; reconcile instead of rerunning",
      { cause: error },
    );
  }
}

export async function gatherDiagnosis(
  state: WorkflowState,
  deps: Dependencies & { subagentExecutor: SubagentExecutor },
): Promise<WorkflowState> {
  if (!requiresDiagnosis(state)) return state;
  if (!state.planning.context.diagnosisRef) {
    const outcome = await runPlanningAgent(
      state,
      "diagnosis",
      diagnosisRequest(state),
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
    let report: DiagnosisReport;
    try {
      report = parseDiagnosisReport(JSON.parse(outcome.result.output));
    } catch {
      return advanceWorkflow(
        state,
        { type: "BLOCK", reason: "operator-attention-required" },
        deps.stateStore,
      );
    }
    const attempt = state.planning.agentAttempts!.diagnosis;
    if (!attempt.launch || !attempt.receipt)
      return advanceWorkflow(
        state,
        { type: "BLOCK", reason: "agent-execution-ambiguous" },
        deps.stateStore,
      );
    const content = `${JSON.stringify({ schemaVersion: 1, inputRefs: attempt.inputRefs, inputHash: attempt.inputHash, launchContractDigest: attempt.launch.launchContractDigest, report }, null, 2)}\n`;
    const expected = createArtifactRef(
      "diagnosis",
      "context/diagnosis.md",
      content,
    );
    try {
      const written = await deps.artifactStore.writeText(
        "diagnosis",
        "diagnosis.md",
        content,
      );
      if (!sameArtifactRef(written, expected))
        throw Error("Diagnosis writer returned a mismatched ref");
    } catch (error) {
      if (
        !(error instanceof ArtifactImmutableError) ||
        (await authoritativeText(deps.artifactStore, expected)) !== content
      )
        throw error;
    }
    state = await advanceWorkflow(
      state,
      { type: "DIAGNOSIS_PERSISTED", diagnosisRef: expected },
      deps.stateStore,
    );
  }
  try {
    const report = await diagnosisEvidence(state, deps);
    if (state.playbook === "hotfix" && report?.hotfix.scope !== "within-scope")
      throw new RuntimePortError(
        "policy",
        "Hotfix requires Human reclassification/replanning; redesign must not silently expand scope",
      );
  } catch (error) {
    if (!(error instanceof RuntimePortError)) throw error;
    return advanceWorkflow(
      state,
      {
        type: "BLOCK",
        reason: "operator-attention-required",
        evidenceRef: state.planning.context.diagnosisRef,
      },
      deps.stateStore,
    );
  }
  return state;
}
