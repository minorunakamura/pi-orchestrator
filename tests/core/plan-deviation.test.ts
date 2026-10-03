import { describe, expect, test } from "vitest";
import {
  deviationCategories,
  parsePlanDeviationReport,
  workerDeviation,
} from "../../src/core/coding/plan-deviation.ts";
import { evaluateFinding } from "../../src/core/decisions/finding-evaluation.ts";
import { decideRound } from "../../src/core/decisions/round-decision.ts";
import { reviewFinding } from "../fakes/phase-c-workflow.ts";

const report = {
  schemaVersion: 1,
  workflowId: "workflow",
  attemptId: "attempt",
  inputRevision: 0,
  planVersion: 1,
  approvedPlanRef: {
    kind: "plan",
    path: "plans/plan-v1.md",
    schemaVersion: 1,
    sha256: "a".repeat(64),
  },
  category: "public-api",
  reason: "Missing required public input",
  constraint: "Preserve public API",
  proposedChange: "Change public API (not implemented)",
  localAlternative: "No safe private helper can supply the input",
  evidence: ["src/api.ts:1 missing input"],
};
const policy = { autoDecisionThreshold: 0.8, escalationThreshold: 0.5 };
const yes = { value: true, confidence: 0.99 };
const no = { value: false, confidence: 0.99 };

describe("bounded stop and post-code boundary policy", () => {
  test.each(deviationCategories)(
    "accepts %s as evidence, not implementation",
    (category) => {
      const value = { ...report, category };
      expect(
        workerDeviation(`PLAN_DEVIATION\n${JSON.stringify(value)}`),
      ).toEqual(value);
    },
  );
  test.each([
    { ...report, evidence: [] },
    { ...report, evidence: Array(9).fill("facts") },
    { ...report, proposedChange: "x".repeat(2001) },
    { ...report, constraint: " " },
    { ...report, category: "private-helper" },
    { ...report, approved: true },
    { ...report, planVersion: 0 },
    { ...report, inputRevision: -1 },
  ])("rejects invalid/oversized reports", (value) =>
    expect(() => parsePlanDeviationReport(value)).toThrow(),
  );
  test("local details complete normally; malformed stop never falls back to success", () => {
    expect(
      workerDeviation(
        "Extracted a private helper preserving the approved strategy",
      ),
    ).toBeUndefined();
    for (const output of [
      "PLAN_DEVIATION",
      "```\nPLAN_DEVIATION\n{}\n```",
      "PLAN_DEVIATION\n{}",
      "PLAN_DEVIATION\n" + "x".repeat(16000),
    ])
      expect(() => workerDeviation(output)).toThrow();
  });
  test.each(["COMPLETE", "RETRY", "ESCALATE"] as const)(
    "observed boundary violation cannot become %s authority",
    (action) => {
      const finding = {
        ...reviewFinding("C1"),
        category: "plan-boundary-violation",
      };
      const evaluation = evaluateFinding(
        finding,
        {
          findingId: finding.id,
          evidenceSupported: yes,
          conflictsWithApprovedPlan: yes,
          conflictsWithArchitecture: no,
          inScope: yes,
          requiresHumanDecision: no,
        },
        policy,
      );
      expect(evaluation).toMatchObject({
        decision: "ESCALATE",
        reasonCode: "plan-conflict",
      });
      const decision = decideRound(
        {
          rawDecision:
            action === "ESCALATE"
              ? {
                  decision: action,
                  confidence: 0.99,
                  escalationReason: "implementation-capability",
                  escalationReasonConfidence: 0.99,
                }
              : { decision: action, confidence: 0.99 },
          validation: { status: "passed" },
          findings: [evaluation],
        },
        policy,
      );
      expect(decision).toMatchObject({
        decision: "ESCALATE",
        escalationReason: "plan-conflict",
      });
      expect(
        evaluateFinding(
          { ...finding, category: "regression" },
          {
            findingId: finding.id,
            evidenceSupported: yes,
            conflictsWithApprovedPlan: yes,
            conflictsWithArchitecture: no,
            inScope: yes,
            requiresHumanDecision: no,
          },
          policy,
        ).decision,
      ).toBe("REJECT");
      expect(
        decideRound(
          {
            rawDecision: { decision: "COMPLETE", confidence: 0.1 },
            validation: { status: "passed" },
            findings: [evaluation],
          },
          policy,
        ),
      ).toMatchObject({ decision: "ESCALATE", escalationReason: "uncertain" });
    },
  );
});
