import { describe, expect, test } from "vitest";
import type { ArtifactRef } from "../../../src/core/artifacts/references.ts";
import {
  SubagentsIntegration,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  type EventBus,
} from "../../../src/runtime/integrations/subagents.ts";
import type { AgentRunRequest } from "../../../src/runtime/ports/index.ts";
import { requireRecord } from "../../fakes/typed-boundaries.ts";

const planRef: ArtifactRef<"plan"> = {
  kind: "plan",
  path: "plans/plan-v1.md",
  schemaVersion: 1,
  sha256: "a".repeat(64),
};
const contextRef: ArtifactRef<"scout"> = {
  kind: "scout",
  path: "context/scout.md",
  schemaVersion: 1,
  sha256: "b".repeat(64),
};

class FakeEventBus implements EventBus {
  readonly emitted: { event: string; payload: unknown }[] = [];
  private readonly listeners = new Map<
    string,
    Set<(payload: unknown) => void>
  >();

  emit(event: string, payload: unknown): void {
    this.emitted.push({ event, payload });
    if (event !== SUBAGENT_DELEGATION_REQUEST_EVENT) return;
    const request = requireRecord(payload);
    for (const listener of this.listeners.get(
      SUBAGENT_DELEGATION_RESPONSE_EVENT,
    ) ?? []) {
      listener({
        requestId: request.requestId,
        ownerRunId: request.ownerRunId,
        nodeId: request.nodeId,
        status: "completed",
        runId: "run-1",
        result: { kind: "text", text: "implemented" },
      });
    }
  }

  on(event: string, listener: (payload: unknown) => void): () => void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return () => listeners.delete(listener);
  }
}

describe("SubagentsIntegration", () => {
  test("runs reviewer requests in parallel with a fresh context", async () => {
    const events = new FakeEventBus();
    const integration = new SubagentsIntegration(events, {
      ownerRunId: "workflow-1",
    });

    await expect(
      integration.runParallel([
        { agent: "reviewer", task: "Return structured correctness findings." },
        {
          agent: "ponytail-reviewer",
          task: "Return structured simplicity findings.",
        },
      ]),
    ).resolves.toHaveLength(2);

    const requests = events.emitted
      .filter(({ event }) => event === SUBAGENT_DELEGATION_REQUEST_EVENT)
      .map(({ payload }) => requireRecord(payload));
    expect(requests.map((request) => request.agent)).toEqual([
      "reviewer",
      "ponytail-reviewer",
    ]);
    expect(requests.every((request) => request.context === "fresh")).toBe(true);
  });

  test("uses only the public delegation contract and carries refs/profile", async () => {
    const events = new FakeEventBus();
    const input: AgentRunRequest = {
      agent: "worker",
      task: "Implement the approved change.",
      cwd: "/repo",
      inputRefs: [planRef, contextRef],
      executionProfile: {
        provider: "provider-a",
        model: "model-a",
        thinking: "high",
      },
    };

    await expect(
      new SubagentsIntegration(events, { ownerRunId: "workflow-1" }).run(input),
    ).resolves.toMatchObject({ status: "succeeded", output: "implemented" });

    const request = requireRecord(
      events.emitted.find(
        ({ event }) => event === SUBAGENT_DELEGATION_REQUEST_EVENT,
      )?.payload,
    );
    expect(request).toMatchObject({
      agent: "worker",
      cwd: "/repo",
      model: "provider-a/model-a",
      thinking: "high",
      result: { kind: "text" },
    });
    expect(request.task).toContain(JSON.stringify([planRef, contextRef]));
    expect(request).not.toHaveProperty("provider");
    expect(request).not.toHaveProperty("inputRefs");
  });
});
