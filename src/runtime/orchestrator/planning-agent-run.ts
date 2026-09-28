import { randomUUID } from "node:crypto";
import { RuntimePortError } from "../ports/errors.ts";
import type { WorkflowState } from "../../core/workflow/state.ts";
import type { PlanningAgentAttempt } from "../../core/planning/agent-attempt.ts";
import { calculateSha256 } from "../persistence/artifact-store.ts";
import { DEFAULT_SUBAGENT_TIMEOUT_MS } from "../integrations/subagents.ts";
import {
  SubagentNotDispatchedError,
  type AgentRunRequest,
  type AgentRunResult,
  type SubagentExecutor,
} from "../ports/subagent-executor.ts";
import { subagentRunId } from "../../types.ts";
import type { WorkflowArtifactWriter } from "./planning-orchestrator.ts";
import type { WorkflowStateWriter } from "./advance-workflow.ts";

export class PlanningAgentPendingError extends Error {
  constructor(readonly state: WorkflowState) {
    super("Planning agent is still running; no replacement was dispatched");
    this.name = "PlanningAgentPendingError";
  }
}

type Outcome = { state: WorkflowState; result: AgentRunResult };

export async function runPlanningAgent(
  initial: WorkflowState,
  stage: string,
  input: AgentRunRequest,
  dependencies: {
    artifactStore: WorkflowArtifactWriter;
    stateStore: WorkflowStateWriter;
    subagentExecutor: SubagentExecutor;
  },
): Promise<Outcome> {
  let state = initial;
  const unknown = (reason: string): Outcome => ({
    state,
    result: { status: "ambiguous", reason },
  });
  if (!state.planning.agentAttempts)
    return unknown(
      "Legacy planning state has no dispatch ledger; operator reconciliation required",
    );
  const inputRefs = structuredClone(input.inputRefs ?? []);
  const inputHash = calculateSha256(
    JSON.stringify({
      agent: input.agent,
      task: input.task,
      cwd: input.cwd ?? state.projectRoot,
      inputRefs,
    }),
  );
  try {
    const store = dependencies.artifactStore;
    if (!store.readText) throw Error("Readable ArtifactStore required");
    await Promise.all(inputRefs.map((ref) => store.readText!(ref)));
  } catch {
    return unknown("Planning input evidence is unavailable or corrupt");
  }
  const previous = state.planning.agentAttempts[stage];
  if (previous && !previous.notDispatched) {
    if (
      previous.inputHash !== inputHash ||
      JSON.stringify(previous.inputRefs) !== JSON.stringify(inputRefs) ||
      previous.dispatch.ownerRunId !== state.workflowId ||
      previous.dispatch.nodeId !== stage ||
      !previous.receipt ||
      previous.receipt.requestId !== previous.dispatch.requestId ||
      previous.receipt.agent !== input.agent ||
      previous.receipt.cwd !== (input.cwd ?? state.projectRoot)
    ) {
      return unknown(
        "Planning attempt has no matching launch identity; do not redispatch",
      );
    }
    try {
      const identity = subagentRunId(previous.receipt.runId);
      const status = await dependencies.subagentExecutor.status(
        identity,
        previous.receipt,
      );
      if (status.runId !== identity)
        return unknown("Planning status identity mismatch");
      if (status.status === "running" || status.status === "queued")
        throw new PlanningAgentPendingError(state);
      if (
        status.status === "succeeded" &&
        status.result?.status === "succeeded" &&
        status.result.runId === identity
      ) {
        return { state, result: status.result };
      }
      return unknown(
        status.reason ?? "Existing planning run cannot be recovered safely",
      );
    } catch (error) {
      if (error instanceof PlanningAgentPendingError) throw error;
      return unknown("Planning run status is unavailable");
    }
  }
  const attempt: PlanningAgentAttempt = {
    dispatch: {
      requestId: randomUUID(),
      ownerRunId: state.workflowId,
      nodeId: stage,
      deadline: new Date(
        Date.now() + DEFAULT_SUBAGENT_TIMEOUT_MS,
      ).toISOString(),
    },
    inputRefs,
    inputHash,
  };
  const save = async (next: PlanningAgentAttempt) => {
    const updated = structuredClone(state);
    updated.planning.agentAttempts = {
      ...updated.planning.agentAttempts,
      [stage]: next,
    };
    state = await dependencies.stateStore.saveState(
      updated,
      state.stateRevision,
    );
  };
  // CAS is before dispatch. A stale concurrent caller cannot launch another child.
  await save(attempt);
  let result: AgentRunResult;
  try {
    result = await dependencies.subagentExecutor.run({
      ...input,
      inputRefs,
      dispatch: attempt.dispatch,
      onStarted: async (receipt) => {
        await save({ ...attempt, receipt });
      },
    });
  } catch (error) {
    if (error instanceof SubagentNotDispatchedError) {
      await save({ ...attempt, notDispatched: true });
      return {
        state,
        result: { status: "failed", notDispatched: true, error: error.message },
      };
    }
    if (error instanceof RuntimePortError && error.kind === "infrastructure") {
      return { state, result: { status: "failed", error: error.message } };
    }
    return unknown("Planning dispatch may have started; no automatic retry");
  }
  if (result.status === "failed" && result.notDispatched)
    await save({ ...attempt, notDispatched: true });
  const receipt = state.planning.agentAttempts?.[stage]?.receipt;
  if (receipt && result.runId !== receipt.runId)
    return unknown("Planning completion identity mismatch");
  return { state, result };
}
