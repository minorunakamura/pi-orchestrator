import { describe, expect, test } from "vitest";
import type { ArtifactRef } from "../../../src/core/artifacts/references.ts";
import {
  PLANNOTATOR_REQUEST_CHANNEL,
  PlannotatorIntegration,
  type PlannotatorEventBus,
} from "../../../src/runtime/integrations/plannotator.ts";
import type { PlannotatorResponse } from "../../../src/runtime/integrations/plannotator.ts";
import type { PlannotatorReviewId } from "../../../src/types.ts";

const planRef: ArtifactRef<"plan"> = {
  kind: "plan",
  path: "plans/plan-v1.md",
  schemaVersion: 1,
  sha256: "a".repeat(64),
};
const reviewId = "review-1" as unknown as PlannotatorReviewId;

type Request = {
  requestId: string;
  action: string;
  payload: Record<string, unknown>;
  respond(response: PlannotatorResponse): void;
};

class FakeEventBus implements PlannotatorEventBus {
  readonly calls: Array<{ channel: string; request: Request }> = [];

  constructor(private readonly responses: PlannotatorResponse[]) {}

  emit(channel: string, payload: unknown): void {
    const request = payload as Request;
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

  test("reconciles with a current plan binding after the adapter is recreated", async () => {
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
      gate.getPlanReview(reviewId, { planRef, planVersion: 1 }),
    ).resolves.toEqual({
      reviewId,
      planRef,
      planVersion: 1,
      status: "approved",
    });
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
