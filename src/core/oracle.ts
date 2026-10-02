import type { WorkflowState } from "./workflow/state.ts";
import { isArtifactRef, type ArtifactRef } from "./artifacts/references.ts";
import {
  hasOnlyKeys,
  isRecord,
  isNonNegativeInteger,
  optional,
} from "./schema.ts";

export const oracleReasons = [
  "competing-diagnosis",
  "architecture-tradeoff",
  "planning-disagreement",
  "material-plan-deviation",
  "post-implementation-escalation",
] as const;
export type OracleReason = (typeof oracleReasons)[number];
export const ORACLE_MAX_ATTEMPTS = 2;
export const ORACLE_TIMEOUT_MS = 300_000;

export interface OracleState {
  attemptsUsed: number;
  pendingRef?: ArtifactRef<"oracle-advisory">;
  latestAdviceRef?: ArtifactRef<"oracle-advisory">;
}
export function isOracleState(value: unknown): value is OracleState {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["attemptsUsed", "pendingRef", "latestAdviceRef"]) &&
    isNonNegativeInteger(value.attemptsUsed) &&
    value.attemptsUsed <= ORACLE_MAX_ATTEMPTS &&
    (value.attemptsUsed > 0 || (!value.pendingRef && !value.latestAdviceRef)) &&
    ["pendingRef", "latestAdviceRef"].every((key) =>
      optional(
        value,
        key,
        (ref) => isArtifactRef(ref) && ref.kind === "oracle-advisory",
      ),
    )
  );
}

/** Own ledger/revision writes do not change the caller's bound State contract. */
export function oracleSource(state: WorkflowState): string {
  const source = structuredClone(state);
  delete source.oracle;
  delete source.planning.agentAttempts;
  if (
    source.phase === "blocked" &&
    source.block?.evidenceRef?.kind === "oracle-advisory"
  ) {
    source.phase = source.block.blockedFrom;
    delete source.block;
  }
  return JSON.stringify({
    ...source,
    stateRevision: undefined,
    createdAt: undefined,
    updatedAt: undefined,
  });
}

export function assertOracleReason(
  state: WorkflowState,
  reason: OracleReason,
): void {
  const phase =
    state.phase === "blocked" ? state.block?.blockedFrom : state.phase;
  const context = state.planning.context;
  const allowed = {
    "competing-diagnosis":
      phase === "gathering-context" &&
      ["bugfix", "hotfix"].includes(state.playbook) &&
      !!context.diagnosisRef,
    "architecture-tradeoff": phase === "planning" && !!context.scoutRef,
    "planning-disagreement":
      phase === "planning" && !!state.planning.currentPlanRef,
    "material-plan-deviation":
      phase === "planning" &&
      !!state.coding.workerAttemptRef &&
      !state.planning.approvedPlanRef,
    "post-implementation-escalation":
      phase === "reviewing" && !!state.coding.implementationRef,
  };
  if (!Object.hasOwn(allowed, reason) || !allowed[reason])
    throw Error("Unsupported Oracle escalation reason or decision point");
}

/** All current refs form the evidence frontier; supplied refs are additional explicit evidence. */
export function oracleEvidenceRefs(state: WorkflowState): ArtifactRef[] {
  const refs: ArtifactRef[] = [];
  const visit = (value: unknown) => {
    if (isArtifactRef(value)) {
      refs.push(value);
      return;
    }
    if (isRecord(value) || Array.isArray(value))
      Object.values(value).forEach(visit);
  };
  const source = JSON.parse(oracleSource(state));
  visit(source);
  return refs.filter(
    (ref, index) =>
      refs.findIndex(
        (other) => JSON.stringify(other) === JSON.stringify(ref),
      ) === index,
  );
}
