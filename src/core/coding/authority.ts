import { isArtifactRef, type ArtifactRef } from "../artifacts/references.ts";
import {
  hasOnlyKeys,
  isNonEmptyString,
  isNonNegativeInteger,
  isRecord,
} from "../schema.ts";
import { sameArtifactRef } from "../workflow/invariants.ts";
import type { WorkflowState } from "../workflow/state.ts";

export interface CodingAuthority {
  workflowId: string;
  approvedPlanRef: ArtifactRef<"plan">;
  planVersion: number;
  implementationRef: ArtifactRef<"implementation">;
  implementationRevision: number;
}
export function isCodingAuthority(value: unknown): value is CodingAuthority {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "workflowId",
      "approvedPlanRef",
      "planVersion",
      "implementationRef",
      "implementationRevision",
    ]) &&
    isNonEmptyString(value.workflowId) &&
    isArtifactRef(value.approvedPlanRef) &&
    value.approvedPlanRef.kind === "plan" &&
    isNonNegativeInteger(value.planVersion) &&
    value.planVersion > 0 &&
    isArtifactRef(value.implementationRef) &&
    value.implementationRef.kind === "implementation" &&
    isNonNegativeInteger(value.implementationRevision) &&
    value.implementationRevision > 0
  );
}
export function codingAuthority(state: WorkflowState): CodingAuthority {
  const { approvedPlanRef, approvedPlanVersion } = state.planning;
  const { implementationRef, implementationRevision } = state.coding;
  if (
    !approvedPlanRef ||
    !approvedPlanVersion ||
    !implementationRef ||
    !implementationRevision
  )
    throw Error("Missing current coding authority");
  return {
    workflowId: state.workflowId,
    approvedPlanRef,
    planVersion: approvedPlanVersion,
    implementationRef,
    implementationRevision,
  };
}
export function assertCodingAuthority(
  state: WorkflowState,
  value: unknown,
): void {
  const current = codingAuthority(state);
  if (
    !isCodingAuthority(value) ||
    value.workflowId !== current.workflowId ||
    value.planVersion !== current.planVersion ||
    value.implementationRevision !== current.implementationRevision ||
    !sameArtifactRef(value.approvedPlanRef, current.approvedPlanRef) ||
    !sameArtifactRef(value.implementationRef, current.implementationRef)
  )
    throw Error("Stale or missing coding authority binding");
}
