import { readFile, rm, writeFile, mkdir, rename } from "node:fs/promises";
import { SubagentsIntegration } from "../../fakes/agent-launch.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../../src/runtime/integrations/subagents.ts";
import { FakeSubagentRpc } from "../../fakes/subagent-rpc.ts";
import { ArtifactStore } from "../../../src/runtime/persistence/artifact-store.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { OrchestratorConfiguration } from "../../../src/core/configuration.ts";
import { codingAuthority } from "../../../src/core/coding/authority.ts";
import { parseAcceptedFindingsArtifact } from "../../../src/core/decisions/types.ts";
import { advanceWorkflow } from "../../../src/runtime/orchestrator/advance-workflow.ts";
import {
  CodingOrchestrator,
  codeReviewIdentityKey,
  parseCodeReviewArtifact,
  parseExecutionRoutingArtifact,
  type CodingOrchestratorDependencies,
} from "../../../src/runtime/orchestrator/coding-orchestrator.ts";
import {
  PlanningOrchestrator,
  type WorkflowArtifactWriter,
} from "../../../src/runtime/orchestrator/planning-orchestrator.ts";
import { startWorkflow } from "../../fakes/planning.ts";
import { StateStore } from "../../../src/runtime/persistence/state-store.ts";
import type { AgentRunResult } from "../../../src/runtime/ports/index.ts";
import {
  FakeJevDecisionClient,
  FakeSubagentExecutor,
  failure,
} from "../../fakes/index.ts";
import { plannotatorReviewId, subagentRunId } from "../../../src/types.ts";

import { jevPolicy } from "../../fakes/jev-policy.ts";
function noopListener(_payload: unknown): void {}

const roots: string[] = [];
const runId = subagentRunId("worker-1");
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
  await promisify(execFile)("git", ["init", "--quiet", root]);
  return root;
}

async function makeApproved() {
  const runsDirectory = await makeRoot();
  const planningExecutor = new FakeSubagentExecutor({
    run: [succeeded("repository facts"), succeeded(validPlan)],
  });
  const started = await startWorkflow(
    {
      task: "Implement the coding entry",
      playbook: "feature",
      cwd: runsDirectory,
    },
    {
      runsDirectory,
      subagentExecutor: planningExecutor,
      workflowIdFactory: () => "workflow-1",
    },
  );
  const created = await new PlanningOrchestrator({
    ...started,
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
    repositoryCwd: runsDirectory,
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
    repositoryCwd: started.repositoryCwd,
    jevDecisionClient: new FakeJevDecisionClient({
      routeExecution: { type: "result", value: routing },
    }),
    subagentExecutor: new FakeSubagentExecutor({ run: succeeded("done") }),
    configuration: {
      ...configuration,
      jev: jevPolicy(started.state.projectRoot),
    },
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
  test("gitlinks are unsupported even when Git is configured to ignore submodule dirt", async () => {
    const started = await makeApproved();
    await mkdir(join(started.repositoryCwd, "module"));
    await writeFile(
      join(started.repositoryCwd, "module", "dirty.txt"),
      "preexisting dirty content",
    );
    await promisify(execFile)("git", [
      "-C",
      started.repositoryCwd,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${"a".repeat(40)},module`,
    ]);
    await promisify(execFile)("git", [
      "-C",
      started.repositoryCwd,
      "config",
      "diff.ignoreSubmodules",
      "all",
    ]);
    const worker = new FakeSubagentExecutor({ run: succeeded("must not run") });
    await expect(
      new CodingOrchestrator(
        dependencies(started, { subagentExecutor: worker }),
      ).execute({ state: started.state }),
    ).rejects.toThrow(/gitlink|submodule/iu);
    expect(worker.calls.run).toHaveLength(0);
    expect((await persistedState(started.runDirectory)).block?.reason).toBe(
      "agent-infrastructure-unavailable",
    );
  });

  test.each([
    ["--assume-unchanged"],
    ["--skip-worktree"],
    ["--assume-unchanged", "--skip-worktree"],
  ])(
    "hidden tracked mutations are rejected before dispatch: %j",
    async (...flags) => {
      const started = await makeApproved();
      const git = (...args: string[]) =>
        promisify(execFile)("git", ["-C", started.repositoryCwd, ...args]);
      const name = "tracked file\nwith whitespace.txt";
      await writeFile(join(started.repositoryCwd, name), "baseline");
      await git("add", "--", name);
      for (const flag of flags) {
        // Git index flags accumulate; apply them in the scenario's specified order.
        // oxlint-disable-next-line eslint/no-await-in-loop
        await git("update-index", flag, "--", name);
      }
      await writeFile(join(started.repositoryCwd, name), "hidden mutation");
      const before = (await git("ls-files", "-v", "-z")).stdout;
      const worker = new FakeSubagentExecutor({
        run: succeeded("must not run"),
      });
      await expect(
        new CodingOrchestrator(
          dependencies(started, { subagentExecutor: worker }),
        ).execute({ state: started.state }),
      ).rejects.toThrow(/assume-unchanged|skip-worktree/iu);
      expect(worker.calls.run).toHaveLength(0);
      const state = await persistedState(started.runDirectory);
      expect(state.phase).toBe("blocked");
      expect(state.block?.reason).toBe("agent-infrastructure-unavailable");
      expect(state.coding.workerAttemptRef).toBeUndefined();
      expect(state.coding.implementationRef).toBeUndefined();
      expect((await git("ls-files", "-v", "-z")).stdout).toBe(before);
    },
  );

  test("received run identity is durable before an unavailable post-run scan", async () => {
    const started = await makeApproved();
    const worker = new FakeSubagentExecutor();
    worker.run = async () => {
      await rename(
        join(started.repositoryCwd, ".git"),
        join(started.repositoryCwd, ".git-hidden"),
      );
      return succeeded("done").value;
    };
    await expect(
      new CodingOrchestrator(
        dependencies(started, { subagentExecutor: worker }),
      ).execute({ state: started.state }),
    ).rejects.toThrow();
    const state = await persistedState(started.runDirectory);
    const terminal = JSON.parse(
      await started.artifactStore.readText!(state.coding.workerAttemptRef!),
    );
    const received = JSON.parse(
      await readFile(
        join(
          started.runDirectory,
          "implementation",
          `attempt-${terminal.attemptId}-received.json`,
        ),
        "utf8",
      ),
    );
    expect(received).toMatchObject({ runId, after: { status: "pending" } });
    expect(terminal.after.status).toBe("unavailable");
    expect(state.phase).toBe("blocked");
  });

  test.each(["timeout", "malformed-result"])(
    "unsubscribe throw reaches durable BLOCK with evidence: %s",
    async (path) => {
      const started = await makeApproved();
      let listener: (payload: unknown) => void = noopListener;
      let emissions = 0;
      let cleanups = 0;
      let sent: Record<string, unknown> = {};
      const bus = new FakeSubagentRpc((request, rpc) => {
        emissions++;
        sent = request;
        if (path === "malformed-result") {
          rpc.receipt(request, runId);
          rpc.deliver(SUBAGENT_ASYNC_COMPLETE_EVENT, {
            runId,
            mode: "single",
            state: "complete",
            success: true,
            results: [],
          });
        }
      });
      const adapter = new SubagentsIntegration(
        {
          on: (event, receive) => {
            if (event === SUBAGENT_ASYNC_COMPLETE_EVENT) listener = receive;
            bus.on(event, receive);
            return () => {
              cleanups++;
              throw Error("unsubscribe failed");
            };
          },
          emit: (event, payload) => bus.emit(event, payload),
        },
        {
          timeoutMs: 20,
          artifactReader: new ArtifactStore(started.runDirectory),
        },
      );
      const orchestrator = new CodingOrchestrator(
        dependencies(started, { subagentExecutor: adapter }),
      );
      await expect(
        orchestrator.execute({ state: started.state }),
      ).rejects.toThrow("Worker did not succeed");
      const state = await persistedState(started.runDirectory);
      expect(state.phase).toBe("blocked");
      expect(state.block?.reason).toBe("agent-execution-ambiguous");
      expect(state.coding.implementationRef).toBeUndefined();
      const record = JSON.parse(
        await started.artifactStore.readText!(state.coding.workerAttemptRef!),
      );
      expect(record).toMatchObject({
        status: path === "timeout" ? "timed-out" : "ambiguous",
        launchStatus: path === "timeout" ? "unknown" : "observed",
        dispatch: {
          requestId: sent.requestId,
          ownerRunId: sent.ownerRunId,
          nodeId: sent.nodeId,
        },
        after: { status: "observed" },
      });
      expect(record.runId).toBe(path === "timeout" ? undefined : runId);
      const received = JSON.parse(
        await started.artifactStore.readText!(record.previousRef),
      );
      expect(received.after.status).toBe("pending");
      expect(received.runId).toBe(record.runId);
      listener({
        ...sent,
        status: "completed",
        runId: "late",
        result: { kind: "text", text: "late" },
      });
      await expect(orchestrator.execute({ state })).rejects.toThrow();
      expect(emissions).toBe(1);
      expect(cleanups).toBe(2);
      expect((await persistedState(started.runDirectory)).phase).toBe(
        "blocked",
      );
    },
  );

  test("proven subscription failure is durable not-started infrastructure evidence", async () => {
    const started = await makeApproved();
    let emissions = 0;
    const adapter = new SubagentsIntegration(
      {
        on: () => {
          throw Error("subscription unavailable");
        },
        emit: () => {
          emissions++;
        },
      },
      {
        timeoutMs: 50,
        artifactReader: new ArtifactStore(started.runDirectory),
      },
    );
    await expect(
      new CodingOrchestrator(
        dependencies(started, { subagentExecutor: adapter }),
      ).execute({ state: started.state }),
    ).rejects.toThrow();
    const state = await persistedState(started.runDirectory);
    const record = JSON.parse(
      await started.artifactStore.readText!(state.coding.workerAttemptRef!),
    );
    expect(emissions).toBe(0);
    expect(state.block?.reason).toBe("agent-infrastructure-unavailable");
    expect(record).toMatchObject({
      status: "failed",
      launchStatus: "not-started",
    });
    expect(record.runId).toBeUndefined();
  });
  test("persists dispatch intent before mutation and exact failed run evidence after it", async () => {
    const started = await makeApproved();
    await writeFile(
      join(started.repositoryCwd, "preexisting.txt"),
      "keep this",
    );
    const worker = new FakeSubagentExecutor();
    worker.run = async (request) => {
      const durable = await persistedState(started.runDirectory);
      expect(durable.coding.workerAttemptRef).toBeDefined();
      const intent = JSON.parse(
        await started.artifactStore.readText!(durable.coding.workerAttemptRef!),
      );
      expect(intent.status).toBe("intent");
      expect(intent.dispatch).toEqual(request.dispatch);
      expect(intent.before.untracked).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "preexisting.txt" }),
        ]),
      );
      await writeFile(
        join(started.repositoryCwd, "mutation.txt"),
        "mutation before failure",
      );
      return { status: "failed", runId, error: "task failed" };
    };
    await expect(
      new CodingOrchestrator(
        dependencies(started, { subagentExecutor: worker }),
      ).execute({ state: started.state }),
    ).rejects.toThrow();
    const state = await persistedState(started.runDirectory);
    expect(state.phase).toBe("blocked");
    const observation = JSON.parse(
      await started.artifactStore.readText!(state.coding.workerAttemptRef!),
    );
    expect(observation).toMatchObject({ status: "failed", runId });
    expect(observation.after.snapshot.untracked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "mutation.txt" }),
      ]),
    );
    expect(observation.previousRef).toBeDefined();
    const resumed = await advanceWorkflow(
      state,
      { type: "BLOCK_RESOLVED" },
      started.stateStore,
    );
    const next = new FakeSubagentExecutor({ run: succeeded("duplicate") });
    await expect(
      new CodingOrchestrator(
        dependencies(started, { subagentExecutor: next }),
      ).execute({ state: resumed }),
    ).rejects.toThrow(/reconcil|attempt/iu);
    expect(next.calls.run).toHaveLength(0);
  });
  test.each(["ambiguous", "timed-out"])(
    "retains %s run evidence and never infers completion",
    async (mode) => {
      const started = await makeApproved();
      const worker = new FakeSubagentExecutor({
        run: {
          type: "result",
          value: {
            status: "ambiguous",
            runId,
            timedOut: mode === "timed-out",
            reason: "outcome unknown",
          },
        },
      });
      await expect(
        new CodingOrchestrator(
          dependencies(started, { subagentExecutor: worker }),
        ).execute({ state: started.state }),
      ).rejects.toThrow();
      const state = await persistedState(started.runDirectory);
      const record = JSON.parse(
        await started.artifactStore.readText!(state.coding.workerAttemptRef!),
      );
      expect(record).toMatchObject({ status: mode, runId });
      expect(record.dispatch.requestId).not.toBe(runId);
      expect(state.coding.implementationRef).toBeUndefined();
      expect(state.block?.reason).toBe("agent-execution-ambiguous");
    },
  );

  test("outcome State save failure leaves an intent barrier and exact orphan run evidence", async () => {
    const started = await makeApproved();
    const worker = new FakeSubagentExecutor({ run: succeeded("same prose") });
    const store = {
      saveState: async (
        state: Parameters<typeof started.stateStore.saveState>[0],
        revision?: number,
      ) => {
        if (state.coding.workerAttemptRef?.path.endsWith("result.json"))
          throw Error("outcome State failed");
        return started.stateStore.saveState(state, revision);
      },
    };
    await expect(
      new CodingOrchestrator(
        dependencies(started, { subagentExecutor: worker, stateStore: store }),
      ).execute({ state: started.state }),
    ).rejects.toThrow("outcome State failed");
    const state = await persistedState(started.runDirectory);
    const intent = JSON.parse(
      await started.artifactStore.readText!(state.coding.workerAttemptRef!),
    );
    expect(intent.status).toBe("ambiguous");
    expect(intent.runId).toBe(runId);
    const result = JSON.parse(
      await readFile(
        join(
          started.runDirectory,
          "implementation",
          `attempt-${intent.attemptId}-result.json`,
        ),
        "utf8",
      ),
    );
    expect(result).toMatchObject({ status: "succeeded", runId });
    const next = new FakeSubagentExecutor({ run: succeeded("duplicate") });
    await expect(
      new CodingOrchestrator(
        dependencies(started, { subagentExecutor: next }),
      ).execute({ state }),
    ).rejects.toThrow(/reconcil/iu);
    expect(next.calls.run).toHaveLength(0);
  });

  test("implementation Artifact failure retains received run identity for recovery", async () => {
    const started = await makeApproved();
    const artifacts: WorkflowArtifactWriter = {
      ...started.artifactStore,
      readText: started.artifactStore.readText!.bind(started.artifactStore),
      writeText: started.artifactStore.writeText.bind(started.artifactStore),
      writeJson: async (kind, name, value, schema) => {
        if (name.startsWith("implementation-"))
          throw Error("result disk failure");
        return started.artifactStore.writeJson!(kind, name, value, schema);
      },
    };
    await expect(
      new CodingOrchestrator(
        dependencies(started, { artifactStore: artifacts }),
      ).execute({ state: started.state }),
    ).rejects.toThrow("result disk failure");
    const state = await persistedState(started.runDirectory);
    const record = JSON.parse(
      await started.artifactStore.readText!(state.coding.workerAttemptRef!),
    );
    expect(record.runId).toBe(runId);
    expect(state.phase).toBe("blocked");
  });

  test("missing consent blocks before Jev or Worker", async () => {
    const started = await makeApproved();
    const jev = new FakeJevDecisionClient({
      routeExecution: { type: "result", value: routing },
    });
    const worker = new FakeSubagentExecutor({ run: succeeded("forbidden") });
    await expect(
      new CodingOrchestrator(
        dependencies(started, {
          configuration,
          jevDecisionClient: jev,
          subagentExecutor: worker,
        }),
      ).execute({ state: started.state }),
    ).rejects.toThrow(/consent|budget/iu);
    expect(jev.calls.routeExecution).toHaveLength(0);
    expect(worker.calls.run).toHaveLength(0);
    expect((await persistedState(started.runDirectory)).block?.reason).toBe(
      "operator-attention-required",
    );
  });

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
          stateStore: {
            saveState: async (state, revision) => {
              if (state.coding.workerAttemptRef)
                throw Error("intent save interrupted");
              return started.stateStore.saveState(state, revision);
            },
          },
          subagentExecutor: new FakeSubagentExecutor({
            run: succeeded("must not start"),
          }),
        }),
      );
      await expect(first.execute({ state: started.state })).rejects.toThrow();
      const resumed = await persistedState(started.runDirectory);
      const config = {
        ...structuredClone(configuration),
        jev: jevPolicy(started.state.projectRoot),
      };
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
    ).rejects.toThrow(/Worker did not succeed/iu);
    expect((await persistedState(started.runDirectory)).phase).toBe("blocked");
    expect(workerFailure.calls.run).toHaveLength(1);
  });

  test("does not launch Worker when routing artifact or its State reference cannot be persisted", async () => {
    const started = await makeApproved();
    const worker = new FakeSubagentExecutor({
      run: succeeded("should not run"),
    });
    const writeFailure: WorkflowArtifactWriter = {
      ...started.artifactStore,
      readText: started.artifactStore.readText!.bind(started.artifactStore),
      writeText: started.artifactStore.writeText.bind(started.artifactStore),
      writeJson: async (kind, name, value, schema) => {
        if (kind === "execution-routing")
          throw new Error("decision disk failure");
        return started.artifactStore.writeJson!(kind, name, value, schema);
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
            saveState: async (state, revision) => {
              if (state.coding.executionRoutingRef)
                throw new Error("State disk failure");
              return started.stateStore.saveState(state, revision);
            },
          },
        }),
      ).execute({ state: await persistedState(started.runDirectory) }),
    ).rejects.toThrow("State disk failure");
    expect(worker2.calls.run).toHaveLength(0);
  });

  test("blocks recoverably after implementation evidence is durable but State publication fails", async () => {
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
    expect(state.phase).toBe("blocked");
    expect(state.block?.reason).toBe("agent-execution-ambiguous");
    expect(state.block?.evidenceRef?.kind).toBe("implementation");
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
    const reviewId = plannotatorReviewId("code-review-1");
    reviewing = await started.stateStore.saveState(
      {
        ...reviewing,
        external: {
          ...reviewing.external,
          [codeReviewIdentityKey(1)]: reviewId,
        },
        coding: {
          ...reviewing.coding,
          codeReview: {
            reviewId,
            implementationRef: initial.implementationRef,
            implementationRevision: 1,
          },
        },
      },
      reviewing.stateRevision,
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
