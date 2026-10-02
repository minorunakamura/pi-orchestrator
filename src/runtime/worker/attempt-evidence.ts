import {
  isArtifactRef,
  type ArtifactRef,
} from "../../core/artifacts/references.ts";
import {
  hasOnlyKeys,
  isRecord,
  isNonEmptyString,
  isNonNegativeInteger,
  isOneOf,
} from "../../core/schema.ts";
import {
  isAgentLaunchEvidence,
  type AgentLaunchEvidence,
} from "../../core/agent-launch.ts";
import {
  isAgentRunReceipt,
  type AgentRunReceipt,
} from "../../core/planning/agent-attempt.ts";
import type { ResolvedExecutionProfile } from "../../core/configuration.ts";
import { isSubagentRunId, type SubagentRunId } from "../../types.ts";
import type { AgentDispatch } from "../ports/subagent-executor.ts";
import type { RepositorySnapshot } from "./repository-evidence.ts";

export interface WorkerAttemptEvidence {
  schemaVersion: 1;
  recordType: "worker-attempt";
  workflowId: string;
  attemptId: string;
  previousRef?: ArtifactRef<"implementation">;
  inputRevision: number;
  targetRevision: number;
  approvedPlanRef: ArtifactRef<"plan">;
  planVersion: number;
  inputImplementationRef?: ArtifactRef<"implementation">;
  executionRoutingRef: ArtifactRef<"execution-routing">;
  inputRefs: readonly ArtifactRef[];
  executionProfile: ResolvedExecutionProfile;
  dispatch: AgentDispatch;
  launch?: AgentLaunchEvidence;
  receipt?: AgentRunReceipt;
  observedAt: string;
  status: "intent" | "succeeded" | "failed" | "timed-out" | "ambiguous";
  runId?: SubagentRunId;
  launchStatus: "unknown" | "observed" | "not-started";
  before: RepositorySnapshot;
  after?:
    | { status: "pending" }
    | { status: "observed"; snapshot: RepositorySnapshot }
    | { status: "unavailable"; reason: "observation-failed" };
  implementationRef?: ArtifactRef<"implementation">;
  resultDigest?: string;
}
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
const date = (value: unknown) =>
  isNonEmptyString(value) && Number.isFinite(Date.parse(value));
function snapshot(value: unknown): value is RepositorySnapshot {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "cwd",
      "root",
      "head",
      "indexDigest",
      "worktreeDigest",
      "untracked",
    ]) &&
    isNonEmptyString(value.cwd) &&
    isNonEmptyString(value.root) &&
    (value.head === null ||
      (typeof value.head === "string" &&
        /^[0-9a-f]{40,64}$/u.test(value.head))) &&
    digest(value.indexDigest) &&
    digest(value.worktreeDigest) &&
    Array.isArray(value.untracked) &&
    value.untracked.every(
      (entry) =>
        isRecord(entry) &&
        hasOnlyKeys(entry, ["path", "sha256", "mode", "kind"]) &&
        isNonEmptyString(entry.path) &&
        digest(entry.sha256) &&
        isNonNegativeInteger(entry.mode) &&
        isOneOf(["file", "symlink"] as const, entry.kind),
    )
  );
}
function assertWorkerAttempt(
  value: unknown,
): asserts value is WorkerAttemptEvidence {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "recordType",
      "workflowId",
      "attemptId",
      "previousRef",
      "inputRevision",
      "targetRevision",
      "approvedPlanRef",
      "planVersion",
      "inputImplementationRef",
      "executionRoutingRef",
      "inputRefs",
      "executionProfile",
      "dispatch",
      "launch",
      "receipt",
      "observedAt",
      "status",
      "runId",
      "launchStatus",
      "before",
      "after",
      "implementationRef",
      "resultDigest",
    ]) ||
    value.schemaVersion !== 1 ||
    value.recordType !== "worker-attempt" ||
    !isNonEmptyString(value.workflowId) ||
    !isNonEmptyString(value.attemptId) ||
    !isNonNegativeInteger(value.inputRevision) ||
    !isNonNegativeInteger(value.targetRevision) ||
    value.targetRevision !== value.inputRevision + 1 ||
    !isNonNegativeInteger(value.planVersion) ||
    value.planVersion < 1 ||
    !isArtifactRef(value.approvedPlanRef) ||
    value.approvedPlanRef.kind !== "plan" ||
    !isArtifactRef(value.executionRoutingRef) ||
    value.executionRoutingRef.kind !== "execution-routing" ||
    !Array.isArray(value.inputRefs) ||
    !value.inputRefs.every(isArtifactRef) ||
    !isRecord(value.executionProfile) ||
    !hasOnlyKeys(value.executionProfile, ["provider", "model", "thinking"]) ||
    ![
      value.executionProfile.provider,
      value.executionProfile.model,
      value.executionProfile.thinking,
    ].every(isNonEmptyString) ||
    !isRecord(value.dispatch) ||
    !hasOnlyKeys(value.dispatch, [
      "requestId",
      "ownerRunId",
      "nodeId",
      "deadline",
    ]) ||
    ![
      value.dispatch.requestId,
      value.dispatch.ownerRunId,
      value.dispatch.nodeId,
    ].every(isNonEmptyString) ||
    !date(value.dispatch.deadline) ||
    !date(value.observedAt) ||
    (value.launch !== undefined && !isAgentLaunchEvidence(value.launch)) ||
    (value.receipt !== undefined && !isAgentRunReceipt(value.receipt)) ||
    !snapshot(value.before) ||
    !isOneOf(
      ["intent", "succeeded", "failed", "timed-out", "ambiguous"] as const,
      value.status,
    ) ||
    !isOneOf(
      ["unknown", "observed", "not-started"] as const,
      value.launchStatus,
    ) ||
    (value.launchStatus === "not-started" && value.runId !== undefined) ||
    (value.runId !== undefined && !isSubagentRunId(value.runId)) ||
    (value.resultDigest !== undefined && !digest(value.resultDigest))
  )
    throw Error("Invalid Worker attempt evidence");
  for (const key of [
    "previousRef",
    "inputImplementationRef",
    "implementationRef",
  ] as const)
    if (
      value[key] !== undefined &&
      (!isArtifactRef(value[key]) || value[key].kind !== "implementation")
    )
      throw Error("Invalid Worker attempt reference");
  if (value.status === "intent") {
    if (
      value.after !== undefined ||
      value.runId !== undefined ||
      value.implementationRef !== undefined
    )
      throw Error("Intent cannot claim a Worker result");
  } else if (
    !isRecord(value.after) ||
    !(
      (value.after.status === "pending" &&
        hasOnlyKeys(value.after, ["status"])) ||
      (value.after.status === "observed" &&
        hasOnlyKeys(value.after, ["status", "snapshot"]) &&
        snapshot(value.after.snapshot)) ||
      (value.after.status === "unavailable" &&
        hasOnlyKeys(value.after, ["status", "reason"]) &&
        value.after.reason === "observation-failed")
    )
  )
    throw Error("Missing Worker post-run observation");
  if (
    value.status === "succeeded" &&
    (!value.runId ||
      !value.implementationRef ||
      !isRecord(value.after) ||
      value.after.status !== "observed")
  )
    throw Error("Worker success requires exact result and repository evidence");
}

export function parseWorkerAttempt(value: unknown): WorkerAttemptEvidence {
  assertWorkerAttempt(value);
  return value;
}
