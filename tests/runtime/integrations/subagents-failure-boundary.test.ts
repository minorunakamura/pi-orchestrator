import { SubagentsIntegration } from "../../fakes/agent-launch.ts";
import { afterEach, expect, test, vi } from "vitest";
import {
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  SUBAGENT_RPC_REPLY_PREFIX,
  type EventBus,
} from "../../../src/runtime/integrations/subagents.ts";
import type { AgentRunResult } from "../../../src/runtime/ports/subagent-executor.ts";
import { FakeSubagentRpc } from "../../fakes/subagent-rpc.ts";

const input = { agent: "worker", task: "fake" };
const completed = {
  lifecycleArtifactVersion: 3,
  runId: "child-1",
  mode: "single",
  state: "complete",
  success: true,
  summary: "not authoritative",
  results: [{ agent: "worker", success: true, output: "full final output" }],
};
afterEach(() => vi.useRealTimers());
function released(bus: FakeSubagentRpc) {
  expect(
    [...bus.listeners.values()].every((listeners) => listeners.size === 0),
  ).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
}

test("Supervisor attention does not settle an async run; the same child's completion does", async () => {
  vi.useFakeTimers();
  const bus = new FakeSubagentRpc((request, rpc) =>
    rpc.receipt(request, "child-1"),
  );
  let result: AgentRunResult | undefined;
  const run = new SubagentsIntegration(bus, { timeoutMs: 100 })
    .run(input)
    .then((value) => {
      result = value;
    });
  await vi.advanceTimersByTimeAsync(10);
  bus.deliver("subagent:control-intercom", {
    runId: "child-1",
    reason: "need_decision",
  });
  await vi.advanceTimersByTimeAsync(10);
  expect(result).toBeUndefined();
  expect(bus.emitted).toHaveLength(1);
  bus.deliver(SUBAGENT_ASYNC_COMPLETE_EVENT, completed);
  await run;
  expect(result).toMatchObject({
    status: "succeeded",
    runId: "child-1",
    output: "full final output",
  });
  released(bus);
});

test.each([false, true])(
  "timeout is ambiguous, retaining the launch receipt if observed: %s",
  async (hasReceipt) => {
    vi.useFakeTimers();
    const bus = new FakeSubagentRpc((request, rpc) => {
      if (hasReceipt) rpc.receipt(request, "child-1");
    });
    const run = new SubagentsIntegration(bus, { timeoutMs: 20 }).run(input);
    await vi.advanceTimersByTimeAsync(21);
    const result = await run;
    expect(result).toMatchObject({ status: "ambiguous", timedOut: true });
    expect(result.runId).toBe(hasReceipt ? "child-1" : undefined);
    bus.deliver(SUBAGENT_ASYNC_COMPLETE_EVENT, completed);
    expect(result.status).toBe("ambiguous");
    expect(bus.emitted).toHaveLength(1);
    released(bus);
  },
);

test("correlates an early completion only after the matching spawn receipt", async () => {
  vi.useFakeTimers();
  const bus = new FakeSubagentRpc((request, rpc) => {
    rpc.deliver(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      ...completed,
      runId: "other-child",
    });
    rpc.deliver(SUBAGENT_ASYNC_COMPLETE_EVENT, completed);
    rpc.deliver(`${SUBAGENT_RPC_REPLY_PREFIX}${String(request.requestId)}`, {
      version: 1,
      requestId: "wrong",
      success: true,
      data: {
        details: {
          mode: "single",
          runId: "other-child",
          asyncId: "other-child",
        },
      },
    });
    rpc.receipt(request, "child-1");
  });
  await expect(new SubagentsIntegration(bus).run(input)).resolves.toMatchObject(
    { status: "succeeded", runId: "child-1" },
  );
  released(bus);
});

test("wrong run completion cannot settle an acknowledged child", async () => {
  vi.useFakeTimers();
  const bus = new FakeSubagentRpc((request, rpc) => {
    rpc.receipt(request, "child-1");
    rpc.deliver(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      ...completed,
      runId: "wrong",
    });
  });
  const run = new SubagentsIntegration(bus, { timeoutMs: 10 }).run(input);
  await vi.advanceTimersByTimeAsync(11);
  await expect(run).resolves.toMatchObject({
    status: "ambiguous",
    timedOut: true,
    runId: "child-1",
  });
  released(bus);
});

test.each([
  "failed",
  "malformed-identity",
  "malformed-result",
  "child-timeout",
  "paused",
  "truncated",
  "wrong-agent",
])("does not publish invalid or unsuccessful completions: %s", async (path) => {
  vi.useFakeTimers();
  const bus = new FakeSubagentRpc((request, rpc) => {
    if (path === "malformed-identity") {
      rpc.deliver(`${SUBAGENT_RPC_REPLY_PREFIX}${String(request.requestId)}`, {
        version: 1,
        requestId: request.requestId,
        success: true,
        data: { details: { mode: "single", runId: 123, asyncId: 123 } },
      });
      return;
    }
    rpc.receipt(request, "child-1");
    rpc.deliver(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      ...completed,
      ...(path === "failed" ? { state: "failed", success: false } : {}),
      ...(path === "paused" ? { state: "paused", success: false } : {}),
      ...(path === "child-timeout" ? { timedOut: true } : {}),
      results:
        path === "malformed-result"
          ? []
          : [
              {
                ...completed.results[0],
                ...(path === "truncated" ? { truncated: true } : {}),
                ...(path === "wrong-agent" ? { agent: "another-agent" } : {}),
              },
            ],
    });
  });
  const result = await new SubagentsIntegration(bus).run(input);
  expect(result.status).toBe(path === "failed" ? "failed" : "ambiguous");
  expect(result.runId).toBe(
    path === "malformed-identity" ? undefined : "child-1",
  );
  released(bus);
});

test.each(["stopped", "interrupted", "detached"])(
  "%s cannot turn a successful-looking display result into completion proof",
  async (flag) => {
    const bus = new FakeSubagentRpc((request, rpc) => {
      rpc.receipt(request, "child-1");
      rpc.deliver(SUBAGENT_ASYNC_COMPLETE_EVENT, {
        ...completed,
        [flag]: true,
      });
    });
    await expect(
      new SubagentsIntegration(bus).run(input),
    ).resolves.toMatchObject({ status: "ambiguous" });
  },
);

test.each([undefined, "child-failed"])(
  "single-agent failure does not require or infer workflow-only failureKind (%s)",
  async (failureKind) => {
    const bus = new FakeSubagentRpc((request, rpc) => {
      rpc.receipt(request, "child-1");
      rpc.deliver(SUBAGENT_ASYNC_COMPLETE_EVENT, {
        ...completed,
        state: "failed",
        success: false,
        ...(failureKind ? { failureKind } : {}),
        results: [
          { agent: "worker", success: false, error: "single child failed" },
        ],
      });
    });
    const result = await new SubagentsIntegration(bus).run(input);
    expect(result).toMatchObject({
      status: "failed",
      error: "single child failed",
    });
    expect(result).not.toHaveProperty("failureKind");
  },
);

test("RPC rejection is not proof that no child was launched", async () => {
  vi.useFakeTimers();
  const bus = new FakeSubagentRpc((request, rpc) =>
    rpc.deliver(`${SUBAGENT_RPC_REPLY_PREFIX}${String(request.requestId)}`, {
      version: 1,
      requestId: request.requestId,
      success: false,
      error: { code: "execution_failed", message: "failed after spawn" },
    }),
  );
  await expect(new SubagentsIntegration(bus).run(input)).resolves.toMatchObject(
    { status: "ambiguous" },
  );
  released(bus);
});

test.each(["completion", "timeout", "emit-throw"])(
  "unsubscribe throw cannot prevent single settlement: %s",
  async (path) => {
    vi.useFakeTimers();
    const bus = new FakeSubagentRpc((request, rpc) => {
      rpc.receipt(request, "child-1");
      if (path === "emit-throw") throw Error("launch status unknown");
      if (path === "completion")
        rpc.deliver(SUBAGENT_ASYNC_COMPLETE_EVENT, completed);
    });
    const cleanup = vi.fn(() => {
      throw Error("cleanup failed");
    });
    const events: EventBus = {
      emit: (event, payload) => bus.emit(event, payload),
      on: (event, listener) => {
        bus.on(event, listener);
        return cleanup;
      },
    };
    const results: AgentRunResult[] = [];
    void new SubagentsIntegration(events, { timeoutMs: 10 })
      .run(input)
      .then((r) => results.push(r));
    await vi.advanceTimersByTimeAsync(11);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe(
      path === "completion" ? "succeeded" : "ambiguous",
    );
    bus.deliver(SUBAGENT_ASYNC_COMPLETE_EVENT, completed);
    await vi.advanceTimersByTimeAsync(10);
    expect(results).toHaveLength(1);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("second subscription failure cleans up the first without emitting a request", async () => {
  vi.useFakeTimers();
  const bus = new FakeSubagentRpc();
  const events: EventBus = {
    emit: (event, payload) => bus.emit(event, payload),
    on: (event, listener) => {
      if (event !== SUBAGENT_ASYNC_COMPLETE_EVENT)
        throw Error("subscription unavailable");
      return bus.on(event, listener);
    },
  };
  await expect(
    new SubagentsIntegration(events).run(input),
  ).rejects.toMatchObject({ name: "SubagentNotDispatchedError" });
  expect(bus.emitted).toHaveLength(0);
  released(bus);
});

test("unsupported thinking is rejected before dispatch", async () => {
  const bus = new FakeSubagentRpc();
  await expect(
    new SubagentsIntegration(bus).run({
      ...input,
      executionProfile: {
        provider: "fake",
        model: "fake",
        thinking: "unsupported",
      },
    }),
  ).rejects.toMatchObject({ name: "SubagentNotDispatchedError" });
  expect(bus.emitted).toHaveLength(0);
});

test("parallel review remains bounded if only one child completes", async () => {
  vi.useFakeTimers();
  const bus = new FakeSubagentRpc((request, rpc) => {
    const id = String(request.agent);
    rpc.receipt(request, id);
    if (request.agent === "reviewer")
      rpc.complete(request, id, "complete", "clean");
  });
  const run = new SubagentsIntegration(bus, { timeoutMs: 10 }).runParallel([
    { agent: "reviewer", task: "review" },
    { agent: "ponytail-reviewer", task: "review" },
  ]);
  await vi.advanceTimersByTimeAsync(11);
  expect((await run).map((r) => r.status)).toEqual(["succeeded", "ambiguous"]);
  released(bus);
});
