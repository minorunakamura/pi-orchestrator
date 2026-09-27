import { describe, expect, test } from "vitest";
import { decideRound } from "../../../src/core/decisions/round-decision.ts";
import { evaluateFinding } from "../../../src/core/decisions/finding-evaluation.ts";

const policy = { autoDecisionThreshold: 0.8, escalationThreshold: 0.5 };
const dimension = (value: boolean) => ({ value, confidence: 0.99 });
const finding = (id: string, human: boolean) =>
  evaluateFinding(
    {
      id,
      source: "correctness",
      category: "regression",
      summary: id,
      evidence: id,
      blocking: true,
    },
    {
      findingId: id,
      evidenceSupported: dimension(true),
      conflictsWithApprovedPlan: dimension(false),
      conflictsWithArchitecture: dimension(false),
      inScope: dimension(true),
      requiresHumanDecision: dimension(human),
    },
    policy,
  );

describe("Round authority precedence", () => {
  test("low-confidence RETRY requires Human attention", () => {
    expect(
      decideRound(
        {
          rawDecision: { decision: "RETRY", confidence: 0.01 },
          validation: { status: "passed" },
          findings: [],
        },
        policy,
      ),
    ).toMatchObject({ decision: "ESCALATE", escalationReason: "uncertain" });
  });
  test.each(["RETRY", "COMPLETE"] as const)(
    "Human findings override %s and accepted blocking findings",
    (decision) => {
      expect(
        decideRound(
          {
            rawDecision: { decision, confidence: 0.99 },
            validation: { status: "passed" },
            findings: [finding("A", false), finding("H", true)],
          },
          policy,
        ),
      ).toMatchObject({
        decision: "ESCALATE",
        escalationReason: "human-decision",
      });
    },
  );
  test("uncertain finding overrides a confident capability escalation", () => {
    const uncertain = {
      ...finding("U", false),
      decision: "ESCALATE" as const,
      reasonCode: "uncertain",
    };
    expect(
      decideRound(
        {
          rawDecision: {
            decision: "ESCALATE",
            confidence: 0.99,
            escalationReason: "implementation-capability",
            escalationReasonConfidence: 0.99,
          },
          validation: { status: "passed" },
          findings: [finding("A", false), uncertain],
        },
        policy,
      ),
    ).toMatchObject({ decision: "ESCALATE", escalationReason: "uncertain" });
  });
  test("missing required reason confidence is rejected rather than defaulted", () => {
    const raw = JSON.parse(
      '{"decision":"ESCALATE","confidence":0.99,"escalationReason":"implementation-capability"}',
    );
    expect(() =>
      decideRound(
        { rawDecision: raw, validation: { status: "passed" }, findings: [] },
        policy,
      ),
    ).toThrow(/reason/iu);
  });
  test("low-confidence reason cannot borrow action confidence", () => {
    expect(
      decideRound(
        {
          rawDecision: {
            decision: "ESCALATE",
            confidence: 0.99,
            escalationReason: "implementation-capability",
            escalationReasonConfidence: 0.01,
          },
          validation: { status: "passed" },
          findings: [],
        },
        policy,
      ),
    ).toMatchObject({ decision: "ESCALATE", escalationReason: "uncertain" });
  });
});
