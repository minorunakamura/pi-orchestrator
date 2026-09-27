import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { OrchestratorConfiguration } from "../../../src/core/configuration.ts";
import type { ValidationResult } from "../../../src/core/decisions/types.ts";
import type { WorkflowState } from "../../../src/core/workflow/state.ts";
import {
  assembleCodingEvidence,
  decisionFreshness,
} from "../../../src/runtime/orchestrator/coding-evidence.ts";
import { codingAuthority } from "../../../src/core/coding/authority.ts";
import { ReviewRunner } from "../../../src/runtime/orchestrator/review-runner.ts";
import { FindingEvaluationRunner } from "../../../src/runtime/orchestrator/finding-evaluation.ts";
import {
  plan,
  contract,
  succeeded,
  implementationEvidence,
} from "../../fakes/coding-scenario.ts";
import {
  FakeSubagentExecutor,
  FakeJevDecisionClient,
  failure,
} from "../../fakes/index.ts";
import { RoundDecisionRunner } from "../../../src/runtime/orchestrator/round-decision.ts";
import {
  ArtifactStore,
  createArtifactRef,
  calculateSha256,
} from "../../../src/runtime/persistence/artifact-store.ts";
import { StateStore } from "../../../src/runtime/persistence/state-store.ts";

const roots: string[] = [];
import { jevPolicy } from "../../fakes/jev-policy.ts";
const configuration: Pick<
  OrchestratorConfiguration,
  "decision" | "retries" | "jev"
> = {
  jev: jevPolicy("round-decision-workflow"),
  decision: { autoDecisionThreshold: 0.8, escalationThreshold: 0.5 },
  retries: { maxAutomatedFixRounds: 3, maxStrongerRetries: 1 },
};

const routingEvidence = {
  schemaVersion: 1,
  approvedPlanRef: createArtifactRef("plan", "plans/plan.md", plan),
  planVersion: 1,
  attempt: 1,
  priorRetryCount: 0,
  modelTier: { value: "STANDARD", confidence: 0.9 },
  reasoningTier: { value: "HIGH", confidence: 0.9 },
  effectiveConfidence: 0.9,
};
const implementationContent = JSON.stringify(
  implementationEvidence(
    routingEvidence.approvedPlanRef,
    createArtifactRef(
      "execution-routing",
      "decisions/routing.md",
      JSON.stringify(routingEvidence),
    ),
  ),
);

async function fixture(phase: "validating" | "reviewing", complete = true) {
  const root = await mkdtemp(join("/tmp", "pi-orchestrator-round-decision-"));
  roots.push(root);
  const artifactStore = new ArtifactStore(root);
  const stateStore = new StateStore(root);
  const taskRef = await artifactStore.writeText("task", "task.md", "task");
  const planRef = await artifactStore.writeText("plan", "plan.md", plan);
  const routingRef = await artifactStore.writeText(
    "execution-routing",
    "routing.md",
    JSON.stringify(routingEvidence),
  );
  const implementationRef = await artifactStore.writeText(
    "implementation",
    "implementation.md",
    implementationContent,
  );
  const validationRef = await artifactStore.writeText(
    "validation",
    "validation.md",
    JSON.stringify(validation(phase === "reviewing" ? "passed" : "failed")),
  );
  const state: WorkflowState = {
    schemaVersion: 1,
    workflowId: "round-decision-workflow" as WorkflowState["workflowId"],
    projectRoot: process.cwd(),
    jevUsage: { attemptsReserved: 0 },
    stateRevision: 0,
    playbook: "feature",
    phase,
    taskRef,
    planning: {
      context: {},
      currentPlanRef: planRef,
      currentPlanVersion: 1,
      approvedPlanRef: planRef,
      approvedPlanVersion: 1,
    },
    coding: {
      implementationRevision: 1,
      reviewRound: phase === "reviewing" ? 1 : 0,
      executionRoutingRef: routingRef,
      implementationRef,
      ...(phase === "reviewing" ? { validationRef } : {}),
    },
    counters: {
      automatedFixRoundsUsed: 0,
      strongerRetriesUsed: 0,
      humanCodeFeedbackRounds: 0,
    },
    external: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  let persisted = await stateStore.saveState(state, 0);
  if (phase === "reviewing" && complete) {
    const reviewed = await new ReviewRunner({
      artifactStore,
      stateStore,
      subagentExecutor: new FakeSubagentExecutor({
        runParallel: {
          type: "result",
          value: (["correctness", "ponytail"] as const).map(
            (source) =>
              succeeded(
                JSON.stringify({
                  schemaVersion: 1,
                  round: 1,
                  source,
                  findings: [],
                }),
              ).value,
          ),
        },
      }),
    }).execute({ state: persisted });
    persisted = (
      await new FindingEvaluationRunner({
        artifactStore,
        stateStore,
        configuration,
        jevDecisionClient: new FakeJevDecisionClient(),
      }).execute({ state: reviewed.state })
    ).state;
  }
  return { artifactStore, stateStore, state: persisted, validationRef };
}

function validation(status: ValidationResult["status"]): ValidationResult {
  return {
    schemaVersion: 1,
    implementationRevision: 1,
    status,
    checks: [{ id: "tests", status, exitCode: status === "passed" ? 0 : 1 }],
    approvedPlanRef: createArtifactRef("plan", "plans/plan.md", plan),
    planVersion: 1,
    implementationRef: createArtifactRef(
      "implementation",
      "implementation/implementation.md",
      implementationContent,
    ),
    validationContractDigest: calculateSha256(JSON.stringify(contract)),
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("RoundDecisionRunner ORCH-016", () => {
  test.each([true, false])(
    "infrastructure stop policy %s cannot launch automated Fix",
    async (stop) => {
      const f = await fixture("validating");
      const result = {
        ...validation("failed"),
        status: "infrastructure-error" as const,
        checks: [
          {
            id: "tests",
            status: "infrastructure-error" as const,
            evidence: "spawn failed",
          },
        ],
      };
      const ref = await f.artifactStore.writeText(
        "validation",
        "infrastructure.md",
        JSON.stringify(result),
      );
      const jev = new FakeJevDecisionClient({
        decideRound: {
          type: "result",
          value: { decision: "RETRY", confidence: 0.99 },
        },
      });
      const runner = new RoundDecisionRunner({
        ...f,
        configuration: {
          ...configuration,
          validation: { stopOnInfrastructureFailure: stop },
        },
        jevDecisionClient: jev,
      });
      if (stop) {
        await expect(
          runner.execute({
            state: f.state,
            validation: result,
            validationRef: ref,
          }),
        ).rejects.toThrow(/infrastructure/iu);
        expect(jev.calls.decideRound).toHaveLength(0);
        expect((await f.stateStore.loadState()).block?.reason).toBe(
          "validation-infrastructure-error",
        );
      } else {
        const round = await runner.execute({
          state: f.state,
          validation: result,
          validationRef: ref,
        });
        expect(round.state.phase).toBe("clarifying");
        expect(round.state.counters.automatedFixRoundsUsed).toBe(0);
        expect(jev.calls.decideRound[0]?.branch).toBe(
          "infrastructure-attention",
        );
      }
    },
  );
  test("denied consent blocks Round before external evaluation", async () => {
    const f = await fixture("reviewing");
    const jev = new FakeJevDecisionClient({
      decideRound: {
        type: "result",
        value: { decision: "COMPLETE", confidence: 0.99 },
      },
    });
    await expect(
      new RoundDecisionRunner({
        ...f,
        configuration: { ...configuration, jev: {} },
        jevDecisionClient: jev,
      }).execute({ state: f.state, validation: validation("passed") }),
    ).rejects.toThrow(/consent|budget/iu);
    expect(jev.calls.decideRound).toHaveLength(0);
    expect((await f.stateStore.loadState()).block?.reason).toBe(
      "operator-attention-required",
    );
  });
  test("rejects a passed round that skips reviewers and finding evaluation", async () => {
    const current = await fixture("reviewing", false);
    const jev = new FakeJevDecisionClient({
      decideRound: {
        type: "result",
        value: { decision: "COMPLETE", confidence: 0.99 },
      },
    });
    await expect(
      new RoundDecisionRunner({
        ...current,
        jevDecisionClient: jev,
        configuration,
      }).execute({ state: current.state, validation: validation("passed") }),
    ).rejects.toThrow(/review|finding/iu);
    expect(jev.calls.decideRound).toHaveLength(0);
  });
  test("persists the deterministic retry event before routing a failed validation", async () => {
    const current = await fixture("validating");
    const jev = new FakeJevDecisionClient({
      decideRound: {
        type: "result",
        value: { decision: "COMPLETE", confidence: 0.99 },
      },
    });
    const result = await new RoundDecisionRunner({
      artifactStore: current.artifactStore,
      stateStore: current.stateStore,
      jevDecisionClient: jev,
      configuration,
    }).execute({
      state: current.state,
      validation: validation("failed"),
      validationRef: current.validationRef,
      findings: [],
    });

    expect(result.decision).toEqual({
      decision: "RETRY",
      confidence: 0.99,
      reason: "validation-failed",
    });
    expect(result.event).toEqual({
      type: "RETRY_REQUIRED",
      decisionRef: result.roundDecisionRef,
      validationRef: current.validationRef,
    });
    expect(result.state.phase).toBe("fixing");
    expect(result.state.counters.automatedFixRoundsUsed).toBe(1);
    expect(result.roundDecisionRef.path).toBe("reviews/round-decision-1.json");
  });

  test("uses authoritative accepted findings to forbid REVIEW_COMPLETE", async () => {
    const current = await fixture("reviewing");
    const finding = {
      id: "C1",
      source: "correctness" as const,
      category: "regression",
      summary: "blocking finding",
      evidence: "evidence",
      blocking: true,
    };
    const correctnessReviewRef = await current.artifactStore.writeText(
      "correctness-review",
      "with-finding.md",
      JSON.stringify({
        schemaVersion: 1,
        round: 1,
        source: "correctness",
        authority: codingAuthority(current.state),
        findings: [finding],
      }),
    );
    current.state.coding.correctnessReviewRef = correctnessReviewRef;
    const evidence = await assembleCodingEvidence(
      current.artifactStore,
      current.state,
    );
    const freshness = decisionFreshness(
      current.state,
      {
        approvedPlanRef: current.state.planning.approvedPlanRef!,
        implementationRevision: 1,
        findings: [finding],
        evidence,
        reviewRefs: {
          correctness: correctnessReviewRef,
          ponytail: current.state.coding.ponytailReviewRef!,
        },
      },
      [
        current.state.planning.approvedPlanRef!,
        current.state.coding.implementationRef!,
        correctnessReviewRef,
        current.state.coding.ponytailReviewRef!,
      ],
      configuration.decision,
    );
    const evaluationRef = await current.artifactStore.writeText(
      "finding-evaluation",
      "evaluation.md",
      JSON.stringify({
        schemaVersion: 1,
        freshness,
        authority: codingAuthority(current.state),
        round: 1,
        planVersion: 1,
        implementationRevision: 1,
        approvedPlanRef: current.state.planning.approvedPlanRef,
        findings: [
          {
            findingId: "C1",
            blocking: true,
            evidenceSupported: { value: true, confidence: 0.95 },
            conflictsWithApprovedPlan: { value: false, confidence: 0.95 },
            conflictsWithArchitecture: { value: false, confidence: 0.95 },
            inScope: { value: true, confidence: 0.95 },
            requiresHumanDecision: { value: false, confidence: 0.95 },
            decision: "ACCEPT",
            reasonCode: "accepted",
          },
        ],
      }),
    );
    const acceptedRef = await current.artifactStore.writeText(
      "accepted-findings",
      "accepted.md",
      JSON.stringify({
        schemaVersion: 1,
        authority: codingAuthority(current.state),
        round: 1,
        planVersion: 1,
        implementationRevision: 1,
        approvedPlanRef: current.state.planning.approvedPlanRef,
        accepted: [finding],
      }),
    );
    const stateWithFindings = await current.stateStore.saveState(
      {
        ...current.state,
        coding: {
          ...current.state.coding,
          correctnessReviewRef,
          findingEvaluationRef: evaluationRef,
          acceptedFindingsRef: acceptedRef,
        },
      },
      current.state.stateRevision,
    );
    const jev = new FakeJevDecisionClient({
      decideRound: {
        type: "result",
        value: { decision: "COMPLETE", confidence: 0.99 },
      },
    });

    const result = await new RoundDecisionRunner({
      artifactStore: current.artifactStore,
      stateStore: current.stateStore,
      jevDecisionClient: jev,
      configuration,
    }).execute({
      state: stateWithFindings,
      validation: validation("passed"),
    });

    expect(result.decision).toMatchObject({
      decision: "RETRY",
      reason: "accepted-blocking-findings",
    });
    expect(result.event.type).toBe("REVIEW_RETRY_REQUIRED");
    expect(jev.calls.decideRound[0]?.findingSummaries).toEqual([
      { finding, sourceRef: correctnessReviewRef },
    ]);
  });

  test("rejects a write-only artifact store at the authority boundary", async () => {
    const current = await fixture("validating");
    const writeOnly = {
      writeText: current.artifactStore.writeText.bind(current.artifactStore),
    };
    await expect(
      new RoundDecisionRunner({
        artifactStore: writeOnly,
        stateStore: current.stateStore,
        jevDecisionClient: new FakeJevDecisionClient(),
        configuration,
      }).execute({
        state: current.state,
        validation: validation("failed"),
        validationRef: current.validationRef,
      }),
    ).rejects.toThrow(/authoritative validation artifact|readable/i);
  });

  test("rejects a caller profile that downgrades authoritative routing", async () => {
    const current = await fixture("reviewing");
    const jev = new FakeJevDecisionClient({
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

    await expect(
      new RoundDecisionRunner({
        artifactStore: current.artifactStore,
        stateStore: current.stateStore,
        jevDecisionClient: jev,
        configuration,
      }).execute({
        state: current.state,
        validation: validation("passed"),
        currentProfile: { modelTier: "ECONOMY", reasoningTier: "LOW" },
      }),
    ).rejects.toThrow(/profile|routing|authoritative/i);
  });

  test("persists the monotonic stronger routing before the retry event", async () => {
    const current = await fixture("reviewing");
    const jev = new FakeJevDecisionClient({
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
    const currentRouting = {
      schemaVersion: 1 as const,
      approvedPlanRef: current.state.planning.approvedPlanRef!,
      planVersion: 1,
      attempt: 1,
      priorRetryCount: 0,
      modelTier: { value: "STANDARD" as const, confidence: 0.9 },
      reasoningTier: { value: "HIGH" as const, confidence: 0.9 },
      effectiveConfidence: 0.9,
    };
    const result = await new RoundDecisionRunner({
      artifactStore: current.artifactStore,
      stateStore: current.stateStore,
      jevDecisionClient: jev,
      configuration,
    }).execute({
      state: current.state,
      validation: validation("passed"),
      findings: [],
      currentProfile: { modelTier: "STANDARD", reasoningTier: "HIGH" },
      currentRouting,
    });

    expect(result.event.type).toBe("STRONGER_RETRY_REQUIRED");
    expect(result.nextExecutionProfile).toEqual({
      modelTier: "STRONG",
      reasoningTier: "HIGH",
    });
    expect(result.state.phase).toBe("fixing");
    expect(result.state.coding.executionRoutingRef?.path).toBe(
      "decisions/execution-routing-2.json",
    );
  });

  test("blocks instead of silently continuing when Jev is unavailable", async () => {
    const current = await fixture("validating");
    const jev = new FakeJevDecisionClient({
      decideRound: failure("timeout", "Jev unavailable"),
    });

    await expect(
      new RoundDecisionRunner({
        artifactStore: current.artifactStore,
        stateStore: current.stateStore,
        jevDecisionClient: jev,
        configuration,
      }).execute({
        state: current.state,
        validation: validation("failed"),
        validationRef: current.validationRef,
        findings: [],
      }),
    ).rejects.toThrow("Jev unavailable");
    expect((await current.stateStore.loadState()).phase).toBe("blocked");
  });

  test("routes plan conflict back to planning and invalidates approval", async () => {
    const current = await fixture("reviewing");
    const jev = new FakeJevDecisionClient({
      decideRound: {
        type: "result",
        value: {
          decision: "ESCALATE",
          confidence: 0.99,
          escalationReason: "plan-conflict",
          escalationReasonConfidence: 0.99,
        },
      },
    });
    const result = await new RoundDecisionRunner({
      artifactStore: current.artifactStore,
      stateStore: current.stateStore,
      jevDecisionClient: jev,
      configuration,
    }).execute({
      state: current.state,
      validation: validation("passed"),
      findings: [],
    });

    expect(result.event.type).toBe("REPLAN_REQUIRED");
    expect(result.state.phase).toBe("planning");
    expect(result.state.planning.approvedPlanRef).toBeUndefined();
  });
});
