import { describe, expect, test } from "vitest";
import type { ArtifactRef } from "../../../src/core/artifacts/references.ts";
import type { FindingEvaluation } from "../../../src/core/decisions/types.ts";
import type {
  FindingEvaluationRawDecision,
  ExecutionRoutingRawDecision,
  RoundDecisionRawDecision,
} from "../../../src/runtime/ports/jev-decision-client.ts";
import {
  FakeClarificationPort,
  FakeJevDecisionClient,
  FakePlannotatorGate,
  FakeSubagentExecutor,
  FakeValidationExecutor,
  failure,
} from "../../../tests/fakes/index.ts";
import type {
  AgentRunRequest,
  AgentRunResult,
  AgentRunStatus,
  CodeReviewStatus,
  PlanReviewStatus,
} from "../../../src/runtime/ports/index.ts";
import type { SubagentRunId, PlannotatorReviewId } from "../../../src/types.ts";

const runId = "run-1" as unknown as SubagentRunId;
const reviewId = "review-1" as unknown as PlannotatorReviewId;
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
const planEvidence = {
  summary: "A small feature with a bounded implementation scope.",
  relevantSections: [
    {
      title: "Scope / Requirements" as const,
      content: "Add the requested feature.",
    },
  ],
};
const contextEvidence = [
  { ref: contextRef, content: "Repository context from the scout artifact." },
];
const implementationRef: ArtifactRef<"implementation"> = {
  kind: "implementation",
  path: "implementations/implementation-1.json",
  schemaVersion: 1,
  sha256: "b".repeat(64),
};
const request: AgentRunRequest = { agent: "worker", task: "implement it" };
const agentResult: AgentRunResult = {
  status: "succeeded",
  runId,
  output: "completed",
};

const routing: ExecutionRoutingRawDecision = {
  modelTier: { value: "STANDARD", confidence: 0.9 },
  reasoningTier: { value: "HIGH", confidence: 0.8 },
};
const finding: FindingEvaluationRawDecision = {
  findingId: "C1",
  evidenceSupported: { value: true, confidence: 0.9 },
  conflictsWithApprovedPlan: { value: false, confidence: 0.9 },
  conflictsWithArchitecture: { value: false, confidence: 0.9 },
  inScope: { value: true, confidence: 0.9 },
  requiresHumanDecision: { value: false, confidence: 0.9 },
};
const round: RoundDecisionRawDecision = {
  decision: "COMPLETE",
  confidence: 0.9,
};
const reviewFinding = {
  id: "C1",
  source: "correctness",
  category: "regression",
  summary: "A regression",
  evidence: "Observed in the changed path.",
  blocking: true,
} as const;
const findingEvaluation: FindingEvaluation = {
  findingId: "C1",
  evidenceSupported: { value: true, confidence: 0.9 },
  conflictsWithApprovedPlan: { value: false, confidence: 0.9 },
  conflictsWithArchitecture: { value: false, confidence: 0.9 },
  inScope: { value: true, confidence: 0.9 },
  requiresHumanDecision: { value: false, confidence: 0.9 },
  decision: "ACCEPT",
  reasonCode: "accepted",
};
const routingInput = {
  approvedPlanRef: planRef,
  planEvidence,
  playbook: "feature" as const,
  changeScope: "a small feature",
  contextRefs: [contextRef],
  contextEvidence,
  priorRetryCount: 0,
};
const findingInput = {
  approvedPlanRef: planRef,
  implementationRevision: 1,
  findings: [reviewFinding],
};
const roundInput = {
  approvedPlanRef: planRef,
  implementationRevision: 1,
  validation: {
    schemaVersion: 1 as const,
    implementationRevision: 1,
    status: "passed" as const,
    checks: [{ id: "tests", status: "passed" as const }],
  },
  findings: [findingEvaluation],
};
const validationContract = {
  schemaVersion: 1 as const,
  checks: [
    {
      id: "tests",
      type: "command" as const,
      command: "pnpm test",
      cwd: ".",
      required: true,
    },
  ],
};
const clarificationRequest = {
  prompt: "Which scope is intended?",
  contextRefs: [],
};

describe("fake runtime ports", () => {
  test("injects subagent results, records calls, and exposes reconciliation status", async () => {
    const status: AgentRunStatus = {
      runId,
      status: "unknown",
      reason: "the child is no longer addressable",
    };
    const fake = new FakeSubagentExecutor({
      run: { type: "result", value: agentResult },
      runParallel: { type: "result", value: [agentResult] },
      status: { type: "result", value: status },
      resume: { type: "result", value: agentResult },
    });

    expect(await fake.run(request)).toEqual(agentResult);
    expect(await fake.runParallel([request])).toEqual([agentResult]);
    expect(await fake.status(runId)).toEqual(status);
    expect(await fake.resume(runId, "continue")).toEqual(agentResult);
    expect(fake.calls.run).toEqual([request]);
    expect(fake.calls.runParallel).toEqual([[request]]);
    expect(fake.calls.status).toEqual([runId]);
    expect(fake.calls.resume).toEqual([{ runId, task: "continue" }]);
  });

  test("injects domain failures as results and infrastructure/timeout failures as typed rejections", async () => {
    const domainFailure: AgentRunResult = {
      status: "failed",
      runId,
      error: "the task failed",
    };
    const domainFake = new FakeSubagentExecutor({
      run: { type: "result", value: domainFailure },
    });
    expect(await domainFake.run(request)).toEqual(domainFailure);

    const infrastructureFake = new FakeSubagentExecutor({
      run: failure("infrastructure", "Pi is unavailable"),
    });
    await expect(infrastructureFake.run(request)).rejects.toMatchObject({
      kind: "infrastructure",
      message: "Pi is unavailable",
    });

    const timeoutFake = new FakeSubagentExecutor({
      run: failure("timeout", "run timed out"),
    });
    await expect(timeoutFake.run(request)).rejects.toMatchObject({
      kind: "timeout",
    });
  });

  test("injects Jev decisions without exposing an external SDK type", async () => {
    const fake = new FakeJevDecisionClient({
      routeExecution: { type: "result", value: routing },
      evaluateFindings: { type: "result", value: [finding] },
      decideRound: { type: "result", value: round },
    });

    expect(await fake.routeExecution(routingInput)).toEqual(routing);
    expect(await fake.evaluateFindings(findingInput)).toEqual([finding]);
    expect(await fake.decideRound(roundInput)).toEqual(round);
    expect(fake.calls.routeExecution).toEqual([routingInput]);
    expect(fake.calls.evaluateFindings).toEqual([findingInput]);
    expect(fake.calls.decideRound).toEqual([roundInput]);
  });

  test("injects plan/code review approval, feedback, and unresolved reconciliation", async () => {
    const planStatus: PlanReviewStatus = {
      reviewId,
      planRef,
      planVersion: 1,
      status: "feedback",
      feedback: "Please clarify the rollback step.",
    };
    const codeStatus: CodeReviewStatus = {
      reviewId,
      implementationRef,
      implementationRevision: 1,
      status: "approved",
    };
    const fake = new FakePlannotatorGate({
      openPlanReview: {
        type: "result",
        value: { reviewId, planRef, planVersion: 1 },
      },
      getPlanReview: { type: "result", value: planStatus },
      openCodeReview: {
        type: "result",
        value: { reviewId, implementationRef, implementationRevision: 1 },
      },
      getCodeReview: { type: "result", value: codeStatus },
    });

    expect(await fake.openPlanReview({ planRef, planVersion: 1 })).toEqual({
      reviewId,
      planRef,
      planVersion: 1,
    });
    expect(await fake.getPlanReview(reviewId)).toEqual(planStatus);
    expect(
      await fake.openCodeReview({
        implementationRef,
        implementationRevision: 1,
      }),
    ).toEqual({ reviewId, implementationRef, implementationRevision: 1 });
    expect(await fake.getCodeReview(reviewId)).toEqual(codeStatus);
  });

  test("supports ordered retry/reconciliation outcomes across calls", async () => {
    const failed: AgentRunResult = {
      status: "failed",
      runId,
      error: "first attempt failed",
    };
    const subagent = new FakeSubagentExecutor({
      run: [
        { type: "result", value: failed },
        { type: "result", value: agentResult },
      ],
    });
    expect((await subagent.run(request)).status).toBe("failed");
    expect((await subagent.run(request)).status).toBe("succeeded");

    const unknownPlan: PlanReviewStatus = {
      reviewId,
      status: "unknown",
      reason: "review was not settled",
    };
    const planGate = new FakePlannotatorGate({
      getPlanReview: [
        { type: "result", value: unknownPlan },
        {
          type: "result",
          value: { reviewId, planRef, planVersion: 1, status: "approved" },
        },
      ],
    });
    expect((await planGate.getPlanReview(reviewId)).status).toBe("unknown");
    expect((await planGate.getPlanReview(reviewId)).status).toBe("approved");
    expect(planGate.calls.getPlanReview).toHaveLength(2);

    const jev = new FakeJevDecisionClient({
      routeExecution: failure("timeout", "Jev timed out"),
    });
    await expect(jev.routeExecution(routingInput)).rejects.toMatchObject({
      kind: "timeout",
    });

    const infrastructureValidation = new FakeValidationExecutor({
      execute: failure("infrastructure", "cannot spawn validation"),
    });
    await expect(
      infrastructureValidation.execute(validationContract),
    ).rejects.toMatchObject({ kind: "infrastructure" });
    expect(infrastructureValidation.calls).toEqual([validationContract]);

    const clarification = new FakeClarificationPort({
      request: [
        { type: "result", value: { status: "provided", answer: "feature" } },
        { type: "result", value: { status: "declined", reason: "not now" } },
      ],
    });
    expect((await clarification.request(clarificationRequest)).status).toBe(
      "provided",
    );
    expect((await clarification.request(clarificationRequest)).status).toBe(
      "declined",
    );
    expect(clarification.calls).toHaveLength(2);
  });

  test("keeps validation outcomes deterministic and allows clarification failures", async () => {
    const validation = {
      status: "failed" as const,
      checks: [{ id: "tests", status: "failed" as const, exitCode: 1 }],
    };
    const validationFake = new FakeValidationExecutor({
      execute: { type: "result", value: validation },
    });
    expect(await validationFake.execute(validationContract)).toEqual(
      validation,
    );

    const clarificationFake = new FakeClarificationPort({
      request: failure("reconciliation", "clarification is not settled"),
    });
    await expect(
      clarificationFake.request(clarificationRequest),
    ).rejects.toMatchObject({
      kind: "reconciliation",
    });
  });
});
