import { describe, expect, test } from "vitest";
import type { ArtifactRef } from "../../../src/core/artifacts/references.ts";
import type { ReviewFinding } from "../../../src/core/coding/finding.ts";
import { applyConfidencePolicy } from "../../../src/core/decisions/confidence-policy.ts";
import {
  resolveExecutionRouting,
  strongerModelTier,
  strongerReasoningTier,
} from "../../../src/core/decisions/execution-routing.ts";
import {
  evaluateFinding,
  evaluateFindings,
} from "../../../src/core/decisions/finding-evaluation.ts";
import { mapEscalationReason } from "../../../src/core/decisions/escalation-policy.ts";
import {
  checkDecisionFreshness,
  isDecisionFresh,
  isDecisionFreshness,
  type DecisionFreshnessExpectation,
} from "../../../src/core/decisions/decision-freshness.ts";
import {
  decideRound,
  routeRoundDecision,
  strongerExecutionProfile,
} from "../../../src/core/decisions/round-decision.ts";
import type {
  Decision,
  ModelTier,
  ReasoningTier,
  ValidationResult,
} from "../../../src/core/decisions/types.ts";
import type {
  FindingEvaluationRawDecision,
  RoundDecisionRawDecision,
  ExecutionRoutingRawDecision,
} from "../../../src/runtime/ports/jev-decision-client.ts";

const policy = {
  autoDecisionThreshold: 0.8,
  escalationThreshold: 0.5,
};

const planRef: ArtifactRef<"plan"> = {
  kind: "plan",
  path: "plans/plan-v1.md",
  schemaVersion: 1,
  sha256: "a".repeat(64),
};
const contextRef: ArtifactRef<"scout"> = {
  kind: "scout",
  path: "context/scout-v1.json",
  schemaVersion: 1,
  sha256: "b".repeat(64),
};

const finding: ReviewFinding = {
  id: "C1",
  source: "correctness",
  category: "regression",
  location: "src/example.ts:10",
  summary: "The changed path regresses error handling.",
  evidence: "The error branch is no longer reached.",
  blocking: true,
};

function decision<T>(value: T, confidence = 0.95): Decision<T> {
  return { value, confidence };
}

function rawFinding(
  overrides: Partial<FindingEvaluationRawDecision> = {},
): FindingEvaluationRawDecision {
  return {
    findingId: finding.id,
    evidenceSupported: decision(true),
    conflictsWithApprovedPlan: decision(false),
    conflictsWithArchitecture: decision(false),
    inScope: decision(true),
    requiresHumanDecision: decision(false),
    ...overrides,
  };
}

function validation(
  status: ValidationResult["status"] = "passed",
): ValidationResult {
  return {
    schemaVersion: 1,
    implementationRevision: 2,
    status,
    checks: [
      { id: "tests", status: status === "passed" ? "passed" : "failed" },
    ],
  };
}

type NonEscalatedRoundDecision = Extract<
  RoundDecisionRawDecision,
  { decision: "COMPLETE" | "RETRY" }
>;

function roundRaw(
  overrides: Partial<NonEscalatedRoundDecision> = {},
): NonEscalatedRoundDecision {
  return { decision: "COMPLETE", confidence: 0.95, ...overrides };
}

function routingRaw(
  modelTier: ModelTier,
  reasoningTier: ReasoningTier,
  modelConfidence: number,
  reasoningConfidence: number,
): ExecutionRoutingRawDecision {
  return {
    modelTier: decision(modelTier, modelConfidence),
    reasoningTier: decision(reasoningTier, reasoningConfidence),
  };
}

describe("confidence policy", () => {
  test.each([
    [0.8, "auto"],
    [0.5, "stronger"],
    [0.79, "stronger"],
    [0.49, "escalate"],
  ])("classifies the %s boundary as %s", (confidence, expected) => {
    expect(applyConfidencePolicy(confidence, policy)).toBe(expected);
  });

  test("rejects inverted thresholds", () => {
    expect(() =>
      applyConfidencePolicy(0.8, {
        autoDecisionThreshold: 0.4,
        escalationThreshold: 0.6,
      }),
    ).toThrow();
  });
});

describe("execution routing", () => {
  test("keeps a high-confidence logical profile", () => {
    expect(
      resolveExecutionRouting(
        routingRaw("STANDARD", "HIGH", 0.95, 0.9),
        policy,
      ),
    ).toEqual({
      modelTier: decision("STANDARD", 0.95),
      reasoningTier: decision("HIGH", 0.9),
      effectiveConfidence: 0.9,
    });
  });

  test("uses the safe stronger profile for low confidence", () => {
    expect(
      resolveExecutionRouting(routingRaw("ECONOMY", "LOW", 0.4, 0.7), policy),
    ).toEqual({
      modelTier: decision("STANDARD", 0.4),
      reasoningTier: decision("MEDIUM", 0.7),
      effectiveConfidence: 0.4,
    });
  });

  test("never weakens an already strongest profile", () => {
    expect(strongerModelTier("STRONG")).toBe("STRONG");
    expect(strongerReasoningTier("HIGH")).toBe("HIGH");
    expect(
      resolveExecutionRouting(routingRaw("STRONG", "HIGH", 0.2, 0.2), policy),
    ).toMatchObject({
      modelTier: { value: "STRONG" },
      reasoningTier: { value: "HIGH" },
    });
  });
});

describe("finding evaluation", () => {
  test.each([
    ["supported, in-scope", rawFinding(), "ACCEPT", "accepted"],
    [
      "unsupported evidence",
      rawFinding({ evidenceSupported: decision(false) }),
      "REJECT",
      "unsupported-evidence",
    ],
    [
      "out of scope",
      rawFinding({ inScope: decision(false) }),
      "REJECT",
      "out-of-scope",
    ],
    [
      "approved-plan conflict",
      rawFinding({ conflictsWithApprovedPlan: decision(true) }),
      "REJECT",
      "approved-plan-conflict",
    ],
    [
      "architecture conflict",
      rawFinding({ conflictsWithArchitecture: decision(true) }),
      "REJECT",
      "approved-architecture-conflict",
    ],
    [
      "human decision",
      rawFinding({ requiresHumanDecision: decision(true) }),
      "ESCALATE",
      "human-decision",
    ],
    [
      "low confidence",
      rawFinding({ evidenceSupported: decision(true, 0.79) }),
      "ESCALATE",
      "uncertain",
    ],
  ])("maps %s deterministically", (_name, raw, expected, reasonCode) => {
    expect(evaluateFinding(finding, raw, policy)).toMatchObject({
      findingId: finding.id,
      decision: expected,
      reasonCode,
    });
  });

  test("carries reviewer blocking metadata into the policy result", () => {
    expect(evaluateFinding(finding, rawFinding(), policy).blocking).toBe(true);
  });

  test("evaluates a complete finding set without dropping IDs", () => {
    const second = { ...finding, id: "P1", source: "ponytail" as const };
    const results = evaluateFindings(
      [finding, second],
      [rawFinding(), { ...rawFinding(), findingId: second.id }],
      policy,
    );
    expect(results.map(({ findingId }) => findingId)).toEqual(["C1", "P1"]);
  });
});

describe("round decision", () => {
  test("keeps a clean, confident COMPLETE", () => {
    expect(
      decideRound(
        {
          rawDecision: roundRaw(),
          validation: validation(),
          findings: [],
        },
        policy,
      ),
    ).toEqual({ decision: "COMPLETE", confidence: 0.95 });
  });

  test("overrides Jev COMPLETE when validation failed", () => {
    expect(
      decideRound(
        {
          rawDecision: roundRaw(),
          validation: validation("failed"),
          findings: [],
        },
        policy,
      ),
    ).toEqual({
      decision: "RETRY",
      confidence: 0.95,
      reason: "validation-failed",
    });
  });

  test("overrides Jev COMPLETE when an accepted blocking finding exists", () => {
    const accepted = evaluateFinding(finding, rawFinding(), policy);
    expect(
      decideRound(
        {
          rawDecision: roundRaw(),
          validation: validation(),
          findings: [accepted],
        },
        policy,
      ),
    ).toEqual({
      decision: "RETRY",
      confidence: 0.95,
      reason: "accepted-blocking-findings",
    });
  });

  test("does not infer a blocking finding from a non-blocking accepted set", () => {
    const accepted = evaluateFinding(finding, rawFinding(), policy);
    expect(
      decideRound(
        {
          rawDecision: roundRaw(),
          validation: validation(),
          findings: [{ ...accepted, blocking: false }],
          acceptedBlockingFindingIds: [],
        },
        policy,
      ).decision,
    ).toBe("COMPLETE");
  });

  test("fails closed when accepted blocking metadata is missing", () => {
    const accepted = evaluateFinding(finding, rawFinding(), policy);
    expect(
      decideRound(
        {
          rawDecision: roundRaw(),
          validation: validation(),
          findings: [
            { ...accepted, blocking: undefined as unknown as boolean },
          ],
        },
        policy,
      ),
    ).toEqual({
      decision: "ESCALATE",
      confidence: 0.95,
      escalationReason: "uncertain",
    });
  });

  test("fails closed for an unknown accepted blocking ID", () => {
    expect(
      decideRound(
        {
          rawDecision: roundRaw(),
          validation: validation(),
          findings: [],
          acceptedBlockingFindingIds: ["missing"],
        },
        policy,
      ),
    ).toEqual({
      decision: "ESCALATE",
      confidence: 0.95,
      escalationReason: "uncertain",
    });
  });

  test("does not silently accept a low-confidence Jev COMPLETE", () => {
    expect(
      decideRound(
        {
          rawDecision: roundRaw({ confidence: 0.79 }),
          validation: validation(),
          findings: [],
        },
        policy,
      ),
    ).toEqual({
      decision: "ESCALATE",
      confidence: 0.79,
      escalationReason: "uncertain",
    });
  });

  test("an escalated finding prevents COMPLETE", () => {
    const escalated = evaluateFinding(
      finding,
      rawFinding({ requiresHumanDecision: decision(true) }),
      policy,
    );
    expect(
      decideRound(
        {
          rawDecision: roundRaw(),
          validation: validation(),
          findings: [escalated],
        },
        policy,
      ),
    ).toEqual({
      decision: "ESCALATE",
      confidence: 0.95,
      escalationReason: "human-decision",
    });
  });
});

describe("round routing and retry budgets", () => {
  const decisionRef: ArtifactRef<"round-decision"> = {
    kind: "round-decision",
    path: "reviews/round-decision-1.json",
    schemaVersion: 1,
    sha256: "d".repeat(64),
  };
  const validationRef: ArtifactRef<"validation"> = {
    kind: "validation",
    path: "validation/validation-1.json",
    schemaVersion: 1,
    sha256: "e".repeat(64),
  };
  const findingsRef: ArtifactRef<"accepted-findings"> = {
    kind: "accepted-findings",
    path: "reviews/accepted-findings-1.json",
    schemaVersion: 1,
    sha256: "f".repeat(64),
  };
  const retries = { maxAutomatedFixRounds: 3, maxStrongerRetries: 1 };

  test.each([
    ["ECONOMY", "LOW", "STANDARD", "MEDIUM"],
    ["STANDARD", "MEDIUM", "STRONG", "HIGH"],
    ["STRONG", "HIGH", "STRONG", "HIGH"],
  ] as const)(
    "calculates monotonic stronger profile from %s + %s",
    (modelTier, reasoningTier, expectedModelTier, expectedReasoningTier) => {
      expect(strongerExecutionProfile({ modelTier, reasoningTier })).toEqual({
        modelTier: expectedModelTier,
        reasoningTier: expectedReasoningTier,
      });
    },
  );

  test("routes a validation retry while max-1 budget remains", () => {
    expect(
      routeRoundDecision({
        phase: "validating",
        counters: {
          automatedFixRoundsUsed: 2,
          strongerRetriesUsed: 0,
          humanCodeFeedbackRounds: 0,
        },
        retries,
        decision: { decision: "RETRY", confidence: 0.95 },
        decisionRef,
        validationRef,
      }),
    ).toEqual({
      type: "RETRY_REQUIRED",
      decisionRef,
      validationRef,
    });
  });

  test("blocks the next automated retry at the exact max budget", () => {
    expect(
      routeRoundDecision({
        phase: "validating",
        counters: {
          automatedFixRoundsUsed: 3,
          strongerRetriesUsed: 0,
          humanCodeFeedbackRounds: 0,
        },
        retries,
        decision: { decision: "RETRY", confidence: 0.95 },
        decisionRef,
        validationRef,
      }),
    ).toEqual({
      type: "BLOCK",
      reason: "retry-budget-exhausted",
      evidenceRef: decisionRef,
    });
  });

  test("requires both budgets for a stronger retry", () => {
    expect(
      routeRoundDecision({
        phase: "reviewing",
        counters: {
          automatedFixRoundsUsed: 2,
          strongerRetriesUsed: 0,
          humanCodeFeedbackRounds: 4,
        },
        retries,
        decision: {
          decision: "ESCALATE",
          confidence: 0.95,
          escalationReason: "implementation-capability",
        },
        decisionRef,
        findingsRef,
      }),
    ).toEqual({
      type: "STRONGER_RETRY_REQUIRED",
      decisionRef,
      findingsRef,
    });

    expect(
      routeRoundDecision({
        phase: "reviewing",
        counters: {
          automatedFixRoundsUsed: 2,
          strongerRetriesUsed: 1,
          humanCodeFeedbackRounds: 4,
        },
        retries,
        decision: {
          decision: "ESCALATE",
          confidence: 0.95,
          escalationReason: "implementation-capability",
        },
        decisionRef,
        findingsRef,
      }),
    ).toEqual({
      type: "BLOCK",
      reason: "retry-budget-exhausted",
      evidenceRef: decisionRef,
    });
  });

  test("blocks stronger escalation when already at STRONG + HIGH", () => {
    expect(
      routeRoundDecision({
        phase: "reviewing",
        counters: {
          automatedFixRoundsUsed: 0,
          strongerRetriesUsed: 0,
          humanCodeFeedbackRounds: 0,
        },
        retries,
        currentProfile: { modelTier: "STRONG", reasoningTier: "HIGH" },
        decision: {
          decision: "ESCALATE",
          confidence: 0.95,
          escalationReason: "implementation-capability",
        },
        decisionRef,
      }),
    ).toEqual({
      type: "BLOCK",
      reason: "stronger-profile-unavailable",
      evidenceRef: decisionRef,
    });
  });

  test.each([
    ["plan-conflict", "REPLAN_REQUIRED"],
    ["human-decision", "CLARIFICATION_REQUIRED"],
    ["uncertain", "CLARIFICATION_REQUIRED"],
  ] as const)("routes %s without silently continuing", (reason, type) => {
    const event = routeRoundDecision({
      phase: "reviewing",
      counters: {
        automatedFixRoundsUsed: 0,
        strongerRetriesUsed: 0,
        humanCodeFeedbackRounds: 0,
      },
      retries,
      decision: {
        decision: "ESCALATE",
        confidence: 0.95,
        escalationReason: reason,
      },
      decisionRef,
    });
    expect(event.type).toBe(type);
    if ("reasonRef" in event) {
      expect(event.reasonRef).toEqual(decisionRef);
    } else {
      expect("decisionRef" in event).toBe(true);
      if ("decisionRef" in event)
        expect(event.decisionRef).toEqual(decisionRef);
    }
  });
});

describe("escalation mapping", () => {
  test.each([
    [
      "implementation-capability",
      "stronger-execution",
      "STRONGER_RETRY_REQUIRED",
    ],
    ["plan-conflict", "planning", "REPLAN_REQUIRED"],
    ["human-decision", "clarification", "CLARIFICATION_REQUIRED"],
    ["uncertain", "clarification", "CLARIFICATION_REQUIRED"],
  ] as const)("maps %s to %s", (reason, target, event) => {
    expect(mapEscalationReason(reason)).toMatchObject({
      reason,
      target,
      event,
    });
  });
});

describe("decision freshness", () => {
  const expected: DecisionFreshnessExpectation = {
    schemaVersion: 1,
    planVersion: 1,
    implementationRevision: 2,
    inputRefs: [planRef, contextRef],
    inputDigest: "input-digest-v1",
    policyDigest: "policy-digest-v1",
    configurationDigest: "configuration-digest-v1",
  };

  test("accepts a matching decision contract", () => {
    expect(isDecisionFresh(expected, expected)).toBe(true);
    expect(checkDecisionFreshness(expected, expected)).toEqual({
      fresh: true,
      mismatches: [],
    });
  });

  test.each([
    ["schemaVersion", { schemaVersion: 2 }],
    ["planVersion", { planVersion: 2 }],
    ["implementationRevision", { implementationRevision: 3 }],
    ["inputRefs", { inputRefs: [planRef] }],
    ["inputDigest", { inputDigest: "other" }],
    ["policyDigest", { policyDigest: "other" }],
    ["configurationDigest", { configurationDigest: "other" }],
  ])("rejects stale %s", (_field, change) => {
    const staleDecision = { ...expected, ...change };
    expect(isDecisionFresh(staleDecision, expected)).toBe(false);
    expect(checkDecisionFreshness(staleDecision, expected).fresh).toBe(false);
  });

  test("rejects a normalized ESCALATE without a reason", () => {
    expect(() =>
      decideRound(
        {
          rawDecision: {
            decision: "ESCALATE",
            confidence: 0.95,
          } as unknown as RoundDecisionRawDecision,
          validation: validation(),
          findings: [],
        },
        policy,
      ),
    ).toThrow();
  });

  test("rejects unknown freshness fields", () => {
    expect(isDecisionFreshness({ ...expected, extra: true })).toBe(false);
  });

  test("checks artifact identity, not only its path", () => {
    const changedDigest = {
      ...contextRef,
      sha256: "c".repeat(64),
    };
    expect(
      isDecisionFresh(
        { ...expected, inputRefs: [planRef, changedDigest] },
        expected,
      ),
    ).toBe(false);
  });
});
