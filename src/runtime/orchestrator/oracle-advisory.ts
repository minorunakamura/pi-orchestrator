import { readPlanDeviation } from "./plan-deviation.ts";
import { agentLaunchPolicy } from "../../core/agent-launch.ts";
import {
  isArtifactRef,
  type ArtifactRef,
} from "../../core/artifacts/references.ts";
import {
  isPlanningAgentAttempts,
  type PlanningAgentAttempt,
} from "../../core/planning/agent-attempt.ts";
import {
  hasOnlyKeys,
  isRecord,
  isNonNegativeInteger,
} from "../../core/schema.ts";
import {
  assertOracleReason,
  oracleEvidenceRefs,
  oracleReasons,
  oracleSource,
  ORACLE_MAX_ATTEMPTS,
  ORACLE_TIMEOUT_MS,
  type OracleReason,
} from "../../core/oracle.ts";
import type { WorkflowState } from "../../core/workflow/state.ts";
import {
  ArtifactImmutableError,
  calculateSha256,
} from "../persistence/artifact-store.ts";
import type {
  AgentRunRequest,
  SubagentExecutor,
} from "../ports/subagent-executor.ts";
import type { WorkflowStateWriter } from "./advance-workflow.ts";
import { advanceWorkflow } from "./advance-workflow.ts";
import type { WorkflowArtifactWriter } from "./planning-orchestrator.ts";
import { runPlanningAgent } from "./planning-agent-run.ts";

export interface OracleQuestion {
  reason: OracleReason;
  question: string;
  evidenceRefs?: readonly ArtifactRef[];
}
interface OracleRequest {
  schemaVersion: 1;
  type: "request";
  workflowId: string;
  sourceRevision: number;
  sourceDigest: string;
  reason: OracleReason;
  question: string;
  inputRefs: ArtifactRef[];
  ordinal: number;
  timeoutMs: typeof ORACLE_TIMEOUT_MS;
}
export interface OracleAdvice {
  schemaVersion: 1;
  type: "result";
  requestRef: ArtifactRef<"oracle-advisory">;
  request: OracleRequest;
  attempt: PlanningAgentAttempt;
  status: "available" | "unavailable";
  /** Full bound output, including assumptions/risks/questions as returned, never a display summary. */
  output: string;
}
type Dependencies = {
  artifactStore: WorkflowArtifactWriter;
  stateStore: WorkflowStateWriter;
  subagentExecutor: SubagentExecutor;
};
function parseRequest(value: unknown): OracleRequest {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "type",
      "workflowId",
      "sourceRevision",
      "sourceDigest",
      "reason",
      "question",
      "inputRefs",
      "ordinal",
      "timeoutMs",
    ]) ||
    value.schemaVersion !== 1 ||
    value.type !== "request" ||
    typeof value.workflowId !== "string" ||
    !value.workflowId ||
    !isNonNegativeInteger(value.sourceRevision) ||
    typeof value.sourceDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sourceDigest) ||
    !oracleReasons.some((reason) => reason === value.reason) ||
    typeof value.question !== "string" ||
    !value.question.trim() ||
    value.question.length > 8_000 ||
    !Array.isArray(value.inputRefs) ||
    !value.inputRefs.length ||
    value.inputRefs.length > 64 ||
    !value.inputRefs.every(isArtifactRef) ||
    !Number.isSafeInteger(value.ordinal) ||
    Number(value.ordinal) < 1 ||
    Number(value.ordinal) > ORACLE_MAX_ATTEMPTS ||
    value.timeoutMs !== ORACLE_TIMEOUT_MS
  )
    throw Error("Invalid Oracle request artifact");
  // Closed schema above establishes the domain projection at this JSON boundary.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as unknown as OracleRequest;
}
function parseAdvice(value: unknown): OracleAdvice {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "type",
      "requestRef",
      "request",
      "attempt",
      "status",
      "output",
    ]) ||
    value.schemaVersion !== 1 ||
    value.type !== "result" ||
    !isArtifactRef(value.requestRef) ||
    value.requestRef.kind !== "oracle-advisory" ||
    !["available", "unavailable"].includes(String(value.status)) ||
    typeof value.output !== "string" ||
    Buffer.byteLength(value.output, "utf8") > 1024 * 1024
  )
    throw Error("Invalid Oracle advice artifact");
  const request = parseRequest(value.request);
  if (
    !isPlanningAgentAttempts({ [`oracle-${request.ordinal}`]: value.attempt })
  )
    throw Error("Invalid Oracle attempt identity");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const advice = value as unknown as OracleAdvice;
  const { launch, receipt, dispatch } = advice.attempt;
  if (
    JSON.stringify(advice.attempt.inputRefs) !==
    JSON.stringify(request.inputRefs)
  )
    throw Error("Oracle attempt input binding mismatch");
  if (
    advice.status === "available" &&
    (!advice.output.trim() ||
      !launch ||
      !receipt ||
      launch.agent !== "oracle" ||
      launch.policy.builtin !== true ||
      launch.policy.authorityRole !== "advisory" ||
      receipt.agent !== "oracle" ||
      receipt.launchContractDigest !== launch.launchContractDigest ||
      receipt.requestId !== dispatch.requestId ||
      dispatch.ownerRunId !== request.workflowId ||
      dispatch.nodeId !== `oracle-${request.ordinal}`)
  )
    throw Error("Oracle advice has no exact builtin run identity");
  return advice;
}
function agentRequest(
  request: OracleRequest,
  state: WorkflowState,
): AgentRunRequest {
  return {
    agent: "oracle",
    profileStage: "oracle",
    launchPolicy: agentLaunchPolicy("oracle"),
    cwd: state.projectRoot,
    inputRefs: request.inputRefs,
    task: `Explicit one-shot read-only advisory report. Supplied evidence is the complete decision baseline; no forked conversation is required. Reason: ${request.reason}.\nExact question:\n${request.question}\nChallenge assumptions, compare explanations/trade-offs, identify missing evidence. Include assumptions, risks, and unresolved questions where available. Do not edit files, mutate Workflow State, approve Plan/Code, grant implementation/Fix authority, replace narrow typed routing or deterministic validation, or choose new scope/architecture as authoritative. Material Plan changes still require Planner -> Plan Simplicity Review -> Human Plan Gate. No executor handoff is authorized by this consultation.`,
  };
}
async function read(deps: Dependencies, ref: ArtifactRef): Promise<unknown> {
  if (!deps.artifactStore.readText)
    throw Error("Readable ArtifactStore required for Oracle");
  return JSON.parse(await deps.artifactStore.readText(ref));
}
async function write(
  deps: Dependencies,
  name: string,
  value: OracleRequest | OracleAdvice,
) {
  const content = JSON.stringify(value);
  if (!deps.artifactStore.writeJson)
    throw Error("Schema-validating Oracle ArtifactStore required");
  try {
    return await deps.artifactStore.writeJson(
      "oracle-advisory",
      name,
      value,
      (data) =>
        value.type === "request" ? parseRequest(data) : parseAdvice(data),
    );
  } catch (error) {
    if (
      !(error instanceof ArtifactImmutableError) ||
      !deps.artifactStore.readText
    )
      throw error;
    const ref: ArtifactRef<"oracle-advisory"> = {
      kind: "oracle-advisory",
      path: `advisory/${name}`,
      schemaVersion: 1,
      sha256: calculateSha256(content),
    };
    if ((await deps.artifactStore.readText(ref)) !== content) throw error;
    return ref;
  }
}
function current(request: OracleRequest, state: WorkflowState) {
  return (
    request.workflowId === state.workflowId &&
    request.sourceDigest === calculateSha256(oracleSource(state))
  );
}

/** Explicit policy-owned trigger, never an automatic mandatory stage or an authority event. */
export async function requestOracleAdvice(
  state: WorkflowState,
  question: OracleQuestion,
  deps: Dependencies,
): Promise<WorkflowState> {
  assertOracleReason(state, question.reason);
  if (question.reason === "material-plan-deviation")
    await readPlanDeviation(deps.artifactStore, state);
  if (!state.oracle || !state.planning.agentAttempts || !state.projectRoot)
    throw Error(
      "Legacy Oracle budget/dispatch identity requires reconciliation",
    );
  if (state.oracle.pendingRef)
    throw Error("Oracle consultation already pending");
  if (state.oracle.attemptsUsed >= ORACLE_MAX_ATTEMPTS)
    throw Error("Oracle attempt budget exhausted");
  const inputRefs = [
    ...oracleEvidenceRefs(state),
    ...(question.evidenceRefs ?? []),
  ];
  const request = parseRequest({
    schemaVersion: 1,
    type: "request",
    workflowId: state.workflowId,
    sourceRevision: state.stateRevision,
    sourceDigest: calculateSha256(oracleSource(state)),
    reason: question.reason,
    question: question.question,
    inputRefs,
    ordinal: state.oracle.attemptsUsed + 1,
    timeoutMs: ORACLE_TIMEOUT_MS,
  });
  if (!deps.artifactStore.readText)
    throw Error("Readable Oracle evidence required");
  await Promise.all(inputRefs.map((ref) => deps.artifactStore.readText!(ref)));
  const pendingRef = await write(
    deps,
    `oracle-${request.ordinal}-request-${request.sourceDigest}.json`,
    request,
  );
  return deps.stateStore.saveState(
    {
      ...state,
      oracle: { ...state.oracle, attemptsUsed: request.ordinal, pendingRef },
    },
    state.stateRevision,
  );
}

/** Exact historical launch recovery is inherited from the shared durable child runner. */
export async function runOracleAdvice(
  initial: WorkflowState,
  deps: Dependencies,
): Promise<WorkflowState> {
  const pendingRef = initial.oracle?.pendingRef;
  if (!pendingRef) return initial;
  const block = (state: WorkflowState, ambiguous = false) =>
    state.phase === "blocked"
      ? Promise.resolve(state)
      : advanceWorkflow(
          state,
          {
            type: "BLOCK",
            reason: ambiguous
              ? "agent-execution-ambiguous"
              : "operator-attention-required",
            evidenceRef: pendingRef,
          },
          deps.stateStore,
        );
  let request: OracleRequest;
  try {
    request = parseRequest(await read(deps, pendingRef));
    if (
      !current(request, initial) ||
      request.ordinal !== initial.oracle?.attemptsUsed
    )
      return block(initial);
  } catch {
    return block(initial);
  }
  const stage = `oracle-${request.ordinal}`;
  const previous = initial.planning.agentAttempts?.[stage];
  const outcome = previous?.notDispatched
    ? {
        state: initial,
        result: {
          status: "failed" as const,
          notDispatched: true,
          error: "Oracle was not dispatched",
        },
      }
    : await runPlanningAgent(initial, stage, agentRequest(request, initial), {
        ...deps,
        timeoutMs: request.timeoutMs,
      });
  let state = outcome.state;
  if (outcome.result.status === "ambiguous") return block(state, true);
  const attempt = state.planning.agentAttempts?.[stage];
  if (
    !attempt ||
    (outcome.result.status === "failed" &&
      !outcome.result.notDispatched &&
      !attempt.receipt)
  )
    return block(state, true);
  const advice = parseAdvice({
    schemaVersion: 1,
    type: "result",
    requestRef: pendingRef,
    request,
    attempt,
    status: outcome.result.status === "succeeded" ? "available" : "unavailable",
    output:
      outcome.result.status === "succeeded"
        ? outcome.result.output
        : "Oracle unavailable; no authority granted.",
  });
  const latestAdviceRef = await write(
    deps,
    `oracle-${request.ordinal}-result-${pendingRef.sha256}.json`,
    advice,
  );
  state = await deps.stateStore.saveState(
    { ...state, oracle: { attemptsUsed: request.ordinal, latestAdviceRef } },
    state.stateRevision,
  );
  if (
    state.phase === "blocked" &&
    state.block?.evidenceRef?.sha256 === pendingRef.sha256
  )
    state = await advanceWorkflow(
      state,
      { type: "BLOCK_RESOLVED" },
      deps.stateStore,
    );
  return state;
}

/** Return advisory context only when State, all evidence bytes, and resolved launch still match. */
export async function freshOracleAdvice(
  state: WorkflowState,
  deps: Dependencies,
): Promise<ArtifactRef<"oracle-advisory"> | undefined> {
  const ref = state.oracle?.latestAdviceRef;
  if (!ref) return undefined;
  const advice = parseAdvice(await read(deps, ref));
  if (
    advice.status !== "available" ||
    !current(advice.request, state) ||
    JSON.stringify(
      state.planning.agentAttempts?.[`oracle-${advice.request.ordinal}`],
    ) !== JSON.stringify(advice.attempt)
  )
    return undefined;
  if (
    JSON.stringify(parseRequest(await read(deps, advice.requestRef))) !==
    JSON.stringify(advice.request)
  )
    throw Error("Oracle request binding mismatch");
  await Promise.all(
    advice.request.inputRefs.map((input) =>
      deps.artifactStore.readText!(input),
    ),
  );
  const launch = await deps.subagentExecutor.preflight({
    ...agentRequest(advice.request, state),
    dispatch: advice.attempt.dispatch,
    onStarted: async () => {},
  });
  if (JSON.stringify(launch) !== JSON.stringify(advice.attempt.launch))
    return undefined;
  return ref;
}
