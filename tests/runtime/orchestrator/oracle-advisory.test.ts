import { afterEach, expect, test, vi } from "vitest";
import { WorkflowOwnership } from "../../../src/runtime/orchestrator/workflow-ownership.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  phaseCWorkflow,
  type PhaseCWorkflow,
} from "../../fakes/phase-c-workflow.ts";
import { FakeSubagentExecutor } from "../../fakes/index.ts";
const success = <T>(value: T) => ({ type: "result" as const, value });
import { subagentRunId, safeWorkflowId } from "../../../src/types.ts";
import {
  oracleSource,
  assertOracleReason,
  ORACLE_MAX_ATTEMPTS,
} from "../../../src/core/oracle.ts";
import {
  requestOracleAdvice,
  runOracleAdvice,
  freshOracleAdvice,
} from "../../../src/runtime/orchestrator/oracle-advisory.ts";
import { PlanningRouting } from "../../../src/runtime/orchestrator/planning-routing.ts";
import { PlanningAgentPendingError } from "../../../src/runtime/orchestrator/planning-agent-run.ts";
import type { SubagentExecutor } from "../../../src/runtime/ports/subagent-executor.ts";
import { createWorkflowCommandRuntime } from "../../../src/commands/index.ts";
import {
  SubagentsIntegration,
  SUBAGENT_ASYNC_COMPLETE_EVENT,
} from "../../../src/runtime/integrations/subagents.ts";
import { fakeLaunchResolver } from "../../fakes/agent-launch.ts";
import { FakeSubagentRpc, childRequest } from "../../fakes/subagent-rpc.ts";

const workflows: PhaseCWorkflow[] = [];
const output =
  "Inherited decisions: Human Gates required.\nAssumptions: uncertain root cause.\nRisks: evidence missing.\nNeed from main agent: confirm scope.\n" +
  "Full advice. ".repeat(8_000);
async function setup(outcome: "success" | "ambiguous" | "failed" = "success") {
  const h = await phaseCWorkflow();
  workflows.push(h);
  // Consult against the complete current strategy frontier; resolving a new method
  // afterward legitimately makes exact-State Oracle advice stale.
  await new PlanningRouting(h).method(await h.load());
  const runId = subagentRunId("oracle-run");
  const succeeded = { status: "succeeded" as const, runId, output };
  const oracle = new FakeSubagentExecutor({
    run: [
      success(
        outcome === "success"
          ? succeeded
          : outcome === "failed"
            ? {
                status: "failed",
                notDispatched: true,
                error: "preflight unavailable",
              }
            : {
                status: "ambiguous",
                runId,
                timedOut: true,
                reason: "deadline",
              },
      ),
      success(succeeded),
    ],
    status: [success({ status: "succeeded", runId, result: succeeded })],
  });
  const executor: SubagentExecutor = {
    preflight: (input) =>
      input.agent === "oracle"
        ? oracle.preflight(input)
        : h.subagentExecutor.preflight(input),
    run: (input) =>
      input.agent === "oracle"
        ? oracle.run(input)
        : h.subagentExecutor.run(input),
    runParallel: (inputs) => h.subagentExecutor.runParallel(inputs),
    status: (id, receipt) =>
      id === runId ? oracle.status(id) : h.subagentExecutor.status(id, receipt),
    resume: (id, task) => h.subagentExecutor.resume(id, task),
  };
  const deps = {
    artifactStore: h.artifactStore,
    stateStore: h.stateStore,
    subagentExecutor: executor,
  };
  const question = {
    reason: "architecture-tradeoff" as const,
    question: "Compare two approaches without choosing authoritative scope.",
  };
  const queue = () =>
    h.load().then((state) => requestOracleAdvice(state, question, deps));
  return { h, oracle, executor, deps, question, queue };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(workflows.splice(0).map((h) => h.cleanup()));
});

test("Oracle is optional; bounded completion automatically continues to Planner and mandatory Human Gate", async () => {
  const f = await setup();
  const initial = await f.h.load();
  const pending = await f.queue();
  expect(pending.oracle?.attemptsUsed).toBe(1);
  expect(f.oracle.calls.run).toHaveLength(0);
  const result = await f.h.drive({ subagentExecutor: f.executor });
  expect(result.state.phase).toBe("awaiting-plan-review");
  expect(result.state.planning.approvedPlanRef).toBeUndefined();
  expect(f.h.children.some((child) => child.agent === "worker")).toBe(false);
  expect(f.oracle.calls.run).toHaveLength(1);
  const call = f.oracle.calls.run[0];
  expect(call.launchPolicy).toMatchObject({
    builtin: true,
    authorityRole: "advisory",
    context: "fresh",
    inheritSkills: false,
    denyExtensions: true,
  });
  expect(call.launchPolicy?.allowedTools).toEqual([
    "read",
    "grep",
    "find",
    "ls",
  ]);
  const artifact = JSON.parse(
    await f.h.artifactStore.readText(result.state.oracle!.latestAdviceRef!),
  );
  expect(artifact.output).toBe(output);
  expect(artifact.request.sourceRevision).toBe(initial.stateRevision);
  expect(artifact.request.inputRefs).toContainEqual(initial.taskRef);
  expect(artifact.attempt.receipt.runId).toBe("oracle-run");
  const task = f.h.children.find((child) => child.agent === "planner")!.task;
  const inputs = JSON.parse(task.split("\n").at(-1)!);
  const suppliedAdvice = inputs.find(
    (input: { ref: { kind: string } }) => input.ref.kind === "oracle-advisory",
  );
  expect(JSON.parse(suppliedAdvice.content).output).toBe(output);
  expect(await freshOracleAdvice(result.state, f.deps)).toBeUndefined(); // phase/Plan changed
});

test("ordinary driver has zero Oracle calls", async () => {
  const f = await setup();
  await f.h.drive({ subagentExecutor: f.executor });
  expect(f.oracle.calls.run).toHaveLength(0);
});

test("exact State/evidence/launch freshness is required; ledger writes alone preserve source", async () => {
  const f = await setup();
  const source = oracleSource(await f.h.load());
  const done = await runOracleAdvice(await f.queue(), f.deps);
  expect(oracleSource(done)).toBe(source);
  expect(await freshOracleAdvice(done, f.deps)).toEqual(
    done.oracle?.latestAdviceRef,
  );
  expect(
    await freshOracleAdvice(
      { ...done, counters: { ...done.counters, humanCodeFeedbackRounds: 1 } },
      f.deps,
    ),
  ).toBeUndefined();
  const preflight = vi.spyOn(f.executor, "preflight");
  const launch = await f.oracle.preflight(f.oracle.calls.run[0]);
  preflight.mockResolvedValue({ ...launch, definitionDigest: "changed" });
  expect(await freshOracleAdvice(done, f.deps)).toBeUndefined();
  preflight.mockRestore();
  await writeFile(
    join(f.h.artifactStore.rootDirectory, done.taskRef.path),
    "tampered",
  );
  await expect(freshOracleAdvice(done, f.deps)).rejects.toThrow();
});

test("only supported reasons and decision points; finite durable budget, no refund/reset", async () => {
  const f = await setup();
  const state = await f.h.load();
  await Promise.all(
    [
      "typed-routing",
      "competing-diagnosis",
      "planning-disagreement",
      "material-plan-deviation",
      "post-implementation-escalation",
    ].map((reason) =>
      expect(
        requestOracleAdvice(
          state,
          // Deliberately invalid runtime inputs exercise the trust boundary.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          { ...f.question, reason: reason as typeof f.question.reason },
          f.deps,
        ),
      ).rejects.toThrow(),
    ),
  );
  await expect(
    requestOracleAdvice(state, { ...f.question, question: " " }, f.deps),
  ).rejects.toThrow();
  const pending = await f.queue();
  await expect(
    requestOracleAdvice(pending, f.question, f.deps),
  ).rejects.toThrow("pending");
  await runOracleAdvice(pending, f.deps);
  await runOracleAdvice(await f.queue(), f.deps);
  expect((await f.h.load()).oracle?.attemptsUsed).toBe(ORACLE_MAX_ATTEMPTS);
  await expect(f.queue()).rejects.toThrow("budget");
});

test("reservation or prepared-launch State save failure emits zero child dispatch", async () => {
  const f = await setup();
  const save = vi
    .spyOn(f.h.stateStore, "saveState")
    .mockRejectedValueOnce(Error("reservation failure"));
  await expect(f.queue()).rejects.toThrow("reservation failure");
  expect(f.oracle.calls.run).toHaveLength(0);
  save.mockRestore();
  const pending = await f.queue();
  vi.spyOn(f.h.stateStore, "saveState").mockRejectedValueOnce(
    Error("intent failure"),
  );
  await expect(runOracleAdvice(pending, f.deps)).rejects.toThrow(
    "intent failure",
  );
  expect(f.oracle.calls.run).toHaveLength(0);
});

test("timeout blocks, resume recovers the historical full result without duplicate dispatch", async () => {
  const f = await setup("ambiguous");
  await f.queue();
  const blocked = await f.h.drive({ subagentExecutor: f.executor });
  expect(blocked.state.phase).toBe("blocked");
  expect(blocked.state.oracle?.pendingRef).toBeDefined();
  expect(blocked.state.oracle?.attemptsUsed).toBe(1);
  const resumed = await f.h.resume({ subagentExecutor: f.executor });
  expect(resumed.state.phase).toBe("awaiting-plan-review");
  expect(f.oracle.calls.run).toHaveLength(1);
  expect(f.oracle.calls.status).toEqual(["oracle-run"]);
  expect(resumed.state.planning.approvedPlanRef).toBeUndefined();
});

test("running historical run waits; launch drift or missing receipt fails closed without replacement", async () => {
  const f = await setup("ambiguous");
  const blocked = await runOracleAdvice(await f.queue(), f.deps);
  const status = vi.spyOn(f.oracle, "status").mockResolvedValue({
    status: "running",
    runId: subagentRunId("oracle-run"),
  });
  await expect(runOracleAdvice(blocked, f.deps)).rejects.toBeInstanceOf(
    PlanningAgentPendingError,
  );
  status.mockRestore();
  const launch = await f.oracle.preflight(f.oracle.calls.run[0]);
  vi.spyOn(f.executor, "preflight").mockResolvedValue({
    ...launch,
    model: "changed/model",
  });
  expect((await runOracleAdvice(blocked, f.deps)).phase).toBe("blocked");
  expect(f.oracle.calls.run).toHaveLength(1);
});

test("output-before-State crash republishes identical advice and never relaunches", async () => {
  const f = await setup();
  const pending = await f.queue();
  const original = f.h.stateStore.saveState.bind(f.h.stateStore);
  const save = vi
    .spyOn(f.h.stateStore, "saveState")
    .mockImplementation((state, revision, options) => {
      if (state.oracle?.latestAdviceRef)
        return Promise.reject(Error("result State crash"));
      return original(state, revision, options);
    });
  await expect(runOracleAdvice(pending, f.deps)).rejects.toThrow(
    "result State crash",
  );
  save.mockRestore();
  const recovered = await runOracleAdvice(await f.h.load(), f.deps);
  expect(recovered.oracle?.pendingRef).toBeUndefined();
  expect(f.oracle.calls.run).toHaveLength(1);
  expect(
    JSON.parse(
      await f.h.artifactStore.readText(recovered.oracle!.latestAdviceRef!),
    ).output,
  ).toBe(output);
});

test("stale queued State or missing historical receipt cannot cause a new Oracle dispatch", async () => {
  const f = await setup();
  const pending = await f.queue();
  const changed = await f.h.stateStore.saveState(
    {
      ...pending,
      counters: { ...pending.counters, humanCodeFeedbackRounds: 1 },
    },
    pending.stateRevision,
  );
  expect((await runOracleAdvice(changed, f.deps)).phase).toBe("blocked");
  expect(f.oracle.calls.run).toHaveLength(0);
  const g = await setup("ambiguous");
  const blocked = await runOracleAdvice(await g.queue(), g.deps);
  delete blocked.planning.agentAttempts!["oracle-1"].receipt;
  expect((await runOracleAdvice(blocked, g.deps)).phase).toBe("blocked");
  expect(g.oracle.calls.run).toHaveLength(1);
});

test("production composition exposes bounded advisory through the existing public RPC adapter", async () => {
  const f = await setup();
  const ownership = new WorkflowOwnership(f.h.repositoryCwd, "root-1");
  const state = await ownership.initialize(await f.h.load(), f.h.stateStore);
  await f.h.stateStore.saveState(
    {
      ...state,
      phase: "blocked",
      block: { blockedFrom: "planning", reason: "operator-attention-required" },
    },
    state.stateRevision,
  );
  const events = new FakeSubagentRpc((request, bus) => {
    bus.receipt(request, "composed-oracle");
    bus.complete(
      request,
      "composed-oracle",
      "complete",
      "Advisory only; unresolved Human scope decision.",
    );
  });
  const runtime = createWorkflowCommandRuntime(events, f.h.repositoryCwd, {
    ownership,
    launchResolver: fakeLaunchResolver,
  });
  const result = await runtime.advise!(state.workflowId, f.question);
  expect(result.status).toBe("blocked");
  expect(result.state.oracle?.latestAdviceRef).toBeDefined();
  expect(result.state.planning.approvedPlanRef).toBeUndefined();
  expect(
    events.emitted.filter((event) => childRequest(event.payload)),
  ).toHaveLength(1);
  await f.h.stateStore.saveState(
    {
      ...result.state,
      workflowId: safeWorkflowId("wrong-root-binding"),
      planning: { ...result.state.planning, agentAttempts: {} },
    },
    result.state.stateRevision,
  );
  await expect(runtime.advise!(state.workflowId, f.question)).rejects.toThrow(
    "identity mismatch",
  );
  expect(
    events.emitted.filter((event) => childRequest(event.payload)),
  ).toHaveLength(1);
});

test("exact completion notification wakes a reconciled running Oracle without manual resume or redispatch", async () => {
  const f = await setup();
  const ownership = new WorkflowOwnership(f.h.repositoryCwd, "root-1");
  const source = await ownership.initialize(await f.h.load(), f.h.stateStore);
  const blocked = await f.h.stateStore.saveState(
    {
      ...source,
      phase: "blocked",
      block: { blockedFrom: "planning", reason: "operator-attention-required" },
    },
    source.stateRevision,
  );
  let captured: Record<string, unknown> | undefined;
  const events = new FakeSubagentRpc((request, bus) => {
    captured = request;
    bus.receipt(request, "running-oracle");
  });
  const adapter = new SubagentsIntegration(events, {
    cwd: f.h.repositoryCwd,
    artifactReader: f.h.artifactStore,
    launchResolver: fakeLaunchResolver,
    timeoutMs: 500,
  });
  const deps = { ...f.deps, subagentExecutor: adapter };
  const pending = await requestOracleAdvice(blocked, f.question, deps);
  await runOracleAdvice(pending, deps); // bounded wait expired, native public status remains running
  const runtime = createWorkflowCommandRuntime(events, f.h.repositoryCwd, {
    ownership,
    launchResolver: fakeLaunchResolver,
  });
  expect((await runtime.resume(source.workflowId)).status).toBe("pending");
  events.deliver(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "unrelated-run" });
  expect((await f.h.load()).oracle?.pendingRef).toBeDefined();
  events.complete(
    captured!,
    "running-oracle",
    "complete",
    "Recovered full advisory; Human attention still required.",
  );
  await vi.waitFor(async () => {
    const state = await f.h.load();
    expect(state.oracle?.pendingRef).toBeUndefined();
    expect(state.oracle?.latestAdviceRef).toBeDefined();
    expect(state.block).toEqual(blocked.block);
    expect([...events.listeners.values()].every((set) => set.size === 0)).toBe(
      true,
    );
  });
  expect(events.emitted).toHaveLength(1);
});

test("advice at an existing hard-decision block never resolves Human/operator authority", async () => {
  const f = await setup();
  const state = await f.h.load();
  const blocked = await f.h.stateStore.saveState(
    {
      ...state,
      phase: "blocked",
      block: { blockedFrom: "planning", reason: "operator-attention-required" },
    },
    state.stateRevision,
  );
  await requestOracleAdvice(blocked, f.question, f.deps);
  const result = await f.h.drive({ subagentExecutor: f.executor });
  expect(result.state.phase).toBe("blocked");
  expect(result.state.block).toEqual(blocked.block);
  expect(result.state.oracle?.pendingRef).toBeUndefined();
  expect(await freshOracleAdvice(result.state, f.deps)).toEqual(
    result.state.oracle?.latestAdviceRef,
  );
  expect(f.h.children.some((child) => child.agent === "planner")).toBe(false);
});

test("post-code advice cannot bypass deterministic validation, typed decisions or Human Code Gate", async () => {
  const f = await setup();
  await f.h.createPlan();
  await f.h.settlePlan();
  await f.h.implement();
  await f.h.validate();
  await f.h.review();
  const source = await f.h.load();
  await requestOracleAdvice(
    source,
    {
      reason: "post-implementation-escalation",
      question: "Challenge the review assumptions, advisory only.",
    },
    f.deps,
  );
  const waiting = await f.h.drive({ subagentExecutor: f.executor });
  expect(waiting.state.phase).toBe("completed");
  expect(waiting.state.coding.validationRef).toEqual(
    source.coding.validationRef,
  );
  expect(waiting.state.coding.roundDecisionRef).toBeDefined();
  expect(waiting.state.coding.latestCodeReviewRef).toBeDefined();
  expect(
    f.h.gates.filter((gate) => gate.action === "code-review"),
  ).toHaveLength(1);
  expect(f.h.validations).toHaveLength(1);
  expect(f.oracle.calls.run).toHaveLength(1);
});

test("future Diagnosis/refinement/deviation producers have bounded decision-point seams, not authority shortcuts", async () => {
  const f = await setup();
  const state = await f.h.load();
  const planRef = await f.h.artifactStore.writeText(
    "plan",
    "candidate.md",
    "Candidate strategy, not approval",
  );
  const diagnosisRef = await f.h.artifactStore.writeText(
    "diagnosis",
    "diagnosis.md",
    "Competing hypotheses",
  );
  const workerAttemptRef = await f.h.artifactStore.writeText(
    "implementation",
    "stopped.md",
    "Stopped Worker evidence",
  );
  expect(() =>
    assertOracleReason(
      {
        ...state,
        playbook: "bugfix",
        phase: "gathering-context",
        planning: {
          ...state.planning,
          context: { ...state.planning.context, diagnosisRef },
        },
      },
      "competing-diagnosis",
    ),
  ).not.toThrow();
  expect(() =>
    assertOracleReason(
      { ...state, planning: { ...state.planning, currentPlanRef: planRef } },
      "planning-disagreement",
    ),
  ).not.toThrow();
  const latestDeviationRef = await f.h.artifactStore.writeText(
    "plan-deviation",
    "deviation.md",
    "Deviation evidence (pure decision-point guard fixture)",
  );
  expect(() =>
    assertOracleReason(
      { ...state, coding: { ...state.coding, workerAttemptRef } },
      "material-plan-deviation",
    ),
  ).toThrow();
  expect(() =>
    assertOracleReason(
      {
        ...state,
        coding: { ...state.coding, workerAttemptRef, latestDeviationRef },
      },
      "material-plan-deviation",
    ),
  ).not.toThrow();
  expect(() =>
    assertOracleReason(
      {
        ...state,
        planning: { ...state.planning, approvedPlanRef: planRef },
        coding: { ...state.coding, workerAttemptRef },
      },
      "material-plan-deviation",
    ),
  ).toThrow();
});

test("unavailable optional advice remains non-authoritative and does not make a mandatory consultation loop", async () => {
  const f = await setup("failed");
  await f.queue();
  const result = await f.h.drive({ subagentExecutor: f.executor });
  expect(result.state.phase).toBe("awaiting-plan-review");
  expect(result.state.oracle?.attemptsUsed).toBe(1);
  expect(result.state.oracle?.pendingRef).toBeUndefined();
  expect(result.state.planning.approvedPlanRef).toBeUndefined();
  expect(
    f.h.children.find((child) => child.agent === "planner")?.task,
  ).not.toContain("preflight unavailable");
});
