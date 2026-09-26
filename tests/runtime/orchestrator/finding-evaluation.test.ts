import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ReviewFinding } from "../../../src/core/coding/finding.ts";
import type { FindingEvaluationRawDecision } from "../../../src/runtime/ports/jev-decision-client.ts";
import {
  isAcceptedFindingsArtifact,
  isFindingEvaluationArtifact,
  parseAcceptedFindingsArtifact,
  parseFindingEvaluationArtifact,
} from "../../../src/core/decisions/types.ts";
import { FindingEvaluationRunner } from "../../../src/runtime/orchestrator/finding-evaluation.ts";
import { ArtifactStore } from "../../../src/runtime/persistence/artifact-store.ts";
import { StateStore } from "../../../src/runtime/persistence/state-store.ts";
import { FakeJevDecisionClient, failure } from "../../fakes/index.ts";
import type { WorkflowState } from "../../../src/core/workflow/state.ts";
import type { WorkflowId } from "../../../src/types.ts";

const roots: string[] = [];
const policy = {
  autoDecisionThreshold: 0.8,
  escalationThreshold: 0.5,
};

function decision<T>(value: T, confidence = 0.95) {
  return { value, confidence };
}

function raw(
  findingId: string,
  overrides: Partial<FindingEvaluationRawDecision> = {},
) {
  return {
    findingId,
    evidenceSupported: decision(true),
    conflictsWithApprovedPlan: decision(false),
    conflictsWithArchitecture: decision(false),
    inScope: decision(true),
    requiresHumanDecision: decision(false),
    ...overrides,
  } satisfies FindingEvaluationRawDecision;
}

function finding(
  id: string,
  source: ReviewFinding["source"],
  blocking = false,
): ReviewFinding {
  return {
    id,
    source,
    category: source === "correctness" ? "regression" : "complexity",
    summary: `${id} summary`,
    evidence: `${id} evidence`,
    blocking,
  };
}

async function fixture(findings: readonly ReviewFinding[] = []) {
  const root = await mkdtemp(
    join("/tmp", "pi-orchestrator-finding-evaluation-"),
  );
  roots.push(root);
  const artifactStore = new ArtifactStore(root);
  const stateStore = new StateStore(root);
  const taskRef = await artifactStore.writeText("task", "task.md", "task");
  const planRef = await artifactStore.writeText("plan", "plan-v1.md", "plan");
  const implementationRef = await artifactStore.writeText(
    "implementation",
    "implementation-1.md",
    "implementation",
  );
  const executionRoutingRef = await artifactStore.writeText(
    "execution-routing",
    "execution-routing-1.md",
    "routing",
  );
  const validationRef = await artifactStore.writeText(
    "validation",
    "validation-1.md",
    "validation",
  );
  const correctnessReviewRef = await artifactStore.writeText(
    "correctness-review",
    "correctness-1.md",
    JSON.stringify({
      schemaVersion: 1,
      round: 1,
      source: "correctness",
      findings: findings.filter(
        (candidate) => candidate.source === "correctness",
      ),
    }),
  );
  const ponytailReviewRef = await artifactStore.writeText(
    "ponytail-review",
    "ponytail-1.md",
    JSON.stringify({
      schemaVersion: 1,
      round: 1,
      source: "ponytail",
      findings: findings.filter((candidate) => candidate.source === "ponytail"),
    }),
  );
  const state: WorkflowState = {
    schemaVersion: 1,
    workflowId: "workflow-finding-evaluation-1" as WorkflowId,
    stateRevision: 0,
    playbook: "feature",
    phase: "reviewing",
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
      reviewRound: 1,
      executionRoutingRef,
      implementationRef,
      validationRef,
      correctnessReviewRef,
      ponytailReviewRef,
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
  return {
    root,
    artifactStore,
    stateStore,
    state: await stateStore.saveState(state, 0),
    planRef,
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("FindingEvaluationRunner ORCH-015", () => {
  test("evaluates every raw finding and persists only accepted findings as Fix Authority", async () => {
    const accepted = finding("C1", "correctness", true);
    const rejected = finding("P1", "ponytail");
    const escalated = finding("C2", "correctness");
    const current = await fixture([accepted, escalated, rejected]);
    const jev = new FakeJevDecisionClient({
      evaluateFindings: {
        type: "result",
        value: [
          raw(accepted.id),
          raw(escalated.id, {
            requiresHumanDecision: decision(true),
          }),
          raw(rejected.id, {
            conflictsWithApprovedPlan: decision(true),
          }),
        ],
      },
    });

    const result = await new FindingEvaluationRunner({
      artifactStore: current.artifactStore,
      stateStore: current.stateStore,
      jevDecisionClient: jev,
      configuration: { decision: policy },
    }).execute({
      state: current.state,
      findings: [accepted, escalated, rejected],
    });

    expect(jev.calls.evaluateFindings).toEqual([
      {
        approvedPlanRef: current.planRef,
        implementationRevision: 1,
        findings: [accepted, escalated, rejected],
      },
    ]);
    expect(result.state.coding.findingEvaluationRef?.kind).toBe(
      "finding-evaluation",
    );
    expect(result.state.coding.acceptedFindingsRef?.kind).toBe(
      "accepted-findings",
    );
    expect(
      result.evaluation.findings.map(({ findingId }) => findingId),
    ).toEqual(["C1", "C2", "P1"]);
    expect(
      result.evaluation.findings.map(({ decision: outcome }) => outcome),
    ).toEqual(["ACCEPT", "ESCALATE", "REJECT"]);
    expect(result.acceptedFindings.accepted).toEqual([accepted]);
    expect(result.acceptedFindings).not.toHaveProperty("rejected");
    expect(result.acceptedFindings).not.toHaveProperty("escalated");
    expect(
      await current.artifactStore.readJson(
        result.findingEvaluationRef,
        parseFindingEvaluationArtifact,
      ),
    ).toEqual(result.evaluation);
    expect(
      await current.artifactStore.readJson(
        result.acceptedFindingsRef,
        parseAcceptedFindingsArtifact,
      ),
    ).toEqual(result.acceptedFindings);
    expect(isFindingEvaluationArtifact(result.evaluation)).toBe(true);
    expect(isAcceptedFindingsArtifact(result.acceptedFindings)).toBe(true);
  });

  test.each([
    [
      "low confidence",
      raw("C1", { evidenceSupported: decision(true, 0.79) }),
      "ESCALATE",
      "uncertain",
    ],
    [
      "approved plan conflict",
      raw("C1", { conflictsWithApprovedPlan: decision(true) }),
      "REJECT",
      "approved-plan-conflict",
    ],
    [
      "human decision",
      raw("C1", { requiresHumanDecision: decision(true) }),
      "ESCALATE",
      "human-decision",
    ],
  ] as const)(
    "does not accept %s",
    async (_name, rawDecision, expectedDecision, reasonCode) => {
      const rawFinding = finding("C1", "correctness");
      const current = await fixture([rawFinding]);
      const jev = new FakeJevDecisionClient({
        evaluateFindings: { type: "result", value: [rawDecision] },
      });

      const result = await new FindingEvaluationRunner({
        artifactStore: current.artifactStore,
        stateStore: current.stateStore,
        jevDecisionClient: jev,
        configuration: { decision: policy },
      }).execute({ state: current.state, findings: [rawFinding] });

      expect(result.evaluation.findings[0]).toMatchObject({
        findingId: rawFinding.id,
        decision: expectedDecision,
        reasonCode,
      });
      expect(result.acceptedFindings.accepted).toEqual([]);
    },
  );

  test("persists both artifacts before updating the State refs", async () => {
    const rawFinding = finding("C1", "correctness");
    const current = await fixture([rawFinding]);
    const jev = new FakeJevDecisionClient({
      evaluateFindings: { type: "result", value: [raw(rawFinding.id)] },
    });
    const realStateStore = current.stateStore;
    const stateStore = {
      saveState: async (
        state: Parameters<typeof realStateStore.saveState>[0],
        expectedRevision?: number,
      ) => {
        if (state.coding.findingEvaluationRef) {
          await expect(
            readFile(
              join(current.root, state.coding.findingEvaluationRef.path),
              "utf8",
            ),
          ).resolves.toContain(rawFinding.id);
          await expect(
            readFile(
              join(current.root, state.coding.acceptedFindingsRef!.path),
              "utf8",
            ),
          ).resolves.toContain(rawFinding.id);
        }
        return realStateStore.saveState(state, expectedRevision);
      },
    };

    await new FindingEvaluationRunner({
      artifactStore: current.artifactStore,
      stateStore,
      jevDecisionClient: jev,
      configuration: { decision: policy },
    }).execute({ state: current.state, findings: [rawFinding] });
  });

  test("blocks and does not publish authority when Jev is unavailable", async () => {
    const rawFinding = finding("C1", "correctness");
    const current = await fixture([rawFinding]);
    const jev = new FakeJevDecisionClient({
      evaluateFindings: failure("timeout", "Jev unavailable"),
    });

    await expect(
      new FindingEvaluationRunner({
        artifactStore: current.artifactStore,
        stateStore: current.stateStore,
        jevDecisionClient: jev,
        configuration: { decision: policy },
      }).execute({
        state: current.state,
        findings: [rawFinding],
      }),
    ).rejects.toThrow("Jev unavailable");
    const state = await current.stateStore.loadState();
    expect(state.phase).toBe("blocked");
    expect(state.coding.findingEvaluationRef).toBeUndefined();
    expect(state.coding.acceptedFindingsRef).toBeUndefined();
  });

  test("rejects duplicate raw IDs before calling Jev", async () => {
    const first = finding("C1", "correctness");
    const second = finding("C1", "ponytail");
    const current = await fixture([first, second]);
    const jev = new FakeJevDecisionClient({
      evaluateFindings: { type: "result", value: [] },
    });
    await expect(
      new FindingEvaluationRunner({
        artifactStore: current.artifactStore,
        stateStore: current.stateStore,
        jevDecisionClient: jev,
        configuration: { decision: policy },
      }).execute({
        state: current.state,
        findings: [first, second],
      }),
    ).rejects.toThrow(/duplicate.*finding/i);
    expect(jev.calls.evaluateFindings).toHaveLength(0);
  });

  test("does not mint Fix Authority from findings that bypass persisted review evidence", async () => {
    const supplied = finding("C1", "correctness");
    const current = await fixture();
    const jev = new FakeJevDecisionClient({
      evaluateFindings: { type: "result", value: [raw(supplied.id)] },
    });

    await expect(
      new FindingEvaluationRunner({
        artifactStore: current.artifactStore,
        stateStore: current.stateStore,
        jevDecisionClient: jev,
        configuration: { decision: policy },
      }).execute({ state: current.state, findings: [supplied] }),
    ).rejects.toThrow(/persisted review artifacts/i);
    expect(jev.calls.evaluateFindings).toHaveLength(0);
    expect(
      (await current.stateStore.loadState()).coding.acceptedFindingsRef,
    ).toBe(undefined);
  });
});
