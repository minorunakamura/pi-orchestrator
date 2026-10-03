import { expect, test } from "vitest";
import { parseDiagnosisReport } from "../../src/core/planning/diagnosis.ts";
import { diagnosisReport } from "../fakes/diagnosis.ts";
import { isWorkflowEvent } from "../../src/core/workflow/state.ts";

test("Diagnosis validates all required evidence fields and rejects invented certainty", () => {
  expect(parseDiagnosisReport(diagnosisReport)).toEqual(diagnosisReport);
  for (const key of Object.keys(diagnosisReport)) {
    const missing: Record<string, unknown> = { ...diagnosisReport };
    delete missing[key];
    expect(() => parseDiagnosisReport(missing)).toThrow();
  }
  for (const invalid of [
    { ...diagnosisReport, expectedBehavior: "" },
    { ...diagnosisReport, workspaceEvidence: [] },
    { ...diagnosisReport, affectedScope: [] },
    {
      ...diagnosisReport,
      rootCause: { ...diagnosisReport.rootCause, evidenceStrength: "limited" },
    },
    {
      ...diagnosisReport,
      rootCause: { ...diagnosisReport.rootCause, supportingEvidence: [] },
    },
    {
      ...diagnosisReport,
      reproduction: { ...diagnosisReport.reproduction, steps: [] },
    },
    {
      ...diagnosisReport,
      reproduction: { ...diagnosisReport.reproduction, evidence: "" },
    },
    {
      ...diagnosisReport,
      hotfix: { ...diagnosisReport.hotfix, scope: "APPROVED" },
    },
    { ...diagnosisReport, implementationAuthority: true },
  ])
    expect(() => parseDiagnosisReport(invalid)).toThrow();
});

test("DIAGNOSIS_PERSISTED requires a Diagnosis ref, not Scout or approval", () => {
  const ref = {
    kind: "diagnosis",
    path: "context/diagnosis.md",
    schemaVersion: 1,
    sha256: "a".repeat(64),
  };
  expect(
    isWorkflowEvent({ type: "DIAGNOSIS_PERSISTED", diagnosisRef: ref }),
  ).toBe(true);
  expect(
    isWorkflowEvent({
      type: "DIAGNOSIS_PERSISTED",
      diagnosisRef: { ...ref, kind: "scout" },
    }),
  ).toBe(false);
  expect(
    isWorkflowEvent({
      type: "DIAGNOSIS_PERSISTED",
      diagnosisRef: ref,
      approved: true,
    }),
  ).toBe(false);
});
