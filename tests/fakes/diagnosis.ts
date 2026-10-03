import type { DiagnosisReport } from "../../src/core/planning/diagnosis.ts";

export const diagnosisReport: DiagnosisReport = {
  observedSymptom: "Lookup rejects a valid cached key",
  expectedBehavior: "Return the cached value",
  reproduction: {
    status: "reproduced",
    steps: ["Invoke lookup with the cached key"],
    evidence: "Recorded failure in tests/cache.test.ts:10-18",
  },
  workspaceEvidence: ["src/cache.ts:12-20 uses a falsy guard"],
  rootCause: {
    status: "confirmed",
    explanation: "A falsy value is treated as absent",
    evidenceStrength: "strong",
    supportingEvidence: ["src/cache.ts:14 and tests/cache.test.ts:16"],
    contradictingEvidence: [],
  },
  unresolvedFactualGaps: [],
  externalDependencySignals: [],
  affectedScope: ["src/cache.ts lookup guard and regression test"],
  hotfix: {
    scope: "within-scope",
    reason: "Local guard fix; no architecture or scope redesign",
    riskNotes: ["Keep missing-key behavior unchanged"],
  },
};
