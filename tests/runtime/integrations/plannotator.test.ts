import { describe, expect, test, vi } from "vitest";
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
        payload: { planContent: "# Plan" },
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

  test.each([true, false])(
    "uses the published settled Code result (approved=%s) and only public patch payload",
    async (approved) => {
      const result = {
        approved,
        feedback: "Human notes",
        annotations: [{ line: 1 }],
        agentSwitch: "untrusted-ui-hint",
      };
      const events = new FakeEventBus([{ status: "handled", result }]);
      const gate = new PlannotatorIntegration({
        events,
        planReader: { readText: async () => "# Plan" },
      });
      await expect(
        gate.openCodeReview({
          requestId: "local-request",
          cwd: "/workspace",
          patchFile: "/workspace/review.diff",
        }),
      ).resolves.toEqual({
        approved,
        feedback: "Human notes",
        annotations: [{ line: 1 }],
      });
      expect(events.calls[0]?.request).toMatchObject({
        requestId: "local-request",
        action: "code-review",
        payload: { cwd: "/workspace", patchFile: "/workspace/review.diff" },
      });
      expect(Object.keys(events.calls[0].request.payload)).toEqual([
        "cwd",
        "patchFile",
      ]);
      expect(events.calls.map((call) => call.request.action)).toEqual([
        "code-review",
      ]);
    },
  );
  test("supports the public Git review options", async () => {
    const events = new FakeEventBus([
      { status: "handled", result: { approved: true } },
    ]);
    const gate = new PlannotatorIntegration({
      events,
      planReader: { readText: async () => "# Plan" },
    });
    await gate.openCodeReview({
      requestId: "git-request",
      cwd: "/repo",
      diffType: "uncommitted",
      vcsType: "git",
      useLocal: true,
    });
    expect(events.calls[0].request.payload).toEqual({
      cwd: "/repo",
      diffType: "uncommitted",
      vcsType: "git",
      useLocal: true,
    });
  });
  test("Human deliberation beyond five seconds never becomes an integration timeout", async () => {
    vi.useFakeTimers();
    try {
      let request: Request | undefined;
      const gate = new PlannotatorIntegration({
        events: {
          emit: (_channel, payload) => {
            if (!isRequest(payload)) throw Error("request");
            request = payload;
          },
        },
        planReader: { readText: async () => "# Plan" },
      });
      let settled = false;
      const pending = gate
        .openCodeReview({
          requestId: "local-request",
          cwd: "/repo",
          patchFile: "review.diff",
        })
        .then((result) => {
          settled = true;
          return result;
        });
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(settled).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      request!.respond({ status: "handled", result: { approved: true } });
      request!.respond({ status: "handled", result: { approved: false } });
      await expect(pending).resolves.toEqual({ approved: true });
    } finally {
      vi.useRealTimers();
    }
  });
  test.each([
    { status: "pending", reviewId },
    {},
    { approved: "yes" },
    { approved: true, feedback: 1 },
    { approved: true, annotations: {} },
  ])("rejects invalid Code result %j", async (result) => {
    const gate = new PlannotatorIntegration({
      events: new FakeEventBus([{ status: "handled", result }]),
      planReader: { readText: async () => "# Plan" },
    });
    await expect(
      gate.openCodeReview({ requestId: "local", cwd: "/repo" }),
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
