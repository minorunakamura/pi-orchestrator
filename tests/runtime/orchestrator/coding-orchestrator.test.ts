import { readFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { OrchestratorConfiguration } from "../../../src/core/configuration.ts";
import { codingAuthority } from "../../../src/core/coding/authority.ts";
import { parseAcceptedFindingsArtifact } from "../../../src/core/decisions/types.ts";
import { advanceWorkflow } from "../../../src/runtime/orchestrator/advance-workflow.ts";
import {
  CodingOrchestrator,
  parseCodeReviewArtifact,
  parseExecutionRoutingArtifact,
  type CodingOrchestratorDependencies,
} from "../../../src/runtime/orchestrator/coding-orchestrator.ts";
import { PlanningOrchestrator } from "../../../src/runtime/orchestrator/planning-orchestrator.ts";
import { startWorkflow } from "../../../src/runtime/orchestrator/start-workflow.ts";
import { StateStore } from "../../../src/runtime/persistence/state-store.ts";
import type { AgentRunResult } from "../../../src/runtime/ports/index.ts";
import {
  FakeJevDecisionClient,
  FakeSubagentExecutor,
  failure,
} from "../../fakes/index.ts";
import type { SubagentRunId } from "../../../src/types.ts";

const roots: string[] = [];
const runId = "worker-1" as unknown as SubagentRunId;
const validPlan = `# Approved Plan

## Scope / Requirements
Implement the requested behavior safely.

## Architecture / Design
Keep runtime orchestration behind the existing ports.

## Implementation Plan
1. Add focused tests.
2. Implement the smallest safe change.

## Validation Contract

\`\`\`orchestrator-validation
{
  "schemaVersion": 1,
  "checks": [
    {
      "id": "tests",
      "type": "command",
      "command": "pnpm test",
      "cwd": ".",
      "required": true
    }
  ]
}
\`\`\`
`;

const configuration: OrchestratorConfiguration = {
  decision: { autoDecisionThreshold: 0.8, escalationThreshold: 0.5 },
  executionProfiles: {
    ECONOMY: { provider: "provider-economy", model: "model-economy" },
    STANDARD: { provider: "provider-standard", model: "model-standard" },
    STRONG: { provider: "provider-strong", model: "model-strong" },
  },
  reasoningMapping: { LOW: "low", MEDIUM: "medium", HIGH: "high" },
  retries: { maxAutomatedFixRounds: 3, maxStrongerRetries: 1 },
  validation: { stopOnInfrastructureFailure: true },
  jev: {},
};

const routing = {
  modelTier: { value: "STANDARD" as const, confidence: 0.95 },
  reasoningTier: { value: "HIGH" as const, confidence: 0.9 },
};

function succeeded(output: string): { type: "result"; value: AgentRunResult } {
  return {
    type: "result",
    value: { status: "succeeded", runId, output },
  };
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join("/tmp", "pi-orchestrator-coding-"));
  roots.push(root);
  return root;
}

async function makeApproved() {
  const runsDirectory = await makeRoot();
  const planningExecutor = new FakeSubagentExecutor({
    run: [succeeded("repository facts"), succeeded(validPlan)],
  });
  const started = await startWorkflow(
    { task: "Implement the coding entry", playbook: "feature" },
    {
      runsDirectory,
      subagentExecutor: planningExecutor,
      workflowIdFactory: () => "workflow-1",
    },
  );
  const created = await new PlanningOrchestrator({
    artifactStore: started.artifactStore,
    stateStore: started.stateStore,
    subagentExecutor: planningExecutor,
  }).createPlan({ state: started.state });
  const reviewRef = await started.artifactStore.writeText(
    "plan-review",
    "review-1.md",
    "approved",
  );
  const approvedState = await advanceWorkflow(
    created.state,
    {
      type: "PLAN_APPROVED",
      planRef: created.planRef,
      version: 1,
      reviewRef,
    },
    started.stateStore,
  );
  return {
    ...started,
    state: approvedState,
    planRef: created.planRef,
    artifactStore: started.artifactStore,
    stateStore: started.stateStore,
  };
}

function dependencies(
  started: Awaited<ReturnType<typeof makeApproved>>,
  overrides: Partial<CodingOrchestratorDependencies> = {},
): CodingOrchestratorDependencies {
  return {
    artifactStore: started.artifactStore,
    stateStore: started.stateStore,
    jevDecisionClient: new FakeJevDecisionClient({
      routeExecution: { type: "result", value: routing },
    }),
    subagentExecutor: new FakeSubagentExecutor({ run: succeeded("done") }),
    configuration,
    ...overrides,
  };
}

async function persistedState(runDirectory: string) {
  return new StateStore(runDirectory).loadState();
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("CodingOrchestrator ORCH-012", () => {
  test.each([
    "configuration",
    "revision",
    "retryCount",
    "context",
    "input",
    "policy",
    "schema",
    "missingHeader",
  ])(
    "rejects stale routing after %s changes before another Worker starts",
    async (change) => {
      const started = await makeApproved();
      const first = new CodingOrchestrator(
        dependencies(started, {
          subagentExecutor: new FakeSubagentExecutor({
            run: failure("infrastructure", "unavailable"),
          }),
        }),
      );
      await expect(first.execute({ state: started.state })).rejects.toThrow();
      const resumed = await advanceWorkflow(
        await persistedState(started.runDirectory),
        { type: "BLOCK_RESOLVED" },
        started.stateStore,
      );
      const config = structuredClone(configuration);
      if (change === "configuration")
        config.decision.autoDecisionThreshold = 0.99;
      if (change === "revision") resumed.coding.implementationRevision += 1;
      if (change === "retryCount") resumed.counters.automatedFixRoundsUsed += 1;
      if (change === "context")
        resumed.taskRef = await started.artifactStore.writeText(
          "task",
          "changed.md",
          "changed scope",
        );
      if (["policy", "schema", "missingHeader"].includes(change)) {
        const value = JSON.parse(
          await started.artifactStore.readText!(
            resumed.coding.executionRoutingRef!,
          ),
        );
        if (change === "policy")
          value.freshness.policyDigest = "changed-policy";
        if (change === "schema") value.freshness.decisionSchemaVersion = 2;
        if (change === "missingHeader") delete value.freshness;
        resumed.coding.executionRoutingRef =
          await started.artifactStore.writeText(
            "execution-routing",
            "stale.md",
            JSON.stringify(value),
          );
      }
      const worker = new FakeSubagentExecutor({
        run: succeeded("must not run"),
      });
      await expect(
        new CodingOrchestrator(
          dependencies(started, {
            subagentExecutor: worker,
            configuration: config,
          }),
        ).execute({
          state: resumed,
          ...(change === "input" ? { changeScope: "changed input" } : {}),
        }),
      ).rejects.toThrow(/stale|fresh|routing/iu);
      expect(worker.calls.run).toHaveLength(0);
    },
  );
  test("routes from authoritative bounded evidence and launches Worker only after durable routing", async () => {
    const started = await makeApproved();
    const jev = new FakeJevDecisionClient({
      routeExecution: { type: "result", value: routing },
    });
    const worker = new FakeSubagentExecutor({ run: succeeded("implemented") });
    const originalRun = worker.run.bind(worker);
    worker.run = async (input) => {
      const state = await persistedState(started.runDirectory);
      expect(state.coding.executionRoutingRef).toBeDefined();
      return originalRun(input);
    };
    const orchestrator = new CodingOrchestrator(
      dependencies(started, {
        jevDecisionClient: jev,
        subagentExecutor: worker,
      }),
    );

    const result = await orchestrator.execute({
      state: started.state,
      cwd: started.runDirectory,
      changeScope: "Implement a bounded coding entry",
    });

    const input = jev.calls.routeExecution[0];
    expect(input.approvedPlanRef).toEqual(
      started.state.planning.approvedPlanRef,
    );
    expect(input.planEvidence.summary.length).toBeLessThanOrEqual(2_000);
    expect(input.planEvidence.relevantSections.length).toBeGreaterThan(0);
    expect(
      input.planEvidence.relevantSections.every(
        (section) => section.content.length <= 3_000,
      ),
    ).toBe(true);
    expect(
      input.contextEvidence.every(
        (evidence) => evidence.content.length <= 2_000,
      ),
    ).toBe(true);
    expect(input.contextRefs).toEqual(
      input.contextEvidence.map((evidence) => evidence.ref),
    );
    expect(worker.calls.run[0]).toMatchObject({
      agent: "worker",
      inputRefs: [
        started.state.planning.approvedPlanRef,
        started.taskRef,
        started.state.planning.context.scoutRef,
      ],
      executionProfile: {
        provider: "provider-standard",
        model: "model-standard",
        thinking: "high",
      },
    });
    expect(result.state.phase).toBe("validating");
    expect(result.state.coding.executionRoutingRef?.kind).toBe(
      "execution-routing",
    );
    expect(result.state.coding.implementationRef?.kind).toBe("implementation");
    expect(
      await started.artifactStore.readJson!(
        result.state.coding.executionRoutingRef!,
        parseExecutionRoutingArtifact,
      ),
    ).toMatchObject({
      schemaVersion: 1,
      approvedPlanRef: started.state.planning.approvedPlanRef,
      modelTier: routing.modelTier,
      reasoningTier: routing.reasoningTier,
    });
    await expect(
      readFile(
        join(started.runDirectory, "implementation", "implementation-1.json"),
        "utf8",
      ),
    ).resolves.toContain("implemented");
  });

  test("blocks before Worker when a new automated retry would exceed the budget", async () => {
    const started = await makeApproved();
    const exhausted = structuredClone(started.state);
    exhausted.counters.automatedFixRoundsUsed =
      configuration.retries.maxAutomatedFixRounds;
    const worker = new FakeSubagentExecutor({
      run: succeeded("should not run"),
    });

    await expect(
      new CodingOrchestrator(
        dependencies(started, { subagentExecutor: worker }),
      ).execute({ state: exhausted }),
    ).rejects.toThrow(/retry budget/i);

    expect(worker.calls.run).toHaveLength(0);
    const persisted = await persistedState(started.runDirectory);
    expect(persisted.phase).toBe("blocked");
    expect(persisted.block?.reason).toBe("retry-budget-exhausted");
  });

  test("does not launch Jev or Worker without a current approved plan artifact", async () => {
    const started = await makeApproved();
    const jev = new FakeJevDecisionClient({
      routeExecution: { type: "result", value: routing },
    });
    const worker = new FakeSubagentExecutor({
      run: succeeded("should not run"),
    });
    const state = structuredClone(started.state);
    delete state.planning.approvedPlanRef;
    delete state.planning.approvedPlanVersion;
    state.phase = "planning";

    await expect(
      new CodingOrchestrator(
        dependencies(started, {
          jevDecisionClient: jev,
          subagentExecutor: worker,
        }),
      ).execute({ state }),
    ).rejects.toThrow(/approved plan/iu);
    expect(jev.calls.routeExecution).toHaveLength(0);
    expect(worker.calls.run).toHaveLength(0);
  });

  test("fails closed when the approved ref is stale or its content does not match", async () => {
    const started = await makeApproved();
    const jev = new FakeJevDecisionClient({
      routeExecution: { type: "result", value: routing },
    });
    const worker = new FakeSubagentExecutor({
      run: succeeded("should not run"),
    });
    const stale = structuredClone(started.state);
    const staleRef = {
      ...stale.planning.approvedPlanRef!,
      sha256: "f".repeat(64),
    };
    stale.planning.currentPlanRef = staleRef;
    stale.planning.approvedPlanRef = staleRef;

    await expect(
      new CodingOrchestrator(
        dependencies(started, {
          jevDecisionClient: jev,
          subagentExecutor: worker,
        }),
      ).execute({ state: stale }),
    ).rejects.toThrow();
    expect(jev.calls.routeExecution).toHaveLength(0);
    expect(worker.calls.run).toHaveLength(0);

    const mismatchedStore = {
      ...started.artifactStore,
      readText: started.artifactStore.readText!.bind(started.artifactStore),
      writeText: started.artifactStore.writeText.bind(started.artifactStore),
      readJson: undefined,
    };
    mismatchedStore.readText = async () => "tampered";
    await expect(
      new CodingOrchestrator(
        dependencies(started, {
          artifactStore: mismatchedStore,
          jevDecisionClient: jev,
          subagentExecutor: worker,
        }),
      ).execute({ state: started.state }),
    ).rejects.toThrow(/hash|artifact|evidence/iu);
    expect(jev.calls.routeExecution).toHaveLength(0);
    expect(worker.calls.run).toHaveLength(0);
  });

  test("blocks on Jev or Worker infrastructure failure before the next side effect", async () => {
    const started = await makeApproved();
    const jev = new FakeJevDecisionClient({
      routeExecution: failure("timeout", "Jev unavailable"),
    });
    const worker = new FakeSubagentExecutor({
      run: succeeded("should not run"),
    });
    await expect(
      new CodingOrchestrator(
        dependencies(started, {
          jevDecisionClient: jev,
          subagentExecutor: worker,
        }),
      ).execute({ state: started.state }),
    ).rejects.toThrow(/Jev unavailable/iu);
    expect(worker.calls.run).toHaveLength(0);
    expect((await persistedState(started.runDirectory)).phase).toBe("blocked");

    const resumed = await advanceWorkflow(
      await persistedState(started.runDirectory),
      { type: "BLOCK_RESOLVED" },
      started.stateStore,
    );
    const workerFailure = new FakeSubagentExecutor({
      run: failure("infrastructure", "Worker unavailable"),
    });
    await expect(
      new CodingOrchestrator(
        dependencies(started, {
          jevDecisionClient: new FakeJevDecisionClient({
            routeExecution: { type: "result", value: routing },
          }),
          subagentExecutor: workerFailure,
        }),
      ).execute({ state: resumed }),
    ).rejects.toThrow(/Worker unavailable/iu);
    expect((await persistedState(started.runDirectory)).phase).toBe("blocked");
    expect(workerFailure.calls.run).toHaveLength(1);
  });

  test("does not launch Worker when routing artifact or its State reference cannot be persisted", async () => {
    const started = await makeApproved();
    const worker = new FakeSubagentExecutor({
      run: succeeded("should not run"),
    });
    const writeFailure = {
      ...started.artifactStore,
      readText: started.artifactStore.readText!.bind(started.artifactStore),
      writeText: started.artifactStore.writeText.bind(started.artifactStore),
      writeJson: async () => {
        throw new Error("decision disk failure");
      },
    };
    await expect(
      new CodingOrchestrator(
        dependencies(started, {
          artifactStore: writeFailure,
          subagentExecutor: worker,
        }),
      ).execute({ state: started.state }),
    ).rejects.toThrow("decision disk failure");
    expect(worker.calls.run).toHaveLength(0);
    expect((await persistedState(started.runDirectory)).phase).toBe(
      "implementing",
    );

    const worker2 = new FakeSubagentExecutor({
      run: succeeded("should not run"),
    });
    await expect(
      new CodingOrchestrator(
        dependencies(started, {
          subagentExecutor: worker2,
          stateStore: {
            saveState: async () => {
              throw new Error("State disk failure");
            },
          },
        }),
      ).execute({ state: started.state }),
    ).rejects.toThrow("State disk failure");
    expect(worker2.calls.run).toHaveLength(0);
  });

  test("records a persistence consistency failure after implementation evidence is durable", async () => {
    const started = await makeApproved();
    const worker = new FakeSubagentExecutor({ run: succeeded("implemented") });
    const realStateStore = started.stateStore;
    const stateStore = {
      saveState: async (
        state: Parameters<typeof realStateStore.saveState>[0],
        expectedRevision?: number,
      ) => {
        if (state.phase === "validating") {
          throw new Error("implementation State disk failure");
        }
        return realStateStore.saveState(state, expectedRevision);
      },
    };

    await expect(
      new CodingOrchestrator(
        dependencies(started, { stateStore, subagentExecutor: worker }),
      ).execute({ state: started.state }),
    ).rejects.toThrow("implementation State disk failure");
    const state = await persistedState(started.runDirectory);
    expect(state.phase).toBe("failed");
    expect(state.failure?.reason).toBe("persistence-consistency-failure");
    expect(state.failure?.evidenceRef?.kind).toBe("implementation");
  });

  test("passes Human Code Feedback to a Fix Worker without treating it as automated findings", async () => {
    const started = await makeApproved();
    const initialWorker = new FakeSubagentExecutor({
      run: succeeded("initial"),
    });
    const initial = await new CodingOrchestrator(
      dependencies(started, { subagentExecutor: initialWorker }),
    ).execute({ state: started.state });
    const validationRef = await started.artifactStore.writeText(
      "validation",
      "validation-1.md",
      "passed",
    );
    let reviewing = await advanceWorkflow(
      initial.state,
      { type: "VALIDATION_PASSED", resultRef: validationRef },
      started.stateStore,
    );
    const decisionRef = await started.artifactStore.writeText(
      "round-decision",
      "round-1.md",
      "complete",
    );
    reviewing = await advanceWorkflow(
      reviewing,
      { type: "REVIEW_COMPLETE", decisionRef },
      started.stateStore,
    );
    const feedback = {
      schemaVersion: 1 as const,
      reviewId: "code-review-1",
      status: "feedback" as const,
      implementationRef: initial.implementationRef,
      implementationRevision: 1,
      feedback: "Please add a regression test.",
    };
    const feedbackRef = await started.artifactStore.writeJson!(
      "code-review",
      "code-review-1.json",
      feedback,
      parseCodeReviewArtifact,
    );
    const fixing = await advanceWorkflow(
      reviewing,
      { type: "CODE_FEEDBACK", feedbackRef },
      started.stateStore,
    );
    expect(fixing.coding.latestCodeReviewRef).toEqual(feedbackRef);
    const fixWorker = new FakeSubagentExecutor({ run: succeeded("fixed") });
    const fix = await new CodingOrchestrator(
      dependencies(started, { subagentExecutor: fixWorker }),
    ).execute({ state: fixing });

    expect(fixWorker.calls.run[0]?.inputRefs).toEqual(
      expect.arrayContaining([feedbackRef]),
    );
    expect(fix.state.counters.automatedFixRoundsUsed).toBe(0);
    expect(fix.state.coding.latestCodeReviewRef).toBeUndefined();
  });

  test("passes only the authoritative accepted-findings ref to a Fix Worker", async () => {
    const started = await makeApproved();
    const initialWorker = new FakeSubagentExecutor({
      run: succeeded("initial"),
    });
    const initial = await new CodingOrchestrator(
      dependencies(started, { subagentExecutor: initialWorker }),
    ).execute({ state: started.state });
    const decisionRef = await started.artifactStore.writeText(
      "round-decision",
      "round-1.md",
      "retry",
    );
    const acceptedFindings = {
      schemaVersion: 1,
      authority: codingAuthority(initial.state),
      round: 1,
      planVersion: 1,
      implementationRevision: 1,
      approvedPlanRef: started.state.planning.approvedPlanRef,
      accepted: [
        {
          id: "C1",
          source: "correctness",
          category: "regression",
          summary: "accepted finding",
          evidence: "accepted evidence",
          blocking: true,
        },
      ],
    } as const;
    expect(parseAcceptedFindingsArtifact(acceptedFindings)).toEqual(
      acceptedFindings,
    );
    const acceptedFindingsRef = await started.artifactStore.writeText(
      "accepted-findings",
      "accepted-findings-1.md",
      JSON.stringify(acceptedFindings),
    );
    const validationRef = await started.artifactStore.writeText(
      "validation",
      "validation-1.md",
      "passed",
    );
    const reviewing = await advanceWorkflow(
      initial.state,
      { type: "VALIDATION_PASSED", resultRef: validationRef },
      started.stateStore,
    );
    const fixing = await advanceWorkflow(
      reviewing,
      {
        type: "REVIEW_RETRY_REQUIRED",
        decisionRef,
        findingsRef: acceptedFindingsRef,
      },
      started.stateStore,
    );
    const fixWorker = new FakeSubagentExecutor({ run: succeeded("fixed") });
    const fix = await new CodingOrchestrator(
      dependencies(started, { subagentExecutor: fixWorker }),
    ).execute({ state: fixing });

    expect(fixWorker.calls.run[0]?.inputRefs).toEqual(
      expect.arrayContaining([acceptedFindingsRef]),
    );
    expect(fixWorker.calls.run[0]?.inputRefs).not.toContain(
      initial.state.coding.correctnessReviewRef,
    );
    expect(fix.state.coding.implementationRef?.kind).toBe("implementation");
  });
});
