import { expect, test } from "vitest";
import {
  isArtifactRef,
  parseArtifactRef,
} from "../../src/core/artifacts/references.ts";
import {
  isReviewFinding,
  parseReviewFinding,
} from "../../src/core/coding/finding.ts";
import {
  isExecutionRoutingDecision,
  isFindingEvaluation,
  isRoundDecision,
  parseExecutionRoutingDecision,
  parseFindingEvaluation,
  parseRoundDecision,
  parseValidationContract,
  parseValidationResult,
} from "../../src/core/decisions/types.ts";
import {
  isWorkflowEvent,
  isWorkflowState,
  parseWorkflowEvent,
  parseWorkflowState,
} from "../../src/core/workflow/state.ts";

const hash = "a".repeat(64);

const taskRef = {
  kind: "task",
  path: "context/task.json",
  schemaVersion: 1,
  sha256: hash,
} as const;

const planRef = {
  kind: "plan",
  path: "plans/plan-v1.md",
  schemaVersion: 1,
  sha256: hash,
} as const;

const state = {
  schemaVersion: 1,
  workflowId: "workflow-1",
  stateRevision: 0,
  playbook: "feature",
  phase: "planning",
  taskRef,
  planning: {
    context: {
      scoutRef: {
        kind: "scout",
        path: "context/scout.md",
        schemaVersion: 1,
        sha256: hash,
      },
    },
    currentPlanRef: planRef,
    currentPlanVersion: 1,
  },
  coding: {
    implementationRevision: 0,
    reviewRound: 0,
  },
  counters: {
    automatedFixRoundsUsed: 0,
    strongerRetriesUsed: 0,
    humanCodeFeedbackRounds: 0,
  },
  external: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as const;

test("accepts a valid artifact reference and rejects unknown kinds", () => {
  expect(isArtifactRef(taskRef)).toBe(true);
  expect(parseArtifactRef(taskRef)).toEqual(taskRef);
  expect(isArtifactRef({ ...taskRef, kind: "future-artifact" })).toBe(false);
  expect(() =>
    parseArtifactRef({ ...taskRef, kind: "future-artifact" }),
  ).toThrow();
});

test("accepts a state that stores references and rejects invalid required enums", () => {
  expect(isWorkflowState(state)).toBe(true);
  expect(parseWorkflowState(state)).toEqual(state);
  expect(isWorkflowState({ ...state, phase: "future-phase" })).toBe(false);
  expect(() =>
    parseWorkflowState({ ...state, phase: "future-phase" }),
  ).toThrow();
});

test("preserves event union validation and rejects malformed event payloads", () => {
  const event = { type: "PLAN_APPROVED", planRef, version: 1 } as const;
  expect(isWorkflowEvent(event)).toBe(true);
  expect(parseWorkflowEvent(event)).toEqual(event);
  expect(isWorkflowEvent({ type: "PLAN_APPROVED", planRef })).toBe(false);
});

test("validates structured findings independently from fix authority", () => {
  const finding = {
    id: "C1",
    source: "correctness",
    category: "regression",
    summary: "A regression",
    evidence: "Observed in the changed path.",
    blocking: true,
  } as const;
  expect(isReviewFinding(finding)).toBe(true);
  expect(parseReviewFinding(finding)).toEqual(finding);
  expect(isReviewFinding({ ...finding, source: "unknown" })).toBe(false);
});

test("validates decision and validation contracts at runtime", () => {
  const routing = {
    modelTier: { value: "STANDARD", confidence: 0.9 },
    reasoningTier: { value: "HIGH", confidence: 0.8 },
    effectiveConfidence: 0.8,
  } as const;
  const evaluation = {
    findingId: "C1",
    evidenceSupported: { value: true, confidence: 0.9 },
    conflictsWithApprovedPlan: { value: false, confidence: 0.9 },
    conflictsWithArchitecture: { value: false, confidence: 0.9 },
    inScope: { value: true, confidence: 0.9 },
    requiresHumanDecision: { value: false, confidence: 0.9 },
    decision: "ACCEPT",
    reasonCode: "accepted",
  } as const;
  const round = {
    decision: "RETRY",
    confidence: 0.9,
    reason: "accepted-blocking-findings",
  } as const;
  const contract = {
    schemaVersion: 1,
    checks: [
      {
        id: "unit-tests",
        type: "command",
        command: "pnpm test",
        cwd: ".",
        required: true,
        timeoutMs: 120_000,
      },
    ],
  } as const;
  const result = {
    schemaVersion: 1,
    implementationRevision: 1,
    status: "passed",
    checks: [{ id: "unit-tests", status: "passed" }],
  } as const;

  expect(isExecutionRoutingDecision(routing)).toBe(true);
  expect(isFindingEvaluation(evaluation)).toBe(true);
  expect(isRoundDecision(round)).toBe(true);
  expect(parseExecutionRoutingDecision(routing)).toEqual(routing);
  expect(parseFindingEvaluation(evaluation)).toEqual(evaluation);
  expect(parseRoundDecision(round)).toEqual(round);
  expect(parseValidationContract(contract)).toEqual(contract);
  expect(parseValidationResult(result)).toEqual(result);
  expect(isRoundDecision({ ...round, confidence: 2 })).toBe(false);
  expect(isRoundDecision({ decision: "ESCALATE", confidence: 0.9 })).toBe(
    false,
  );
  expect(() =>
    parseRoundDecision({ decision: "ESCALATE", confidence: 0.9 }),
  ).toThrow();
  expect(() =>
    parseValidationContract({
      ...contract,
      checks: [{ ...contract.checks[0], type: "script" }],
    }),
  ).toThrow();
  expect(() =>
    parseValidationResult({ ...result, status: "unknown" }),
  ).toThrow();
});
