import { describe, expect, test, vi } from "vitest";
import {
  JevIntegration,
  PiClassifierDecisionClient,
} from "../../../src/runtime/integrations/jev.ts";
import {
  classification,
  FakeClassifierRuntime,
  nativeRuntime,
  firstChoices,
} from "../../fakes/classifier.ts";
import { adapterAuthorization } from "../../fakes/jev-policy.ts";
import { makeInvalidPayload } from "../../fakes/typed-boundaries.ts";
import {
  decisionEvidence,
  roundEvidence,
  reviewRefs,
} from "../../fakes/coding-scenario.ts";
import type { ClassifierResult } from "@earendil-works/pi-ai";
import type {
  ExecutionRoutingInput,
  ConditionalStageRoutingInput,
} from "../../../src/runtime/ports/jev-decision-client.ts";

const routingInput: ExecutionRoutingInput = {
  approvedPlanRef: decisionEvidence.plan.ref,
  planEvidence: { summary: "approved scope", relevantSections: [] },
  playbook: "feature",
  changeScope: "scope",
  contextRefs: [],
  contextEvidence: [],
  priorRetryCount: 0,
};
const planningInput = {
  playbook: "feature" as const,
  inputRefs: [decisionEvidence.plan.ref],
  evidence: { facts: "bounded facts" },
};
function answer(choice: string, allowed: string[], confidence = 0.91) {
  return {
    type: "choice",
    choice,
    confidence,
    probabilities: Object.fromEntries(
      allowed.map((value) => [
        value,
        value === choice ? confidence : (1 - confidence) / (allowed.length - 1),
      ]),
    ),
  };
}
const routeResult = classification({
  modelTier: answer("STANDARD", ["ECONOMY", "STANDARD", "STRONG"]),
  reasoningTier: answer("HIGH", ["LOW", "MEDIUM", "HIGH"], 0.84),
});
const finding = {
  id: "C1",
  source: "correctness" as const,
  category: "regression",
  summary: "bug",
  evidence: "proof",
  blocking: true,
};
const findingInput = {
  evidence: decisionEvidence,
  reviewRefs,
  approvedPlanRef: decisionEvidence.plan.ref,
  implementationRevision: 1,
  findings: [finding],
};
const roundInput = {
  ...roundEvidence,
  approvedPlanRef: decisionEvidence.plan.ref,
  implementationRevision: 1,
  findings: [],
  validation: {
    schemaVersion: 1 as const,
    implementationRevision: 1,
    status: "passed" as const,
    checks: [],
  },
};

describe("PiClassifierDecisionClient", () => {
  test("released JevIntegration name is the same native adapter", () =>
    expect(JevIntegration).toBe(PiClassifierDecisionClient));
  test("missing authorization or scope mismatch makes zero classifier calls", async () => {
    const registry = new FakeClassifierRuntime([routeResult]);
    const adapter = new JevIntegration({ modelRegistry: registry });
    await expect(adapter.routeExecution(routingInput)).rejects.toMatchObject({
      kind: "policy",
    });
    await expect(
      adapter.routeExecution(routingInput, {
        ...adapterAuthorization,
        authorizeAttempt: async () => {
          throw Error("denied");
        },
      }),
    ).rejects.toThrow("denied");
    await expect(
      adapter.routeExecution(routingInput, {
        ...adapterAuthorization,
        destination: "other/jev-latest",
      }),
    ).rejects.toMatchObject({ kind: "policy" });
    expect(registry.calls).toHaveLength(0);
  });
  test("all six bounded families use native Choice, preserve evidence, confidence and probabilities", async () => {
    const registry = nativeRuntime(async (_model, request, options) => {
      expect(options?.maxRetries).toBe(0);
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      return firstChoices(request);
    });
    const classify = vi.spyOn(registry, "classify");
    const reserve = vi.fn((attempt) =>
      adapterAuthorization.authorizeAttempt(attempt),
    );
    const record = vi.fn((usage) => adapterAuthorization.recordUsage(usage));
    const authorization = {
      ...adapterAuthorization,
      authorizeAttempt: reserve,
      recordUsage: record,
    };
    const adapter = new JevIntegration({ modelRegistry: registry });
    await expect(
      adapter.routeStage(
        { ...planningInput, stage: "research", policy: "conditional" },
        authorization,
      ),
    ).resolves.toEqual({ value: "RUN", confidence: 0.9 });
    await expect(
      adapter.routeClarification(planningInput, authorization),
    ).resolves.toEqual({ value: "SKIP", confidence: 0.9 });
    await expect(
      adapter.routeDevelopmentMethod(planningInput, authorization),
    ).resolves.toEqual({ value: "STANDARD", confidence: 0.9 });
    await adapter.routeExecution(routingInput, authorization);
    await adapter.evaluateFindings(findingInput, authorization);
    await adapter.decideRound(roundInput, authorization);
    expect(classify).toHaveBeenCalledTimes(6);
    expect(reserve.mock.calls.map(([attempt]) => attempt.family)).toEqual([
      "stage",
      "clarification",
      "method",
      "routing",
      "finding",
      "round",
    ]);
    for (const [index, [attempt]] of reserve.mock.calls.entries()) {
      expect(attempt).toMatchObject({
        destination: "typesafe/jev-latest",
        requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        configurationDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        decisionSchemaVersion: 1,
      });
      expect(reserve.mock.invocationCallOrder[index]).toBeLessThan(
        classify.mock.invocationCallOrder[index],
      );
      expect(record.mock.calls[index][0]).toMatchObject({
        answers: expect.any(Object),
        inputTokens: 12,
        outputTokens: 1,
      });
    }
    expect(classify.mock.calls[0][1].state).toEqual({
      ...planningInput,
      stage: "research",
      policy: "conditional",
    });
    expect(classify.mock.calls[3][1].state).toEqual(routingInput);
    expect(classify.mock.calls[4][1].state).toMatchObject({
      finding,
      reviewRef: reviewRefs.correctness,
      evidence: decisionEvidence,
    });
    expect(classify.mock.calls[4][1].questions.evidenceSupported).toMatchObject(
      {
        type: "choice",
        criteria: { true: expect.any(String), false: expect.any(String) },
      },
    );
    expect(classify.mock.calls[5][1].state).toMatchObject(roundInput);
  });
  test("required/skip policy is never sent to the classifier", async () => {
    const registry = new FakeClassifierRuntime([]);
    for (const policy of ["required", "skip"]) {
      // Check each forbidden deterministic policy independently.
      // oxlint-disable-next-line eslint/no-await-in-loop
      await expect(
        new JevIntegration({ modelRegistry: registry }).routeStage(
          makeInvalidPayload<ConditionalStageRoutingInput>({
            ...planningInput,
            stage: "research",
            policy,
          }),
          adapterAuthorization,
        ),
      ).rejects.toMatchObject({ kind: "policy" });
    }
    expect(registry.calls).toHaveLength(0);
  });
  test.each(["plan-review", "code-review", "unknown"])(
    "stage routing rejects %s before dispatch",
    async (stage) => {
      const registry = new FakeClassifierRuntime([]);
      await expect(
        new JevIntegration({ modelRegistry: registry }).routeStage(
          makeInvalidPayload<ConditionalStageRoutingInput>({
            ...planningInput,
            stage,
            policy: "conditional",
          }),
          adapterAuthorization,
        ),
      ).rejects.toMatchObject({ kind: "policy" });
      expect(registry.calls).toHaveLength(0);
    },
  );
  test("low confidence and separate escalation reason confidence stay under core policy", async () => {
    const registry = new FakeClassifierRuntime([
      routeResult,
      classification({
        decision: answer("ESCALATE", ["COMPLETE", "RETRY", "ESCALATE"], 0.9),
        escalationReason: answer(
          "human-decision",
          [
            "implementation-capability",
            "plan-conflict",
            "human-decision",
            "uncertain",
          ],
          0.2,
        ),
      }),
    ]);
    const adapter = new JevIntegration({ modelRegistry: registry });
    await expect(
      adapter.routeExecution(routingInput, adapterAuthorization),
    ).resolves.toEqual({
      modelTier: { value: "STANDARD", confidence: 0.91 },
      reasoningTier: { value: "HIGH", confidence: 0.84 },
    });
    await expect(
      adapter.decideRound(roundInput, adapterAuthorization),
    ).resolves.toMatchObject({
      confidence: 0.9,
      escalationReasonConfidence: 0.2,
    });
  });
  test.each([
    ["error", { stopReason: "error" }],
    ["aborted", { stopReason: "aborted" }],
    ["provider", { provider: "other" }],
    ["model", { model: "other" }],
    ["api", { api: "other" }],
    ["partial", { answers: { modelTier: routeResult.answers.modelTier } }],
    [
      "unexpected",
      {
        answers: {
          ...routeResult.answers,
          extra: routeResult.answers.modelTier,
        },
      },
    ],
    [
      "Bool is not confidence",
      {
        answers: {
          ...routeResult.answers,
          modelTier: { type: "bool", probability: 0.99 },
        },
      },
    ],
    [
      "invalid probabilities",
      {
        answers: {
          ...routeResult.answers,
          modelTier: {
            ...routeResult.answers.modelTier,
            probabilities: { STANDARD: 1 },
          },
        },
      },
    ],
    [
      "unknown choice",
      {
        answers: {
          ...routeResult.answers,
          modelTier: { ...routeResult.answers.modelTier, choice: "UNKNOWN" },
        },
      },
    ],
  ])("rejects %s without fallback/retry", async (name, patch) => {
    const registry = new FakeClassifierRuntime([
      makeInvalidPayload<ClassifierResult>({ ...routeResult, ...patch }),
      makeInvalidPayload<ClassifierResult>({ ...routeResult, ...patch }),
    ]);
    await expect(
      new JevIntegration({
        modelRegistry: registry,
        maxTransportRetries: 1,
      }).routeExecution(routingInput, adapterAuthorization),
    ).rejects.toMatchObject({
      kind: name === "aborted" ? "timeout" : "infrastructure",
    });
    // Aborted requests may retry, but an unknown result is not a second evaluator.
    expect(registry.calls).toHaveLength(name === "aborted" ? 2 : 1);
  });
  test("unavailable registry/auth and thrown provider errors fail closed, never leak secrets", async () => {
    const registry = new FakeClassifierRuntime([Error("Bearer secret")]);
    await expect(
      new JevIntegration({ modelRegistry: registry }).routeExecution(
        routingInput,
        adapterAuthorization,
      ),
    ).rejects.toMatchObject({
      kind: "infrastructure",
      message: "Pi classifier request failed",
    });
    await expect(
      new JevIntegration().routeExecution(routingInput, adapterAuthorization),
    ).rejects.toMatchObject({ kind: "infrastructure" });
  });
  test("provider lookup failures also normalize without leaking credentials", async () => {
    const registry = new FakeClassifierRuntime([]);
    vi.spyOn(registry, "findOfType").mockImplementation(() => {
      throw Error("Bearer secret");
    });
    await expect(
      new JevIntegration({ modelRegistry: registry }).routeExecution(
        routingInput,
        adapterAuthorization,
      ),
    ).rejects.toMatchObject({
      kind: "infrastructure",
      message: "Pi classifier request failed",
    });
    expect(registry.calls).toHaveLength(0);
  });
  test("finite deadline rejects even an uncooperative classifier, late results have no authority", async () => {
    let finish: ((result: ClassifierResult) => void) | undefined;
    const registry = nativeRuntime(
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const record = vi.fn();
    await expect(
      new JevIntegration({
        modelRegistry: registry,
        timeoutMs: 10,
      }).routeExecution(routingInput, {
        ...adapterAuthorization,
        recordUsage: record,
      }),
    ).rejects.toMatchObject({ kind: "timeout" });
    finish?.(routeResult);
    await Promise.resolve();
    expect(record).not.toHaveBeenCalled();
  });
  test("usage persistence failure never returns a decision", async () => {
    const registry = new FakeClassifierRuntime([routeResult]);
    await expect(
      new JevIntegration({ modelRegistry: registry }).routeExecution(
        routingInput,
        {
          ...adapterAuthorization,
          recordUsage: async () => {
            throw Error("disk full");
          },
        },
      ),
    ).rejects.toThrow("disk full");
  });
  test("missing token usage is not fabricated; empty findings make no call", async () => {
    const record = vi.fn();
    const registry = new FakeClassifierRuntime([
      { ...routeResult, usage: undefined },
    ]);
    const adapter = new JevIntegration({ modelRegistry: registry });
    await adapter.routeExecution(routingInput, {
      ...adapterAuthorization,
      recordUsage: record,
    });
    expect(record.mock.calls[0][0]).not.toHaveProperty("inputTokens");
    await expect(
      adapter.evaluateFindings({ ...findingInput, findings: [] }),
    ).resolves.toEqual([]);
    expect(registry.calls).toHaveLength(1);
  });
});
