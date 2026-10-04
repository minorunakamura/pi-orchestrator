import { rm } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import { scenario, routing } from "../../fakes/coding-scenario.ts";
import { FakeJevDecisionClient } from "../../fakes/index.ts";
import { RoundDecisionRunner } from "../../../src/runtime/orchestrator/round-decision.ts";
import { FindingEvaluationRunner } from "../../../src/runtime/orchestrator/finding-evaluation.ts";

const roots: string[] = [];
async function setup() {
  const jev = new FakeJevDecisionClient({
    routeExecution: { type: "result", value: routing },
    decideRound: {
      type: "result",
      value: { decision: "COMPLETE", confidence: 0.99 },
    },
  });
  const current = await scenario(jev);
  roots.push(current.root);
  return { ...current, jev };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("real runners connect both Human Gates through complete empty reviews", async () => {
  const f = await setup();
  const round = await new RoundDecisionRunner(f).execute({
    state: f.evaluated.state,
    validation: f.validated.validation,
  });
  const approved = await f.coding.openCodeReview({ state: round.state });
  expect(approved.state.phase).toBe("completed");
});

test.each(["provider", "model", "timeout", "threshold"])(
  "changed %s invalidates finding evidence before Round classification",
  async (dimension) => {
    const f = await setup();
    const configuration = structuredClone(f.configuration);
    if (dimension === "provider")
      configuration.jev.classifier = { provider: "other", model: "jev-latest" };
    else if (dimension === "model")
      configuration.jev.classifier = { provider: "typesafe", model: "other" };
    else if (dimension === "timeout") configuration.jev.timeoutMs = 12345;
    else configuration.decision.autoDecisionThreshold = 0.95;
    await expect(
      new RoundDecisionRunner({ ...f, configuration }).execute({
        state: f.evaluated.state,
        validation: f.validated.validation,
      }),
    ).rejects.toThrow(/freshness/iu);
    expect(f.jev.calls.decideRound).toHaveLength(0);
  },
);

test("Round Jev receives approved constraints and retry State from artifacts", async () => {
  const f = await setup();
  await new RoundDecisionRunner(f).execute({
    state: f.evaluated.state,
    validation: f.validated.validation,
  });
  const request = f.jev.calls.decideRound[0];
  expect(request.evidence.plan.content).toContain("Preserve the public API");
  expect(request.evidence.plan.content).toContain("Keep decisions in core");
  expect(request.evidence.implementation.ref).toEqual(
    f.implementation.implementationRef,
  );
  expect(request.evidence.counters.automatedFixRoundsUsed).toBe(0);
  expect(request.evidence.previousDecision).toBeNull();
});

test("review evidence for a different implementation at the same round is rejected", async () => {
  const f = await setup();
  const raw = JSON.parse(
    await f.artifactStore.readText!(f.reviewed.correctnessReviewRef),
  );
  const stale = await f.artifactStore.writeText(
    "correctness-review",
    "stale.md",
    JSON.stringify({
      ...raw,
      authority: { ...raw.authority, implementationRevision: 99 },
    }),
  );
  const state = structuredClone(f.reviewed.state);
  state.coding.correctnessReviewRef = stale;
  await expect(
    new FindingEvaluationRunner(f).execute({ state }),
  ).rejects.toThrow(/persisted review|authority|binding/iu);
  expect(f.jev.calls.evaluateFindings).toHaveLength(0);
});

test("malformed previous decision cannot become Jev evidence even with a valid hash", async () => {
  const f = await setup();
  const ref = await f.artifactStore.writeText(
    "round-decision",
    "not-a-decision.md",
    "not a decision",
  );
  const state = structuredClone(f.reviewed.state);
  state.coding.previousRoundDecisionRef = ref;
  await expect(
    new FindingEvaluationRunner(f).execute({ state }),
  ).rejects.toThrow(/previous decision.*schema/iu);
  expect(f.jev.calls.evaluateFindings).toHaveLength(0);
});

test.each(["schema", "binding"])(
  "implementation evidence must validate its %s before Jev evaluation",
  async (mode) => {
    const f = await setup();
    const content =
      mode === "schema"
        ? "not an implementation"
        : JSON.stringify({
            ...JSON.parse(
              await f.artifactStore.readText!(
                f.implementation.implementationRef!,
              ),
            ),
            implementationRevision: 99,
          });
    const ref = await f.artifactStore.writeText(
      "implementation",
      "not-implementation.md",
      content,
    );
    const state = structuredClone(f.reviewed.state);
    state.coding.implementationRef = ref;
    for (const key of ["correctnessReviewRef", "ponytailReviewRef"] as const) {
      const review = JSON.parse(
        // Rebind each review artifact before moving to the next fixture ref.
        // oxlint-disable-next-line eslint/no-await-in-loop
        await f.artifactStore.readText!(state.coding[key]!),
      );
      const rewritten = {
        ...review,
        authority: { ...review.authority, implementationRef: ref },
      };
      Object.assign(state.coding, {
        // Write each binding before mutating State for the next reviewer.
        // oxlint-disable-next-line eslint/no-await-in-loop
        [key]: await f.artifactStore.writeText(
          state.coding[key]!.kind,
          `rebound-${key}.md`,
          JSON.stringify(rewritten),
        ),
      });
    }
    await expect(
      new FindingEvaluationRunner(f).execute({ state }),
    ).rejects.toThrow(new RegExp(`implementation.*${mode}`, "iu"));
    expect(f.jev.calls.evaluateFindings).toHaveLength(0);
  },
);

test("schema-valid future previous decision is rejected as inconsistent history", async () => {
  const f = await setup();
  const round = await new RoundDecisionRunner(f).execute({
    state: f.evaluated.state,
    validation: f.validated.validation,
  });
  const state = structuredClone(f.reviewed.state);
  state.coding.previousRoundDecisionRef = round.roundDecisionRef;
  await expect(
    new FindingEvaluationRunner(f).execute({ state }),
  ).rejects.toThrow(/previous decision history binding/iu);
  expect(f.jev.calls.evaluateFindings).toHaveLength(0);
});

test.each([
  "correctnessReviewRef",
  "ponytailReviewRef",
  "findingEvaluationRef",
  "acceptedFindingsRef",
] as const)("missing %s cannot complete a passed round", async (key) => {
  const f = await setup();
  const state = structuredClone(f.evaluated.state);
  delete state.coding[key];
  await expect(
    new RoundDecisionRunner(f).execute({
      state,
      validation: f.validated.validation,
    }),
  ).rejects.toThrow(/review|finding/iu);
  expect(f.jev.calls.decideRound).toHaveLength(0);
});

test("a Fix loop reassembles evidence and does not reuse a prior revision routing", async () => {
  const f = await setup();
  const retryJev = new FakeJevDecisionClient({
    decideRound: {
      type: "result",
      value: { decision: "RETRY", confidence: 0.99 },
    },
  });
  const retry = await new RoundDecisionRunner({
    ...f,
    jevDecisionClient: retryJev,
  }).execute({ state: f.evaluated.state, validation: f.validated.validation });
  const fixed = await f.coding.execute({ state: retry.state });
  expect(fixed.routingRef).not.toEqual(f.implementation.routingRef);
  expect(f.jev.calls.routeExecution).toHaveLength(2);
  const validated = await f.validate(fixed.state);
  const reviewed = await f.review(validated.state);
  const evaluated = await f.evaluate(reviewed.state);
  const round = await new RoundDecisionRunner(f).execute({
    state: evaluated.state,
    validation: validated.validation,
  });
  expect(round.state.phase).toBe("awaiting-code-review");
  expect(f.jev.calls.decideRound[0]?.evidence.previousDecision?.ref).toEqual(
    retry.roundDecisionRef,
  );
  expect(
    f.jev.calls.decideRound[0]?.evidence.counters.automatedFixRoundsUsed,
  ).toBe(1);
});

test("stronger retry re-evaluation cannot downgrade the required profile", async () => {
  const f = await setup();
  const strongerJev = new FakeJevDecisionClient({
    decideRound: {
      type: "result",
      value: {
        decision: "ESCALATE",
        confidence: 0.99,
        escalationReason: "implementation-capability",
        escalationReasonConfidence: 0.99,
      },
    },
  });
  const retry = await new RoundDecisionRunner({
    ...f,
    jevDecisionClient: strongerJev,
  }).execute({ state: f.evaluated.state, validation: f.validated.validation });
  const fixed = await f.coding.execute({ state: retry.state });
  expect(fixed.executionProfile.model).toBe("strong");
  expect(fixed.executionProfile.thinking).toBe("high");
  expect(fixed.state.counters.automatedFixRoundsUsed).toBe(1);
  expect(fixed.state.counters.strongerRetriesUsed).toBe(1);
});

test("Human Code Feedback keeps its authority across a fresh Fix and new Code Gate", async () => {
  const f = await setup();
  const round = await new RoundDecisionRunner(f).execute({
    state: f.evaluated.state,
    validation: f.validated.validation,
  });
  const { CodingOrchestrator } = await import(
    "../../../src/runtime/orchestrator/coding-orchestrator.ts"
  );
  const feedback = await new CodingOrchestrator({
    ...f,
    plannotatorGate: {
      ...f.plannotatorGate,
      openCodeReview: async () => ({
        approved: false,
        feedback: "Add coverage",
      }),
    },
  }).openCodeReview({ state: round.state });
  const fixed = await f.coding.execute({ state: feedback.state });
  expect(fixed.state.coding.codeReview).toBeUndefined();
  expect(fixed.state.counters.automatedFixRoundsUsed).toBe(0);
  expect(f.subagentExecutor.calls.run.at(-1)?.inputRefs).toContainEqual(
    feedback.state.coding.latestCodeReviewRef,
  );
  const validated = await f.validate(fixed.state);
  const reviewed = await f.review(validated.state);
  const evaluated = await f.evaluate(reviewed.state);
  const next = await new RoundDecisionRunner(f).execute({
    state: evaluated.state,
    validation: validated.validation,
  });
  const newGate = await f.coding.openCodeReview({ state: next.state });
  expect(newGate.state.coding.codeReview?.implementationRevision).toBe(2);
  await expect(
    f.coding.applyCodeReview({
      state: newGate.state,
      attemptId: feedback.state.coding.codeReview!.attemptId,
      result: { approved: true },
    }),
  ).rejects.toThrow();
});

test("passed validation bound to another Plan cannot authorize Round COMPLETE", async () => {
  const f = await setup();
  const validation = { ...f.validated.validation, planVersion: 99 };
  const ref = await f.artifactStore.writeText(
    "validation",
    "stale-plan.md",
    JSON.stringify(validation),
  );
  const state = structuredClone(f.evaluated.state);
  state.coding.validationRef = ref;
  await expect(
    new RoundDecisionRunner(f).execute({ state, validation }),
  ).rejects.toThrow(/validation|plan|authority/iu);
});

test("current round cannot use raw reviews whose IDs differ from evaluation", async () => {
  const f = await setup();
  const raw = JSON.parse(
    await f.artifactStore.readText!(f.reviewed.correctnessReviewRef),
  );
  const changed = await f.artifactStore.writeText(
    "correctness-review",
    "changed.md",
    JSON.stringify({
      ...raw,
      findings: [
        {
          id: "hidden",
          source: "correctness",
          category: "bug",
          summary: "hidden",
          evidence: "hidden",
          blocking: true,
        },
      ],
    }),
  );
  const state = structuredClone(f.evaluated.state);
  state.coding.correctnessReviewRef = changed;
  await expect(
    new RoundDecisionRunner(f).execute({
      state,
      validation: f.validated.validation,
    }),
  ).rejects.toThrow(/finding|review|fresh/iu);
});
