import { describe, expect, test, vi } from "vitest";
import {
  TypeSafeIntegrationError,
  type Evaluation,
  type EvaluationOptions,
  type Questions,
  type SystemOneRequest,
} from "pi-typesafe";
import type { ArtifactRef } from "../../../src/core/artifacts/references.ts";
import type { FindingEvaluation } from "../../../src/core/decisions/types.ts";
import {
  JevIntegration as ProductJevIntegration,
  type JevClient,
} from "../../../src/runtime/integrations/jev.ts";
import type { ExecutionRoutingInput } from "../../../src/runtime/ports/jev-decision-client.ts";

import {
  decisionEvidence,
  roundEvidence,
  reviewRefs,
} from "../../fakes/coding-scenario.ts";
import { adapterAuthorization } from "../../fakes/jev-policy.ts";
class JevIntegration extends ProductJevIntegration {
  override routeExecution(
    input: Parameters<ProductJevIntegration["routeExecution"]>[0],
  ) {
    return super.routeExecution(input, adapterAuthorization);
  }
  override evaluateFindings(
    input: Parameters<ProductJevIntegration["evaluateFindings"]>[0],
  ) {
    return super.evaluateFindings(input, adapterAuthorization);
  }
  override decideRound(
    input: Parameters<ProductJevIntegration["decideRound"]>[0],
  ) {
    return super.decideRound(input, adapterAuthorization);
  }
}
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
      content:
        "Add the requested feature without changing the public contract.",
    },
    {
      title: "Architecture / Design" as const,
      content: "Keep the runtime adapter behind the existing port.",
    },
  ],
};
const contextEvidence = [
  {
    ref: contextRef,
    content: "The repository uses TypeScript and Vitest for runtime tests.",
  },
];

function routingInput(
  overrides: Partial<ExecutionRoutingInput> = {},
): ExecutionRoutingInput {
  return {
    approvedPlanRef: planRef,
    planEvidence,
    playbook: "feature",
    changeScope: "scope",
    contextRefs: [contextRef],
    contextEvidence,
    priorRetryCount: 0,
    ...overrides,
  };
}
const finding = {
  id: "C1",
  source: "correctness" as const,
  category: "regression",
  location: "src/example.ts:10",
  summary: "The changed path regresses error handling.",
  evidence: "The error branch is no longer reached.",
  blocking: true,
};
const validation = {
  schemaVersion: 1 as const,
  implementationRevision: 1,
  status: "passed" as const,
  checks: [{ id: "tests", status: "passed" as const }],
};
const evaluatedFinding: FindingEvaluation = {
  findingId: "C1",
  evidenceSupported: { value: true, confidence: 0.91 },
  conflictsWithApprovedPlan: { value: false, confidence: 0.91 },
  conflictsWithArchitecture: { value: false, confidence: 0.91 },
  inScope: { value: true, confidence: 0.91 },
  requiresHumanDecision: { value: false, confidence: 0.91 },
  decision: "ACCEPT",
  reasonCode: "accepted",
};

function choiceAnswer(
  choice: string,
  confidence = 0.91,
): Record<string, unknown> {
  const options = [
    ["ECONOMY", "STANDARD", "STRONG"],
    ["LOW", "MEDIUM", "HIGH"],
    ["true", "false"],
    ["COMPLETE", "RETRY", "ESCALATE"],
    [
      "implementation-capability",
      "plan-conflict",
      "human-decision",
      "uncertain",
    ],
  ].find((candidate) => candidate.includes(choice)) ?? [choice];
  return {
    type: "choice",
    choice,
    confidence,
    probabilities: Object.fromEntries(
      options.map((option) => [option, option === choice ? confidence : 0]),
    ),
  };
}

function evaluation(answers: Record<string, unknown>): Evaluation<Questions> {
  return {
    answers,
    model: "jev-latest",
    usage: { input_tokens: 12, output_tokens: 0 },
    elapsedMs: 1,
  } as Evaluation<Questions>;
}

class FakeJevClient implements JevClient {
  readonly calls: Array<{
    request: SystemOneRequest<Questions>;
    options?: EvaluationOptions;
  }> = [];

  constructor(
    private readonly outcomes: readonly (Evaluation<Questions> | Error)[],
  ) {}

  async evaluate<Q extends Questions>(
    request: SystemOneRequest<Q>,
    options?: EvaluationOptions,
  ): Promise<Evaluation<Q>> {
    this.calls.push({ request, options });
    const outcome = this.outcomes[this.calls.length - 1];
    if (!outcome) throw new Error("No fake Jev outcome configured");
    if (outcome instanceof Error) throw outcome;
    return outcome as Evaluation<Q>;
  }
}

describe("JevIntegration", () => {
  test("missing Product Runtime authorization makes zero outbound requests", async () => {
    const client = new FakeJevClient([
      evaluation({
        modelTier: choiceAnswer("STANDARD"),
        reasoningTier: choiceAnswer("HIGH"),
      }),
    ]);
    await expect(
      new ProductJevIntegration({ client }).routeExecution(routingInput()),
    ).rejects.toMatchObject({ kind: "policy" });
    expect(client.calls).toHaveLength(0);
  });
  test("builds public Choice requests and normalizes all three v1 decision families", async () => {
    const client = new FakeJevClient([
      evaluation({
        modelTier: choiceAnswer("STANDARD"),
        reasoningTier: choiceAnswer("HIGH", 0.84),
      }),
      evaluation({
        evidenceSupported: choiceAnswer("true"),
        conflictsWithApprovedPlan: choiceAnswer("false"),
        conflictsWithArchitecture: choiceAnswer("false"),
        inScope: choiceAnswer("true"),
        requiresHumanDecision: choiceAnswer("false"),
      }),
      evaluation({
        decision: choiceAnswer("ESCALATE"),
        escalationReason: choiceAnswer("human-decision"),
      }),
    ]);
    const integration = new JevIntegration({ client, timeoutMs: 100 });

    await expect(
      integration.routeExecution(
        routingInput({ changeScope: "a small feature" }),
      ),
    ).resolves.toEqual({
      modelTier: { value: "STANDARD", confidence: 0.91 },
      reasoningTier: { value: "HIGH", confidence: 0.84 },
    });
    expect(client.calls[0].request.state).toMatchObject({
      approvedPlanRef: planRef,
      planEvidence,
      playbook: "feature",
      changeScope: "a small feature",
      contextRefs: [contextRef],
      contextEvidence,
      priorRetryCount: 0,
    });

    await expect(
      integration.evaluateFindings({
        evidence: decisionEvidence,
        reviewRefs,
        approvedPlanRef: planRef,
        implementationRevision: 1,
        findings: [finding],
      }),
    ).resolves.toEqual([
      {
        findingId: "C1",
        evidenceSupported: { value: true, confidence: 0.91 },
        conflictsWithApprovedPlan: { value: false, confidence: 0.91 },
        conflictsWithArchitecture: { value: false, confidence: 0.91 },
        inScope: { value: true, confidence: 0.91 },
        requiresHumanDecision: { value: false, confidence: 0.91 },
      },
    ]);

    await expect(
      integration.decideRound({
        ...roundEvidence,
        findingSummaries: [{ finding, sourceRef: reviewRefs.correctness }],
        approvedPlanRef: planRef,
        implementationRevision: 1,
        validation,
        findings: [evaluatedFinding],
      }),
    ).resolves.toEqual({
      decision: "ESCALATE",
      confidence: 0.91,
      escalationReason: "human-decision",
      escalationReasonConfidence: 0.91,
    });

    expect(client.calls[0].request.questions).toMatchObject({
      modelTier: {
        type: "choice",
        criteria: {
          ECONOMY: expect.anything(),
          STANDARD: expect.anything(),
          STRONG: expect.anything(),
        },
      },
      reasoningTier: {
        type: "choice",
        criteria: {
          LOW: expect.anything(),
          MEDIUM: expect.anything(),
          HIGH: expect.anything(),
        },
      },
    });
    expect(client.calls[1].request.state).toMatchObject({
      reviewRef: reviewRefs.correctness,
      finding: { summary: finding.summary, evidence: finding.evidence },
    });
    expect(client.calls[1].request.questions).toMatchObject({
      evidenceSupported: {
        type: "choice",
        criteria: { true: expect.anything(), false: expect.anything() },
      },
    });
    expect(client.calls[2].request.state).toMatchObject({
      findingSummaries: [{ finding, sourceRef: reviewRefs.correctness }],
    });
    expect(client.calls[2].request.questions).toMatchObject({
      decision: {
        type: "choice",
        criteria: {
          COMPLETE: expect.anything(),
          RETRY: expect.anything(),
          ESCALATE: expect.anything(),
        },
      },
    });
  });

  test("preserves a low-confidence Choice for core policy", async () => {
    const client = new FakeJevClient([
      evaluation({
        modelTier: choiceAnswer("ECONOMY", 0.2),
        reasoningTier: choiceAnswer("LOW", 0.3),
      }),
    ]);

    await expect(
      new JevIntegration({ client }).routeExecution(
        routingInput({
          playbook: "bugfix",
          changeScope: "a bug fix",
          contextRefs: [],
          contextEvidence: [],
          priorRetryCount: 1,
        }),
      ),
    ).resolves.toEqual({
      modelTier: { value: "ECONOMY", confidence: 0.2 },
      reasoningTier: { value: "LOW", confidence: 0.3 },
    });
  });

  test.each([
    [
      "missing question result",
      evaluation({ modelTier: choiceAnswer("STANDARD") }),
    ],
    [
      "unknown choice",
      evaluation({
        modelTier: choiceAnswer("UNKNOWN"),
        reasoningTier: choiceAnswer("HIGH"),
      }),
    ],
    [
      "schema mismatch",
      evaluation({
        modelTier: { type: "noul", noul: 0.9 },
        reasoningTier: choiceAnswer("HIGH"),
      }),
    ],
  ])("fails closed for %s", async (_name, outcome) => {
    const client = new FakeJevClient([outcome]);

    await expect(
      new JevIntegration({ client }).routeExecution(
        routingInput({ contextRefs: [], contextEvidence: [] }),
      ),
    ).rejects.toMatchObject({
      name: "RuntimePortError",
      kind: "infrastructure",
    });
  });

  test("normalizes authentication unavailable/rejected and budget failures without leaking SDK errors", async () => {
    const unavailable = new JevIntegration({
      createClient: () => {
        throw new TypeSafeIntegrationError("configuration", "No API key.");
      },
    });
    await expect(
      unavailable.routeExecution(
        routingInput({ contextRefs: [], contextEvidence: [] }),
      ),
    ).rejects.toMatchObject({
      kind: "infrastructure",
      name: "RuntimePortError",
    });

    const rejected = new FakeJevClient([
      new TypeSafeIntegrationError("http", "TypeSafe returned HTTP 401.", 401),
    ]);
    await expect(
      new JevIntegration({ client: rejected }).routeExecution(
        routingInput({ contextRefs: [], contextEvidence: [] }),
      ),
    ).rejects.toMatchObject({
      kind: "infrastructure",
      name: "RuntimePortError",
    });

    const budget = new FakeJevClient([
      new TypeSafeIntegrationError("budget", "daily request cap reached"),
    ]);
    await expect(
      new JevIntegration({ client: budget }).routeExecution(
        routingInput({ contextRefs: [], contextEvidence: [] }),
      ),
    ).rejects.toMatchObject({
      kind: "infrastructure",
      name: "RuntimePortError",
    });
  });

  test.each([
    ["timeout", "timeout"],
    ["transport", "connection"],
    ["API response", "response"],
  ] as const)("normalizes %s failure", async (_name, code) => {
    const client = new FakeJevClient([
      new TypeSafeIntegrationError(code, `${code} failed`),
    ]);

    await expect(
      new JevIntegration({ client }).routeExecution(
        routingInput({ contextRefs: [], contextEvidence: [] }),
      ),
    ).rejects.toMatchObject({
      kind: code === "timeout" ? "timeout" : "infrastructure",
      name: "RuntimePortError",
    });
  });

  test("rewrites the configured endpoint through the public transport option", async () => {
    const transport = vi.fn(async (input: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(
        JSON.stringify({
          model: "jev-latest",
          answers: {
            modelTier: {
              type: "choice",
              choice: "STANDARD",
              confidence: 0.91,
              probabilities: { ECONOMY: 0, STANDARD: 0.91, STRONG: 0 },
            },
            reasoningTier: {
              type: "choice",
              choice: "HIGH",
              confidence: 0.91,
              probabilities: { LOW: 0, MEDIUM: 0, HIGH: 0.91 },
            },
          },
          usage: { input_tokens: 12, output_tokens: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const previousKey = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "fixture-key";
    try {
      await expect(
        new JevIntegration({
          endpoint: "https://jev.example.test/base",
          transport,
          timeoutMs: 100,
        }).routeExecution(
          routingInput({ contextRefs: [], contextEvidence: [] }),
        ),
      ).resolves.toMatchObject({
        modelTier: { value: "STANDARD" },
        reasoningTier: { value: "HIGH" },
      });
    } finally {
      if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previousKey;
    }
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[0]).toBe(
      "https://jev.example.test/base/v1/systemone",
    );
  });

  test("retries only transport failures up to the configured bound", async () => {
    const client = new FakeJevClient([
      new TypeSafeIntegrationError("connection", "connection failed"),
      evaluation({
        modelTier: choiceAnswer("STANDARD"),
        reasoningTier: choiceAnswer("HIGH"),
      }),
    ]);

    await expect(
      new JevIntegration({ client, maxTransportRetries: 1 }).routeExecution(
        routingInput({ contextRefs: [], contextEvidence: [] }),
      ),
    ).resolves.toEqual({
      modelTier: { value: "STANDARD", confidence: 0.91 },
      reasoningTier: { value: "HIGH", confidence: 0.91 },
    });
    expect(client.calls).toHaveLength(2);

    const budget = new FakeJevClient([
      new TypeSafeIntegrationError("budget", "budget exhausted"),
      evaluation({
        modelTier: choiceAnswer("STANDARD"),
        reasoningTier: choiceAnswer("HIGH"),
      }),
    ]);
    await expect(
      new JevIntegration({
        client: budget,
        maxTransportRetries: 1,
      }).routeExecution(routingInput({ contextRefs: [], contextEvidence: [] })),
    ).rejects.toMatchObject({ kind: "infrastructure" });
    expect(budget.calls).toHaveLength(1);
  });

  test("does not call Jev for an empty finding set", async () => {
    const client = new FakeJevClient([]);

    await expect(
      new JevIntegration({ client }).evaluateFindings({
        evidence: decisionEvidence,
        reviewRefs,
        approvedPlanRef: planRef,
        implementationRevision: 1,
        findings: [],
      }),
    ).resolves.toEqual([]);
    expect(client.calls).toHaveLength(0);
  });
});
