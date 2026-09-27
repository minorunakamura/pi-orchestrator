import { describe, expect, test } from "vitest";
import type { ArtifactRef } from "../../../src/core/artifacts/references.ts";
import {
  PLANNOTATOR_REQUEST_CHANNEL,
  PlannotatorIntegration,
  type PlannotatorEventBus,
} from "../../../src/runtime/integrations/plannotator.ts";
import type { PlannotatorResponse } from "../../../src/runtime/integrations/plannotator.ts";
import { plannotatorReviewId } from "../../../src/types.ts";
import { makeInvalidPayload } from "../../fakes/typed-boundaries.ts";

const planRef: ArtifactRef<"plan"> = {
  kind: "plan",
  path: "plans/plan-v1.md",
  schemaVersion: 1,
  sha256: "a".repeat(64),
};
const reviewId = plannotatorReviewId("review-1");
const implementationRef: ArtifactRef<"implementation"> = {
  kind: "implementation",
  path: "implementation/implementation-1.json",
  schemaVersion: 1,
  sha256: "b".repeat(64),
};

type Request = {
  requestId: string;
  action: string;
  payload: Record<string, unknown>;
  respond(response: PlannotatorResponse): void;
};

function isRequest(value: unknown): value is Request {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return (
    typeof Reflect.get(value, "requestId") === "string" &&
    typeof Reflect.get(value, "action") === "string" &&
    typeof Reflect.get(value, "payload") === "object" &&
    typeof Reflect.get(value, "respond") === "function"
  );
}

class FakeEventBus implements PlannotatorEventBus {
  readonly calls: Array<{ channel: string; request: Request }> = [];

  constructor(private readonly responses: PlannotatorResponse[]) {}

  emit(channel: string, payload: unknown): void {
    if (!isRequest(payload)) throw new Error("Invalid Plannotator request");
    const request = payload;
    this.calls.push({ channel, request });
    request.respond(this.responses.shift() ?? { status: "unavailable" });
  }
}

describe("PlannotatorIntegration", () => {
  test("uses the published request channel and binds the returned review id to the plan", async () => {
    const events = new FakeEventBus([
      {
        status: "handled",
        result: { status: "pending", reviewId },
      },
    ]);
    const gate = new PlannotatorIntegration({
      events,
      planReader: { readText: async () => "# Plan" },
      requestIdFactory: () => "request-1",
    });

    const handle = await gate.openPlanReview({ planRef, planVersion: 1 });

    expect(handle).toEqual({ reviewId, planRef, planVersion: 1 });
    expect(events.calls[0]).toMatchObject({
      channel: PLANNOTATOR_REQUEST_CHANNEL,
      request: {
        requestId: "request-1",
        action: "plan-review",
        payload: { planContent: "# Plan", origin: "pi-orchestrator" },
      },
    });
  });

  test("reconciles a completed approval through the public review-status response", async () => {
    const events = new FakeEventBus([
      {
        status: "handled",
        result: { status: "pending", reviewId },
      },
      {
        status: "handled",
        result: {
          status: "completed",
          reviewId,
          approved: true,
        },
      },
    ]);
    const gate = new PlannotatorIntegration({
      events,
      planReader: { readText: async () => "# Plan" },
    });
    await gate.openPlanReview({ planRef, planVersion: 1 });

    await expect(gate.getPlanReview(reviewId)).resolves.toEqual({
      reviewId,
      planRef,
      planVersion: 1,
      status: "approved",
    });
    expect(events.calls[1]).toMatchObject({
      request: { action: "review-status", payload: { reviewId } },
    });
  });

  test("reconciles with an exact persisted review binding after the adapter is recreated", async () => {
    const events = new FakeEventBus([
      {
        status: "handled",
        result: {
          status: "completed",
          reviewId,
          approved: true,
        },
      },
    ]);
    const gate = new PlannotatorIntegration({
      events,
      planReader: { readText: async () => "# Plan" },
    });

    await expect(
      gate.getPlanReview(reviewId, { reviewId, planRef, planVersion: 1 }),
    ).resolves.toEqual({
      reviewId,
      planRef,
      planVersion: 1,
      status: "approved",
    });
  });

  test("does not synthesize a binding for an unknown review after restart", async () => {
    const events = new FakeEventBus([
      {
        status: "handled",
        result: { status: "completed", reviewId, approved: true },
      },
    ]);
    const gate = new PlannotatorIntegration({
      events,
      planReader: { readText: async () => "# Plan" },
    });
    expect((await gate.getPlanReview(reviewId)).status).toBe("unknown");
    // Simulate the former current-plan-only runtime payload crossing the boundary.
    await expect(
      gate.getPlanReview(
        reviewId,
        makeInvalidPayload({ planRef, planVersion: 2 }),
      ),
    ).rejects.toMatchObject({ kind: "reconciliation" });
    await expect(
      gate.getPlanReview(reviewId, {
        reviewId: plannotatorReviewId("different"),
        planRef,
        planVersion: 1,
      }),
    ).rejects.toMatchObject({ kind: "reconciliation" });
    expect(events.calls).toHaveLength(0);
  });

  test("rejects persisted binding conflicting with the handle opened by this adapter", async () => {
    const events = new FakeEventBus([
      { status: "handled", result: { status: "pending", reviewId } },
    ]);
    const gate = new PlannotatorIntegration({
      events,
      planReader: { readText: async () => "# Plan" },
    });
    await gate.openPlanReview({ planRef, planVersion: 1 });
    await Promise.all([
      expect(
        gate.getPlanReview(reviewId, { reviewId, planRef, planVersion: 2 }),
      ).rejects.toMatchObject({ kind: "reconciliation" }),
      expect(
        gate.getPlanReview(reviewId, {
          reviewId,
          planRef: { ...planRef, sha256: "b".repeat(64) },
          planVersion: 1,
        }),
      ).rejects.toMatchObject({ kind: "reconciliation" }),
    ]);
    expect(events.calls).toHaveLength(1);
  });

  test("opens a code review with the exact implementation revision binding", async () => {
    const events = new FakeEventBus([
      {
        status: "handled",
        result: { status: "pending", reviewId },
      },
    ]);
    const gate = new PlannotatorIntegration({
      events,
      planReader: { readText: async () => "# Plan" },
    });

    await expect(
      gate.openCodeReview({ implementationRef, implementationRevision: 1 }),
    ).resolves.toEqual({
      reviewId,
      implementationRef,
      implementationRevision: 1,
    });
    expect(events.calls[0]).toMatchObject({
      request: {
        action: "code-review",
        payload: {
          implementationRef,
          implementationRevision: 1,
          origin: "pi-orchestrator",
        },
      },
    });
  });

  test("reconciles a code review with an exact persisted binding after adapter restart", async () => {
    const events = new FakeEventBus([
      {
        status: "handled",
        result: { status: "completed", reviewId, approved: true },
      },
    ]);
    const gate = new PlannotatorIntegration({
      events,
      planReader: { readText: async () => "# Plan" },
    });

    await expect(
      gate.getCodeReview(reviewId, {
        reviewId,
        implementationRef,
        implementationRevision: 1,
      }),
    ).resolves.toEqual({
      reviewId,
      implementationRef,
      implementationRevision: 1,
      status: "approved",
    });
  });

  test("rejects a code review binding that is not the persisted implementation", async () => {
    const events = new FakeEventBus([
      { status: "handled", result: { status: "pending", reviewId } },
    ]);
    const gate = new PlannotatorIntegration({
      events,
      planReader: { readText: async () => "# Plan" },
    });
    await gate.openCodeReview({ implementationRef, implementationRevision: 1 });

    await expect(
      gate.getCodeReview(reviewId, {
        reviewId,
        implementationRef,
        implementationRevision: 2,
      }),
    ).rejects.toMatchObject({ kind: "reconciliation" });
    expect(events.calls).toHaveLength(1);
  });

  test("rejects an external code-review result bound to another revision", async () => {
    const events = new FakeEventBus([
      {
        status: "handled",
        result: {
          status: "completed",
          reviewId,
          approved: true,
          implementationRevision: 2,
        },
      },
    ]);
    const gate = new PlannotatorIntegration({
      events,
      planReader: { readText: async () => "# Plan" },
    });

    await expect(
      gate.getCodeReview(reviewId, {
        reviewId,
        implementationRef,
        implementationRevision: 1,
      }),
    ).rejects.toMatchObject({ kind: "reconciliation" });
  });

  test("normalizes unavailable Plannotator to a port failure", async () => {
    const events = new FakeEventBus([
      {
        status: "unavailable",
        error: "extension is not loaded",
      },
    ]);
    const gate = new PlannotatorIntegration({
      events,
      planReader: { readText: async () => "# Plan" },
    });

    await expect(
      gate.openPlanReview({ planRef, planVersion: 1 }),
    ).rejects.toMatchObject({ kind: "infrastructure" });
  });
});
