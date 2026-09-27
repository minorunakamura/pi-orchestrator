import { afterEach, expect, test, vi } from "vitest";
import {
  SubagentsIntegration,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  type EventBus,
} from "../../../src/runtime/integrations/subagents.ts";
import type { AgentRunResult } from "../../../src/runtime/ports/subagent-executor.ts";

function bus(
  respond?: (
    request: Record<string, unknown>,
    deliver: (value: unknown) => void,
  ) => void,
) {
  const listeners = new Set<(value: unknown) => void>();
  const deliver = (value: unknown) => {
    for (const listener of listeners) listener(value);
  };
  const events: EventBus = {
    emit: (event, payload) => {
      if (event === SUBAGENT_DELEGATION_REQUEST_EVENT)
        respond?.(payload as Record<string, unknown>, deliver);
    },
    on: (_event, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { events, listeners, deliver };
}
afterEach(() => vi.useRealTimers());

test("absent responder settles as ambiguous timeout and releases the listener", async () => {
  vi.useFakeTimers();
  const b = bus();
  let result: AgentRunResult | undefined;
  void new SubagentsIntegration(b.events, { timeoutMs: 20 })
    .run({ agent: "worker", task: "fake only" })
    .then((value) => {
      result = value;
    });
  await vi.advanceTimersByTimeAsync(21);
  expect(result).toMatchObject({ status: "ambiguous", timedOut: true });
  expect(result?.runId).toBeUndefined();
  expect(b.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
test("wrong identity cannot settle and late result cannot revive timed-out work", async () => {
  vi.useFakeTimers();
  let sent: Record<string, unknown> = {};
  const b = bus((req, deliver) => {
    sent = req;
    deliver({
      ...req,
      requestId: "wrong",
      status: "completed",
      runId: "wrong",
      result: { kind: "text", text: "unsafe" },
    });
  });
  let result: AgentRunResult | undefined;
  void new SubagentsIntegration(b.events, { timeoutMs: 10 })
    .run({ agent: "worker", task: "fake" })
    .then((value) => {
      result = value;
    });
  await vi.advanceTimersByTimeAsync(11);
  expect(result).toMatchObject({ status: "ambiguous", timedOut: true });
  b.deliver({
    ...sent,
    status: "completed",
    runId: "late",
    result: { kind: "text", text: "late" },
  });
  expect(result?.runId).toBeUndefined();
  expect(b.listeners.size).toBe(0);
});
test("malformed run identity never becomes a successful response", async () => {
  vi.useFakeTimers();
  const b = bus((request, deliver) =>
    deliver({
      ...request,
      status: "completed",
      runId: 123,
      result: { kind: "text", text: "must not become authority" },
    }),
  );
  let result: AgentRunResult | undefined;
  void new SubagentsIntegration(b.events, { timeoutMs: 10 })
    .run({ agent: "worker", task: "fake" })
    .then((value) => {
      result = value;
    });
  await vi.advanceTimersByTimeAsync(11);
  expect(result?.status).toBe("ambiguous");
  expect(result?.runId).toBeUndefined();
  expect(b.listeners.size).toBe(0);
});

test("deadline and response race settles once and cleans up", async () => {
  vi.useFakeTimers();
  const b = bus((request, deliver) => {
    setTimeout(
      () =>
        deliver({
          ...request,
          status: "completed",
          runId: "late",
          result: { kind: "text", text: "done" },
        }),
      10,
    );
  });
  let settlements = 0;
  void new SubagentsIntegration(b.events, { timeoutMs: 10 })
    .run({ agent: "worker", task: "fake" })
    .then(() => {
      settlements++;
    });
  await vi.advanceTimersByTimeAsync(11);
  expect(settlements).toBe(1);
  expect(b.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

test("parallel review finishes boundedly when one reviewer never replies", async () => {
  vi.useFakeTimers();
  const b = bus((request, deliver) => {
    if (request.agent === "reviewer")
      deliver({
        ...request,
        status: "completed",
        runId: "review-1",
        result: { kind: "text", text: "clean" },
      });
  });
  let results: AgentRunResult[] | undefined;
  void new SubagentsIntegration(b.events, { timeoutMs: 10 })
    .runParallel([
      { agent: "reviewer", task: "fake" },
      { agent: "ponytail-reviewer", task: "fake" },
    ])
    .then((value) => {
      results = value;
    });
  await vi.advanceTimersByTimeAsync(11);
  expect(results?.map((result) => result.status)).toEqual([
    "succeeded",
    "ambiguous",
  ]);
  expect(b.listeners.size).toBe(0);
});

test("child timeout retains actual run identity without calling it a proven failure", async () => {
  const b = bus((req, deliver) =>
    deliver({ ...req, status: "timed_out", runId: "exact-child" }),
  );
  await expect(
    new SubagentsIntegration(b.events, { timeoutMs: 20 }).run({
      agent: "worker",
      task: "fake",
    }),
  ).resolves.toMatchObject({
    status: "ambiguous",
    timedOut: true,
    runId: "exact-child",
  });
});
test("unsupported profile is explicitly not dispatched", async () => {
  const b = bus();
  await expect(
    new SubagentsIntegration(b.events, { timeoutMs: 10 }).run({
      agent: "worker",
      task: "fake",
      executionProfile: {
        provider: "fake",
        model: "fake",
        thinking: "unsupported",
      },
    }),
  ).rejects.toMatchObject({ name: "SubagentNotDispatchedError" });
  expect(b.listeners.size).toBe(0);
});

test("emit throw may follow dispatch and is normalized as ambiguous", async () => {
  const b = bus(() => {
    throw Error("handler threw after launching");
  });
  await expect(
    new SubagentsIntegration(b.events, { timeoutMs: 20 }).run({
      agent: "worker",
      task: "fake",
    }),
  ).resolves.toMatchObject({ status: "ambiguous" });
  expect(b.listeners.size).toBe(0);
});
