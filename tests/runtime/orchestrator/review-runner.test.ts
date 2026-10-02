import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  parseValidationResult,
  type ValidationResult,
} from "../../../src/core/decisions/types.ts";
import type { ReviewFinding } from "../../../src/core/coding/finding.ts";
import type { WorkflowState } from "../../../src/core/workflow/state.ts";
import { ArtifactStore } from "../../../src/runtime/persistence/artifact-store.ts";
import { StateStore } from "../../../src/runtime/persistence/state-store.ts";
import { FakeSubagentExecutor, failure } from "../../fakes/index.ts";
import type { AgentRunResult } from "../../../src/runtime/ports/index.ts";
import { subagentRunId, workflowId } from "../../../src/types.ts";
import {
  ReviewRunner,
  parseReviewArtifact,
  type ReviewArtifact,
} from "../../../src/runtime/orchestrator/review-runner.ts";

import { plan, contract } from "../../fakes/coding-scenario.ts";
import { calculateSha256 } from "../../../src/runtime/persistence/artifact-store.ts";
const roots: string[] = [];
const runId = subagentRunId("review-run-1");

const validation: ValidationResult = {
  schemaVersion: 1,
  implementationRevision: 1,
  status: "passed",
  checks: [{ id: "tests", status: "passed", exitCode: 0 }],
};

function finding(
  source: ReviewFinding["source"],
  id: string,
  blocking = false,
): ReviewFinding {
  return {
    id,
    source,
    category: source === "ponytail" ? "over-engineering" : "regression",
    summary: `${id} summary`,
    evidence: `${id} evidence`,
    blocking,
  };
}

function output(
  source: ReviewArtifact["source"],
  findings: readonly ReviewFinding[],
): string {
  return JSON.stringify({
    schemaVersion: 1,
    round: 1,
    source,
    findings,
  });
}

function succeeded(outputText: string): AgentRunResult {
  return { status: "succeeded", runId, output: outputText };
}

async function fixture() {
  const root = await mkdtemp(join("/tmp", "pi-orchestrator-review-"));
  roots.push(root);
  const artifactStore = new ArtifactStore(root);
  const stateStore = new StateStore(root);
  const taskRef = await artifactStore.writeText("task", "task.md", "task");
  const planRef = await artifactStore.writeText("plan", "plan-v1.md", plan);
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
  const validationRef = await artifactStore.writeJson(
    "validation",
    "validation-1.json",
    {
      ...validation,
      approvedPlanRef: planRef,
      planVersion: 1,
      implementationRef,
      validationContractDigest: calculateSha256(JSON.stringify(contract)),
    },
    parseValidationResult,
  );
  const state: WorkflowState = {
    schemaVersion: 1,
    workflowId: workflowId("workflow-review-1"),
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
    refs: { taskRef, planRef, implementationRef, validationRef },
  };
}

function makeRunner(
  current: Awaited<ReturnType<typeof fixture>>,
  executor: FakeSubagentExecutor,
) {
  return new ReviewRunner({
    artifactStore: current.artifactStore,
    stateStore: current.stateStore,
    subagentExecutor: executor,
  });
}

async function expectMissing(path: string): Promise<void> {
  await expect(readFile(path, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ReviewRunner ORCH-014", () => {
  test("reuses only exact historical review contracts and receipts without new fanout", async () => {
    const current = await fixture();
    const results = [
      succeeded(output("correctness", [])),
      succeeded(output("ponytail", [])),
    ];
    const executor = new FakeSubagentExecutor({
      runParallel: { type: "result", value: results },
      status: results.map((result) => ({
        type: "result" as const,
        value: { runId, status: "succeeded" as const, result },
      })),
    });
    const runner = makeRunner(current, executor);
    await runner.execute({ state: current.state });
    const historical = await current.stateStore.loadState();
    const resumed = await runner.execute({ state: historical });
    expect(resumed.state.phase).toBe("reviewing");
    expect(executor.calls.runParallel).toHaveLength(1);
    expect(executor.calls.status).toHaveLength(2);
  });
  test("rejects an explicit stale reviewer binding instead of relabeling it as current", async () => {
    const current = await fixture();
    const stale = {
      workflowId: current.state.workflowId,
      approvedPlanRef: current.state.planning.approvedPlanRef!,
      planVersion: 1,
      implementationRef: {
        ...current.state.coding.implementationRef!,
        sha256: "f".repeat(64),
      },
      implementationRevision: 1,
    };
    const executor = new FakeSubagentExecutor({
      runParallel: {
        type: "result",
        value: [
          succeeded(
            JSON.stringify({
              ...JSON.parse(output("correctness", [])),
              authority: stale,
            }),
          ),
          succeeded(output("ponytail", [])),
        ],
      },
    });
    await expect(
      makeRunner(current, executor).execute({ state: current.state }),
    ).rejects.toThrow(/authority|binding/iu);
    const persisted = await current.stateStore.loadState();
    expect(persisted.phase).toBe("blocked");
    expect(persisted.coding.correctnessReviewRef).toBeUndefined();
  });
  test("runs the fixed reviewer set through runParallel with fresh review inputs and persists clean artifacts separately", async () => {
    const current = await fixture();
    const executor = new FakeSubagentExecutor({
      runParallel: {
        type: "result",
        value: [
          succeeded(output("correctness", [])),
          succeeded(output("ponytail", [])),
        ],
      },
    });

    const result = await makeRunner(current, executor).execute({
      state: current.state,
      cwd: current.root,
    });

    expect(executor.calls.run).toHaveLength(0);
    expect(executor.calls.runParallel).toHaveLength(1);
    expect(executor.calls.runParallel[0]?.map(({ agent }) => agent)).toEqual([
      "reviewer",
      "ponytail-reviewer",
    ]);
    expect(
      executor.calls.runParallel[0]?.every(({ inputRefs }) =>
        inputRefs?.every((ref) => ref.kind !== "accepted-findings"),
      ),
    ).toBe(true);
    expect(result.correctnessReviewRef.path).toBe("reviews/correctness-1.json");
    expect(result.ponytailReviewRef.path).toBe("reviews/ponytail-1.json");
    expect(result.state.phase).toBe("reviewing");
    expect(result.state.coding.correctnessReviewRef).toEqual(
      result.correctnessReviewRef,
    );
    expect(result.state.coding.ponytailReviewRef).toEqual(
      result.ponytailReviewRef,
    );
    await expect(current.stateStore.loadState()).resolves.toMatchObject({
      coding: {
        correctnessReviewRef: result.correctnessReviewRef,
        ponytailReviewRef: result.ponytailReviewRef,
      },
    });
    expect(
      await current.artifactStore.readJson(
        result.correctnessReviewRef,
        parseReviewArtifact,
      ),
    ).toMatchObject({
      schemaVersion: 1,
      round: 1,
      source: "correctness",
      findings: [],
    });
    expect(
      await current.artifactStore.readJson(
        result.ponytailReviewRef,
        parseReviewArtifact,
      ),
    ).toMatchObject({
      schemaVersion: 1,
      round: 1,
      source: "ponytail",
      findings: [],
    });
  });

  test("validates and keeps findings, including blocking as evidence only", async () => {
    const current = await fixture();
    const correctness = finding("correctness", "C1", true);
    const ponytail = finding("ponytail", "P1");
    const executor = new FakeSubagentExecutor({
      runParallel: {
        type: "result",
        value: [
          succeeded(output("correctness", [correctness])),
          succeeded(output("ponytail", [ponytail])),
        ],
      },
    });

    const result = await makeRunner(current, executor).execute({
      state: current.state,
    });

    expect(result.findings).toEqual([correctness, ponytail]);
    expect(result.state.coding.acceptedFindingsRef).toBeUndefined();
    const content = await current.artifactStore.readText(
      result.correctnessReviewRef,
    );
    expect(JSON.parse(content).findings).toEqual([correctness]);
  });

  test("fails closed when review artifact State persistence fails", async () => {
    const current = await fixture();
    const executor = new FakeSubagentExecutor({
      runParallel: {
        type: "result",
        value: [
          succeeded(output("correctness", [])),
          succeeded(output("ponytail", [])),
        ],
      },
    });
    const realStateStore = current.stateStore;
    const stateStore = {
      saveState: async (
        state: Parameters<typeof realStateStore.saveState>[0],
        expectedRevision?: number,
      ) => {
        if (state.coding.correctnessReviewRef) {
          throw new Error("review State disk failure");
        }
        return realStateStore.saveState(state, expectedRevision);
      },
    };

    await expect(
      new ReviewRunner({
        artifactStore: current.artifactStore,
        stateStore,
        subagentExecutor: executor,
      }).execute({ state: current.state }),
    ).rejects.toThrow("review State disk failure");
    expect((await current.stateStore.loadState()).phase).toBe("failed");
    expect((await current.stateStore.loadState()).failure?.reason).toBe(
      "persistence-consistency-failure",
    );
  });

  test("does not run reviewers before a persisted validation pass", async () => {
    const current = await fixture();
    const executor = new FakeSubagentExecutor({
      runParallel: {
        type: "result",
        value: [
          succeeded(output("correctness", [])),
          succeeded(output("ponytail", [])),
        ],
      },
    });
    const validating = structuredClone(current.state);
    validating.phase = "validating";

    await expect(
      makeRunner(current, executor).execute({ state: validating }),
    ).rejects.toThrow(/reviewing/iu);
    expect(executor.calls.runParallel).toHaveLength(0);
  });

  test("blocks instead of treating an invalid structured finding as clean", async () => {
    const current = await fixture();
    const invalid = JSON.stringify({
      schemaVersion: 1,
      round: 1,
      source: "correctness",
      findings: [{ id: "C1", blocking: true }],
    });
    const executor = new FakeSubagentExecutor({
      runParallel: {
        type: "result",
        value: [succeeded(invalid), succeeded(output("ponytail", []))],
      },
    });

    await expect(
      makeRunner(current, executor).execute({ state: current.state }),
    ).rejects.toThrow(/ReviewFinding|review artifact/iu);
    expect((await current.stateStore.loadState()).phase).toBe("blocked");
    await expectMissing(join(current.root, "reviews", "correctness-1.json"));
    await expectMissing(join(current.root, "reviews", "ponytail-1.json"));
  });

  test("blocks on a partial reviewer failure and never returns a clean result", async () => {
    const current = await fixture();
    const executor = new FakeSubagentExecutor({
      runParallel: {
        type: "result",
        value: [
          succeeded(output("correctness", [])),
          {
            status: "failed",
            runId,
            error: "ponytail reviewer unavailable",
          },
        ],
      },
    });

    await expect(
      makeRunner(current, executor).execute({ state: current.state }),
    ).rejects.toThrow(/ponytail|reviewer|failed/iu);
    expect((await current.stateStore.loadState()).phase).toBe("blocked");
    await expectMissing(join(current.root, "reviews", "correctness-1.json"));
    await expectMissing(join(current.root, "reviews", "ponytail-1.json"));
  });

  test("fails closed before fanout when an authoritative review input is missing", async () => {
    const current = await fixture();
    const state = structuredClone(current.state);
    const stalePlanRef = {
      ...state.planning.approvedPlanRef!,
      sha256: "f".repeat(64),
    };
    state.planning.currentPlanRef = stalePlanRef;
    state.planning.approvedPlanRef = stalePlanRef;
    const executor = new FakeSubagentExecutor({
      runParallel: {
        type: "result",
        value: [
          succeeded(output("correctness", [])),
          succeeded(output("ponytail", [])),
        ],
      },
    });

    await expect(
      makeRunner(current, executor).execute({ state }),
    ).rejects.toThrow(/authoritative|artifact|plan/iu);
    expect(executor.calls.runParallel).toHaveLength(0);
    expect((await current.stateStore.loadState()).phase).toBe("failed");
  });

  test("blocks when runParallel itself reports infrastructure failure", async () => {
    const current = await fixture();
    const executor = new FakeSubagentExecutor({
      runParallel: failure("infrastructure", "parallel reviewer unavailable"),
    });

    await expect(
      makeRunner(current, executor).execute({ state: current.state }),
    ).rejects.toThrow("parallel reviewer unavailable");
    expect((await current.stateStore.loadState()).phase).toBe("blocked");
    expect(
      await readdir(join(current.root, "reviews")).catch(() => []),
    ).toEqual([]);
  });

  test("rejects duplicate finding IDs across reviewers before persistence", async () => {
    const current = await fixture();
    const executor = new FakeSubagentExecutor({
      runParallel: {
        type: "result",
        value: [
          succeeded(output("correctness", [finding("correctness", "C1")])),
          succeeded(output("ponytail", [finding("ponytail", "C1")])),
        ],
      },
    });

    await expect(
      makeRunner(current, executor).execute({ state: current.state }),
    ).rejects.toThrow(/duplicate.*finding.*ID/iu);
    expect((await current.stateStore.loadState()).phase).toBe("blocked");
    await expectMissing(join(current.root, "reviews", "correctness-1.json"));
    await expectMissing(join(current.root, "reviews", "ponytail-1.json"));
  });

  test("rejects a generic reviewer result mislabeled as ponytail evidence", async () => {
    const current = await fixture();
    const executor = new FakeSubagentExecutor({
      runParallel: {
        type: "result",
        value: [
          succeeded(output("correctness", [])),
          succeeded(output("correctness", [])),
        ],
      },
    });

    await expect(
      makeRunner(current, executor).execute({ state: current.state }),
    ).rejects.toThrow(/source|ponytail/iu);
    expect((await current.stateStore.loadState()).phase).toBe("blocked");
  });

  test("does not accept a malformed validation artifact as a review pass", async () => {
    const current = await fixture();
    const failedValidation = {
      ...validation,
      status: "failed" as const,
      checks: [{ id: "tests", status: "failed" as const, exitCode: 1 }],
    };
    const failedRef = await current.artifactStore.writeJson(
      "validation",
      "validation-2.json",
      failedValidation,
      parseValidationResult,
    );
    const state = structuredClone(current.state);
    state.coding.validationRef = failedRef;
    const executor = new FakeSubagentExecutor({
      runParallel: {
        type: "result",
        value: [
          succeeded(output("correctness", [])),
          succeeded(output("ponytail", [])),
        ],
      },
    });

    await expect(
      makeRunner(current, executor).execute({ state }),
    ).rejects.toThrow(/passed|validation/iu);
    expect(executor.calls.runParallel).toHaveLength(0);
  });
});
