import {
  hasOnlyKeys,
  isNonEmptyString,
  isOneOf,
  isRecord,
  parseSchema,
} from "../schema.ts";

/** Evidence only. Scope/architecture choices still belong to the Human. */
export interface DiagnosisReport {
  observedSymptom: string;
  expectedBehavior: string | null;
  reproduction: {
    status: "reproduced" | "not-reproduced" | "unavailable";
    steps: string[];
    evidence: string;
  };
  workspaceEvidence: string[];
  rootCause: {
    status: "suspected" | "confirmed" | "unknown";
    explanation: string;
    evidenceStrength: "strong" | "limited" | "none";
    supportingEvidence: string[];
    contradictingEvidence: string[];
  };
  unresolvedFactualGaps: string[];
  externalDependencySignals: string[];
  affectedScope: string[];
  hotfix: {
    scope: "within-scope" | "scope-exceeded" | "unknown";
    reason: string;
    riskNotes: string[];
  };
}
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isNonEmptyString);
export function isDiagnosisReport(value: unknown): value is DiagnosisReport {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "observedSymptom",
      "expectedBehavior",
      "reproduction",
      "workspaceEvidence",
      "rootCause",
      "unresolvedFactualGaps",
      "externalDependencySignals",
      "affectedScope",
      "hotfix",
    ])
  )
    return false;
  const { reproduction, rootCause, hotfix } = value;
  return (
    isNonEmptyString(value.observedSymptom) &&
    (value.expectedBehavior === null ||
      isNonEmptyString(value.expectedBehavior)) &&
    isRecord(reproduction) &&
    hasOnlyKeys(reproduction, ["status", "steps", "evidence"]) &&
    isOneOf(
      ["reproduced", "not-reproduced", "unavailable"] as const,
      reproduction.status,
    ) &&
    strings(reproduction.steps) &&
    isNonEmptyString(reproduction.evidence) &&
    (reproduction.status !== "reproduced" || reproduction.steps.length > 0) &&
    strings(value.workspaceEvidence) &&
    value.workspaceEvidence.length > 0 &&
    isRecord(rootCause) &&
    hasOnlyKeys(rootCause, [
      "status",
      "explanation",
      "evidenceStrength",
      "supportingEvidence",
      "contradictingEvidence",
    ]) &&
    isOneOf(["suspected", "confirmed", "unknown"] as const, rootCause.status) &&
    isNonEmptyString(rootCause.explanation) &&
    isOneOf(
      ["strong", "limited", "none"] as const,
      rootCause.evidenceStrength,
    ) &&
    strings(rootCause.supportingEvidence) &&
    strings(rootCause.contradictingEvidence) &&
    (rootCause.status !== "confirmed" ||
      (rootCause.evidenceStrength === "strong" &&
        rootCause.supportingEvidence.length > 0)) &&
    strings(value.unresolvedFactualGaps) &&
    strings(value.externalDependencySignals) &&
    strings(value.affectedScope) &&
    value.affectedScope.length > 0 &&
    isRecord(hotfix) &&
    hasOnlyKeys(hotfix, ["scope", "reason", "riskNotes"]) &&
    isOneOf(
      ["within-scope", "scope-exceeded", "unknown"] as const,
      hotfix.scope,
    ) &&
    isNonEmptyString(hotfix.reason) &&
    strings(hotfix.riskNotes)
  );
}
export function parseDiagnosisReport(value: unknown): DiagnosisReport {
  return parseSchema(value, isDiagnosisReport, "DiagnosisReport");
}
