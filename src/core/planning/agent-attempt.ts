import { isArtifactRef, type ArtifactRef } from "../artifacts/references.ts";
import {
  isAgentLaunchEvidence,
  type AgentLaunchEvidence,
} from "../agent-launch.ts";
import {
  hasOnlyKeys,
  isNonEmptyString,
  isRecord,
  optional,
} from "../schema.ts";

export interface AgentDispatch {
  requestId: string;
  ownerRunId: string;
  nodeId: string;
  deadline: string;
}

/** Launch identity and public recovery locations, not permission to relaunch. */
export interface AgentRunReceipt {
  requestId: string;
  sessionId: string;
  runId: string;
  asyncDir: string;
  launchContractDigest: string;
  outputPath: string;
  cwd: string;
  agent: string;
}

// Stable, non-secret reason codes only; never persist provider/host error messages.
export const planningAgentDiagnosticCodes = [
  "missing_agent",
  "ambiguous_agent",
  "missing_skill",
  "denied_required_tool",
  "invalid_artifact_dir",
  "invalid_cwd",
  "unsupported_mode",
  "restricted_agent",
  "thinking_ceiling",
  "invalid_extension_bindings",
  "invalid_intercom_bridge",
  "host-model-unavailable",
  "host-capability-unavailable",
  "extension-ceiling-unverified",
  "launch-policy-rejected",
  "preflight-exception",
  "invalid-launch-policy",
  "not-dispatched",
] as const;
export type PlanningAgentDiagnosticCode =
  (typeof planningAgentDiagnosticCodes)[number];
export const isPlanningAgentDiagnosticCode = (
  value: unknown,
): value is PlanningAgentDiagnosticCode =>
  typeof value === "string" &&
  planningAgentDiagnosticCodes.some((code) => code === value);

export interface PlanningAgentAttempt {
  dispatch: AgentDispatch;
  inputRefs: readonly ArtifactRef[];
  inputHash: string;
  launch?: AgentLaunchEvidence;
  receipt?: AgentRunReceipt;
  notDispatched?: true;
  diagnosticCode?: PlanningAgentDiagnosticCode;
}

export function isAgentRunReceipt(value: unknown): value is AgentRunReceipt {
  const keys = [
    "requestId",
    "sessionId",
    "runId",
    "asyncDir",
    "launchContractDigest",
    "outputPath",
    "cwd",
    "agent",
  ];
  return (
    isRecord(value) &&
    hasOnlyKeys(value, keys) &&
    keys.every((key) => isNonEmptyString(value[key]))
  );
}

export function isPlanningAgentAttempts(
  value: unknown,
): value is Record<string, PlanningAgentAttempt> {
  return (
    isRecord(value) &&
    Object.entries(value).every(([stage, attempt]) => {
      if (
        !/^(scout|diagnosis|research|plan-v[1-9][0-9]*|simplicity-v[1-9][0-9]*|oracle-[1-2])$/u.test(
          stage,
        ) ||
        !isRecord(attempt) ||
        !hasOnlyKeys(attempt, [
          "dispatch",
          "inputRefs",
          "inputHash",
          "launch",
          "receipt",
          "notDispatched",
          "diagnosticCode",
        ])
      )
        return false;
      const dispatch = attempt.dispatch;
      return (
        isRecord(dispatch) &&
        hasOnlyKeys(dispatch, [
          "requestId",
          "ownerRunId",
          "nodeId",
          "deadline",
        ]) &&
        [
          dispatch.requestId,
          dispatch.ownerRunId,
          dispatch.nodeId,
          dispatch.deadline,
        ].every(isNonEmptyString) &&
        typeof dispatch.deadline === "string" &&
        Number.isFinite(Date.parse(dispatch.deadline)) &&
        Array.isArray(attempt.inputRefs) &&
        attempt.inputRefs.every(isArtifactRef) &&
        typeof attempt.inputHash === "string" &&
        /^[0-9a-f]{64}$/u.test(attempt.inputHash) &&
        optional(attempt, "launch", isAgentLaunchEvidence) &&
        optional(attempt, "receipt", isAgentRunReceipt) &&
        optional(attempt, "notDispatched", (candidate) => candidate === true) &&
        optional(attempt, "diagnosticCode", isPlanningAgentDiagnosticCode) &&
        (!attempt.diagnosticCode || attempt.notDispatched === true) &&
        !(attempt.receipt && attempt.notDispatched)
      );
    })
  );
}
