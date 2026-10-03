import { isArtifactRef, type ArtifactRef } from "../artifacts/references.ts";
import {
  hasOnlyKeys,
  isNonEmptyString,
  isNonNegativeInteger,
  isOneOf,
  isRecord,
} from "../schema.ts";

export const PLAN_DEVIATION_MARKER = "PLAN_DEVIATION";
export const deviationCategories = [
  "new-component",
  "new-dependency",
  "public-api",
  "repository-boundary",
  "persistence-integration",
  "scope",
  "development-method",
  "test-seams",
  "validation-contract",
] as const;

export interface PlanDeviationBinding {
  workflowId: string;
  attemptId: string;
  approvedPlanRef: ArtifactRef<"plan">;
  planVersion: number;
  inputRevision: number;
}

/** A stopped Worker's proposal is evidence only, never permission to implement it. */
export interface PlanDeviationReport extends PlanDeviationBinding {
  schemaVersion: 1;
  category: (typeof deviationCategories)[number];
  reason: string;
  constraint: string;
  proposedChange: string;
  localAlternative: string;
  evidence: string[];
}

function boundedText(value: unknown): value is string {
  return (
    isNonEmptyString(value) && value.trim().length > 0 && value.length <= 2_000
  );
}

export function parsePlanDeviationReport(value: unknown): PlanDeviationReport {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "workflowId",
      "attemptId",
      "approvedPlanRef",
      "planVersion",
      "inputRevision",
      "category",
      "reason",
      "constraint",
      "proposedChange",
      "localAlternative",
      "evidence",
    ]) ||
    value.schemaVersion !== 1 ||
    !boundedText(value.workflowId) ||
    !boundedText(value.attemptId) ||
    !isArtifactRef(value.approvedPlanRef) ||
    value.approvedPlanRef.kind !== "plan" ||
    !isNonNegativeInteger(value.planVersion) ||
    value.planVersion < 1 ||
    !isNonNegativeInteger(value.inputRevision) ||
    !isOneOf(deviationCategories, value.category) ||
    ![
      value.reason,
      value.constraint,
      value.proposedChange,
      value.localAlternative,
    ].every(boundedText) ||
    !Array.isArray(value.evidence) ||
    value.evidence.length < 1 ||
    value.evidence.length > 8 ||
    !value.evidence.every(boundedText)
  )
    throw Error("Invalid bounded Plan deviation report");
  // Closed schema establishes the domain projection at the JSON boundary.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as unknown as PlanDeviationReport;
}

/** A malformed stop signal must never fall back to implementation success. */
export function workerDeviation(
  output: string,
): PlanDeviationReport | undefined {
  if (!output.includes(PLAN_DEVIATION_MARKER)) return undefined;
  if (
    output.length > 16_000 ||
    !output.trim().startsWith(`${PLAN_DEVIATION_MARKER}\n`)
  )
    throw Error("Invalid Worker Plan deviation stop signal");
  return parsePlanDeviationReport(
    JSON.parse(output.trim().slice(PLAN_DEVIATION_MARKER.length)),
  );
}
