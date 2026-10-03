import type { ArtifactRef } from "../core/artifacts/references.ts";
import { sameArtifactRef } from "../core/workflow/invariants.ts";
import type {
  BlockState,
  FailureState,
  WorkflowState,
} from "../core/workflow/state.ts";
import type { WorkflowPhase } from "../core/workflow/phase.ts";

export type WorkflowLifecycleStatus =
  | "active"
  | "blocked"
  | "failed"
  | "completed";

export type HumanGateStatus =
  | "not-started"
  | "pending"
  | "feedback"
  | "approved"
  | "unknown";

export interface HumanGateProjection {
  kind: "plan" | "code" | "none";
  status: HumanGateStatus;
  reviewId?: string;
  planVersion?: number;
  implementationRevision?: number;
}

export interface WorkerIdentityProjection {
  requestId?: string;
  ownerRunId?: string;
  nodeId?: string;
  runId?: string;
  launchStatus?: "unknown" | "observed" | "not-started";
}

export interface WorkerProjection {
  status: "none" | "pending" | "known";
  attemptRef?: ArtifactRef<"implementation">;
  identity?: WorkerIdentityProjection;
}

export interface WorkflowStatusRefs {
  task: ArtifactRef<"task">;
  currentPlan?: ArtifactRef<"plan">;
  approvedPlan?: ArtifactRef<"plan">;
  latestPlanReview?: ArtifactRef<"plan-review">;
  workerAttempt?: ArtifactRef<"implementation">;
  executionRouting?: ArtifactRef<"execution-routing">;
  implementation?: ArtifactRef<"implementation">;
  validation?: ArtifactRef<"validation">;
  correctnessReview?: ArtifactRef<"correctness-review">;
  ponytailReview?: ArtifactRef<"ponytail-review">;
  findingEvaluation?: ArtifactRef<"finding-evaluation">;
  acceptedFindings?: ArtifactRef<"accepted-findings">;
  roundDecision?: ArtifactRef<"round-decision">;
  latestCodeReview?: ArtifactRef<"code-review">;
  reconciliation?: ArtifactRef<"reconciliation">;
  blockedEvidence?: ArtifactRef;
  failedEvidence?: ArtifactRef;
}

export interface WorkflowStatusProjection {
  workflowId: string;
  playbook: WorkflowState["playbook"];
  phase: WorkflowPhase;
  status: WorkflowLifecycleStatus;
  currentPlanVersion: number;
  approvedPlanVersion?: number;
  implementationRevision: number;
  reviewRound: number;
  retryCounters: WorkflowState["counters"];
  humanGate: HumanGateProjection;
  worker: WorkerProjection;
  planningAgent?: { stage: string; identity: WorkerIdentityProjection };
  externalIdentities: Readonly<Record<string, string>>;
  authoritativeRefs: WorkflowStatusRefs;
  reconciliationRef?: ArtifactRef<"reconciliation">;
  latest: {
    validation?: ArtifactRef<"validation">;
    correctnessReview?: ArtifactRef<"correctness-review">;
    ponytailReview?: ArtifactRef<"ponytail-review">;
    findingEvaluation?: ArtifactRef<"finding-evaluation">;
    acceptedFindings?: ArtifactRef<"accepted-findings">;
    roundDecision?: ArtifactRef<"round-decision">;
    codeReview?: ArtifactRef<"code-review">;
  };
  blocked?: BlockState;
  failed?: FailureState;
}

const sensitiveIdentityKey =
  /(?:api[_-]?key|authorization|credential|password|secret|token)/iu;
const identityKey =
  /(?:attempt|correlation|external|node|owner|recon|request|review|run|worker)/iu;
const safeIdentityValue = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const sensitiveIdentityValue =
  /(?:api[_-]?key|authorization|bearer|credential|password|secret|token|sk-[A-Za-z0-9_-]{8,}|gh[oprs]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/iu;

function copyRef<K extends ArtifactRef["kind"]>(
  ref: ArtifactRef<K> | undefined,
): ArtifactRef<K> | undefined {
  return ref ? { ...ref } : undefined;
}

function copyReconciliationRef(
  ref: ArtifactRef | undefined,
): ArtifactRef<"reconciliation"> | undefined {
  return ref?.kind === "reconciliation"
    ? {
        kind: "reconciliation",
        path: ref.path,
        schemaVersion: ref.schemaVersion,
        sha256: ref.sha256,
      }
    : undefined;
}

function isVisibleIdentity(key: string, value: string): boolean {
  return (
    !sensitiveIdentityKey.test(key) &&
    identityKey.test(key) &&
    safeIdentityValue.test(value) &&
    !sensitiveIdentityValue.test(value)
  );
}

function visibleReviewId(value: string): string | undefined {
  return isVisibleIdentity("reviewId", value) ? value : undefined;
}

function visibleExternalIdentities(
  identities: WorkflowState["external"],
): Readonly<Record<string, string>> {
  const visible: Record<string, string> = {};
  for (const [key, value] of Object.entries(identities)) {
    if (isVisibleIdentity(key, value)) visible[key] = value;
  }
  return visible;
}

function visibleWorkerIdentity(
  identity: WorkerIdentityProjection | undefined,
): WorkerIdentityProjection | undefined {
  if (!identity) return undefined;
  const visible: WorkerIdentityProjection = {};
  if (identity.launchStatus) visible.launchStatus = identity.launchStatus;
  for (const [key, value] of Object.entries(identity)) {
    if (key === "requestId" && isVisibleIdentity(key, value)) {
      visible.requestId = value;
    } else if (key === "ownerRunId" && isVisibleIdentity(key, value)) {
      visible.ownerRunId = value;
    } else if (key === "nodeId" && isVisibleIdentity(key, value)) {
      visible.nodeId = value;
    } else if (key === "runId" && isVisibleIdentity(key, value)) {
      visible.runId = value;
    }
  }
  return visible;
}

function effectivePhase(state: WorkflowState): WorkflowPhase {
  return state.phase === "blocked" && state.block
    ? state.block.blockedFrom
    : state.phase;
}

function planGate(
  state: WorkflowState,
  phase: WorkflowPhase,
): HumanGateProjection {
  const binding = state.planning.planReview;
  const reviewId = binding ? visibleReviewId(binding.reviewId) : undefined;
  if (phase === "awaiting-plan-review") {
    return {
      kind: "plan",
      status: binding ? "pending" : "unknown",
      ...(binding
        ? {
            ...(reviewId ? { reviewId } : {}),
            planVersion: binding.planVersion,
          }
        : {}),
    };
  }
  if (state.planning.approvedPlanRef) {
    return {
      kind: "plan",
      status: "approved",
      ...(state.planning.approvedPlanVersion === undefined
        ? {}
        : { planVersion: state.planning.approvedPlanVersion }),
    };
  }
  if (state.planning.latestPlanReviewRef) {
    return { kind: "plan", status: "feedback" };
  }
  return { kind: "plan", status: "not-started" };
}

function codeGate(
  state: WorkflowState,
  phase: WorkflowPhase,
): HumanGateProjection {
  const binding = state.coding.codeReview;
  const reviewId = binding ? visibleReviewId(binding.reviewId) : undefined;
  if (phase === "awaiting-code-review") {
    return {
      kind: "code",
      status: binding ? "pending" : "unknown",
      ...(binding
        ? {
            ...(reviewId ? { reviewId } : {}),
            implementationRevision: binding.implementationRevision,
          }
        : {}),
    };
  }
  if (state.phase === "completed") return { kind: "code", status: "approved" };
  if (phase === "fixing" && state.coding.latestCodeReviewRef) {
    return { kind: "code", status: "feedback" };
  }
  return { kind: "code", status: "not-started" };
}

function humanGate(state: WorkflowState): HumanGateProjection {
  const phase = effectivePhase(state);
  if (
    phase === "awaiting-plan-review" ||
    (!state.planning.approvedPlanRef && state.planning.planReview)
  ) {
    return planGate(state, phase);
  }
  if (phase === "awaiting-code-review" || phase === "completed") {
    return codeGate(state, phase);
  }
  if (state.planning.approvedPlanRef) return codeGate(state, phase);
  return planGate(state, phase);
}

function lifecycleStatus(phase: WorkflowPhase): WorkflowLifecycleStatus {
  if (phase === "blocked") return "blocked";
  if (phase === "failed") return "failed";
  if (phase === "completed") return "completed";
  return "active";
}

export interface WorkflowStatusEvidence {
  worker?: WorkerIdentityProjection;
  reconciliationRef?: ArtifactRef<"reconciliation">;
}

export function projectWorkflowStatus(
  state: WorkflowState,
  evidence: WorkflowStatusEvidence = {},
): WorkflowStatusProjection {
  const workerAttempt = copyRef(state.coding.workerAttemptRef);
  const workerIdentity = visibleWorkerIdentity(evidence.worker);
  const phase = effectivePhase(state);
  const stage =
    phase === "planning"
      ? state.planning.currentPlanRef &&
        state.planning.candidateCycleId === state.planning.cycleId &&
        !sameArtifactRef(
          state.planning.refinementReviewRef,
          state.planning.simplicityReviewRef,
        )
        ? `simplicity-v${state.planning.currentPlanVersion}`
        : `plan-v${state.planning.currentPlanVersion + 1}`
      : phase === "gathering-context"
        ? !state.planning.context.scoutRef
          ? "scout"
          : ["bugfix", "hotfix"].includes(state.playbook) &&
              !state.planning.context.diagnosisRef
            ? "diagnosis"
            : "research"
        : undefined;
  const attempt = stage ? state.planning.agentAttempts?.[stage] : undefined;
  const planningIdentity = attempt
    ? visibleWorkerIdentity({
        ...attempt.dispatch,
        runId: attempt.receipt?.runId,
        launchStatus: attempt.notDispatched
          ? "not-started"
          : attempt.receipt
            ? "observed"
            : "unknown",
      })
    : undefined;
  const reconciliationRef =
    copyReconciliationRef(evidence.reconciliationRef) ??
    copyReconciliationRef(state.block?.evidenceRef) ??
    copyReconciliationRef(state.failure?.evidenceRef);
  const refs: WorkflowStatusRefs = {
    task: copyRef(state.taskRef)!,
    currentPlan: copyRef(state.planning.currentPlanRef),
    approvedPlan: copyRef(state.planning.approvedPlanRef),
    latestPlanReview: copyRef(state.planning.latestPlanReviewRef),
    workerAttempt,
    executionRouting: copyRef(state.coding.executionRoutingRef),
    implementation: copyRef(state.coding.implementationRef),
    validation: copyRef(state.coding.validationRef),
    correctnessReview: copyRef(state.coding.correctnessReviewRef),
    ponytailReview: copyRef(state.coding.ponytailReviewRef),
    findingEvaluation: copyRef(state.coding.findingEvaluationRef),
    acceptedFindings: copyRef(state.coding.acceptedFindingsRef),
    roundDecision: copyRef(state.coding.roundDecisionRef),
    latestCodeReview: copyRef(state.coding.latestCodeReviewRef),
    reconciliation: reconciliationRef,
    blockedEvidence: copyRef(state.block?.evidenceRef),
    failedEvidence: copyRef(state.failure?.evidenceRef),
  };

  return {
    workflowId: state.workflowId,
    playbook: state.playbook,
    phase: state.phase,
    status: lifecycleStatus(state.phase),
    currentPlanVersion: state.planning.currentPlanVersion,
    ...(state.planning.approvedPlanVersion === undefined
      ? {}
      : { approvedPlanVersion: state.planning.approvedPlanVersion }),
    implementationRevision: state.coding.implementationRevision,
    reviewRound: state.coding.reviewRound,
    retryCounters: { ...state.counters },
    humanGate: humanGate(state),
    worker: {
      status: workerAttempt
        ? effectivePhase(state) === "implementing" ||
          effectivePhase(state) === "fixing"
          ? "pending"
          : "known"
        : "none",
      ...(workerAttempt ? { attemptRef: workerAttempt } : {}),
      ...(workerIdentity ? { identity: workerIdentity } : {}),
    },
    ...(stage && planningIdentity
      ? { planningAgent: { stage, identity: planningIdentity } }
      : {}),
    externalIdentities: visibleExternalIdentities(state.external),
    authoritativeRefs: refs,
    ...(reconciliationRef ? { reconciliationRef } : {}),
    latest: {
      validation: refs.validation,
      correctnessReview: refs.correctnessReview,
      ponytailReview: refs.ponytailReview,
      findingEvaluation: refs.findingEvaluation,
      acceptedFindings: refs.acceptedFindings,
      roundDecision: refs.roundDecision,
      codeReview: refs.latestCodeReview,
    },
    ...(state.block
      ? {
          blocked: {
            ...state.block,
            ...(state.block.evidenceRef
              ? { evidenceRef: { ...state.block.evidenceRef } }
              : {}),
          },
        }
      : {}),
    ...(state.failure
      ? {
          failed: {
            ...state.failure,
            ...(state.failure.evidenceRef
              ? { evidenceRef: { ...state.failure.evidenceRef } }
              : {}),
          },
        }
      : {}),
  };
}

function formatRef(ref: ArtifactRef | undefined): string {
  return ref ? `${ref.kind}:${ref.path}#${ref.sha256}` : "-";
}

function formatGate(gate: HumanGateProjection): string {
  const identity = gate.reviewId ? ` review=${gate.reviewId}` : "";
  const version =
    gate.planVersion === undefined ? "" : ` planVersion=${gate.planVersion}`;
  const revision =
    gate.implementationRevision === undefined
      ? ""
      : ` implementationRevision=${gate.implementationRevision}`;
  return `${gate.kind} ${gate.status}${identity}${version}${revision}`;
}

export function renderWorkflowStatus(
  projection: WorkflowStatusProjection,
): string {
  const external = Object.entries(projection.externalIdentities)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  const refs = projection.authoritativeRefs;
  return [
    `Workflow ${projection.workflowId}`,
    `playbook: ${projection.playbook}`,
    `phase: ${projection.phase}`,
    `status: ${projection.status}`,
    `plan: current=${projection.currentPlanVersion} approved=${projection.approvedPlanVersion ?? "-"}`,
    `implementation: revision=${projection.implementationRevision}`,
    `review round: ${projection.reviewRound}`,
    `retries: automated=${projection.retryCounters.automatedFixRoundsUsed} stronger=${projection.retryCounters.strongerRetriesUsed} human-code-feedback=${projection.retryCounters.humanCodeFeedbackRounds}`,
    `human gate: ${formatGate(projection.humanGate)}`,
    `worker: ${projection.worker.status} attempt=${formatRef(projection.worker.attemptRef)}${projection.worker.identity?.runId ? ` run=${projection.worker.identity.runId}` : ""}${projection.worker.identity?.requestId ? ` request=${projection.worker.identity.requestId}` : ""}${projection.worker.identity?.ownerRunId ? ` owner=${projection.worker.identity.ownerRunId}` : ""}${projection.worker.identity?.nodeId ? ` node=${projection.worker.identity.nodeId}` : ""}${projection.worker.identity?.launchStatus ? ` launch=${projection.worker.identity.launchStatus}` : ""}`,
    ...(projection.planningAgent
      ? [
          `planning agent: ${projection.planningAgent.stage} request=${projection.planningAgent.identity.requestId ?? "-"} run=${projection.planningAgent.identity.runId ?? "-"} launch=${projection.planningAgent.identity.launchStatus}`,
        ]
      : []),
    `external: ${external || "-"}`,
    `latest: validation=${formatRef(projection.latest.validation)} correctness=${formatRef(projection.latest.correctnessReview)} ponytail=${formatRef(projection.latest.ponytailReview)} findings=${formatRef(projection.latest.findingEvaluation)} accepted=${formatRef(projection.latest.acceptedFindings)} round=${formatRef(projection.latest.roundDecision)} code=${formatRef(projection.latest.codeReview)} reconciliation=${formatRef(projection.reconciliationRef)}`,
    `refs: task=${formatRef(refs.task)} currentPlan=${formatRef(refs.currentPlan)} approvedPlan=${formatRef(refs.approvedPlan)} implementation=${formatRef(refs.implementation)}`,
    ...(projection.blocked
      ? [
          `blocked reason: ${projection.blocked.reason}`,
          `blocked evidence: ${formatRef(projection.blocked.evidenceRef)}`,
        ]
      : []),
    ...(projection.failed
      ? [
          `failed reason: ${projection.failed.reason}`,
          `failed evidence: ${formatRef(projection.failed.evidenceRef)}`,
        ]
      : []),
  ].join("\n");
}
