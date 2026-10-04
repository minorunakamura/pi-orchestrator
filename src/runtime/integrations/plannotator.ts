import { randomUUID } from "node:crypto";
import type { ArtifactRef } from "../../core/artifacts/references.ts";
import { plannotatorReviewId, type PlannotatorReviewId } from "../../types.ts";
import { isPlanReviewBinding } from "../../core/workflow/state.ts";
import { sameArtifactRef } from "../../core/workflow/invariants.ts";
import {
  RuntimePortError,
  type CodeReviewRequest,
  type CodeReviewResult,
  type PlanReviewHandle,
  type PlanReviewRequest,
  type PlanReviewStatus,
  type PlannotatorGate,
} from "../ports/index.ts";

/** Public channel exported by @plannotator/pi-extension. */
export const PLANNOTATOR_REQUEST_CHANNEL = "plannotator:request" as const;

export const PLANNOTATOR_TIMEOUT_MS = 5_000;

type PlannotatorAction = "plan-review" | "code-review" | "review-status";

export interface PlannotatorEventBus {
  emit(channel: string, payload: unknown): void | Promise<void>;
}

export interface PlannotatorPlanReader {
  readText(ref: ArtifactRef<"plan">): Promise<string>;
}

export interface PlannotatorIntegrationOptions {
  events: PlannotatorEventBus;
  planReader: PlannotatorPlanReader;
  timeoutMs?: number;
  requestIdFactory?: () => string;
}

export interface PlannotatorResponse {
  status: "handled" | "unavailable" | "error";
  result?: unknown;
  error?: string;
}

interface ReviewStartResult {
  status: "pending";
  reviewId: string;
}

interface ReviewStatusResult {
  status: "pending" | "missing" | "completed";
  reviewId?: string;
  approved?: boolean;
  feedback?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertReviewStartResult(
  value: unknown,
  reviewType: "plan-review" | "code-review",
): ReviewStartResult {
  if (
    !isRecord(value) ||
    value.status !== "pending" ||
    !isNonEmptyString(value.reviewId)
  ) {
    throw new RuntimePortError(
      "infrastructure",
      `Plannotator returned an invalid ${reviewType} start response`,
    );
  }
  return { status: "pending", reviewId: value.reviewId };
}

function parseReviewStatusResult(
  value: unknown,
  requestedReviewId: PlannotatorReviewId,
): ReviewStatusResult {
  if (!isRecord(value) || typeof value.status !== "string") {
    throw new RuntimePortError(
      "reconciliation",
      "Plannotator returned an invalid review-status response",
    );
  }
  if (value.reviewId !== undefined && value.reviewId !== requestedReviewId) {
    throw new RuntimePortError(
      "reconciliation",
      "Plannotator review identity changed during reconciliation",
    );
  }
  if (
    value.status !== "pending" &&
    value.status !== "missing" &&
    value.status !== "completed"
  ) {
    throw new RuntimePortError(
      "reconciliation",
      "Plannotator returned an unknown review status",
    );
  }
  if (value.status === "completed" && typeof value.approved !== "boolean") {
    throw new RuntimePortError(
      "reconciliation",
      "Plannotator completed review is missing approval state",
    );
  }
  if (value.feedback !== undefined && typeof value.feedback !== "string") {
    throw new RuntimePortError(
      "reconciliation",
      "Plannotator feedback must be a string",
    );
  }
  const responseReviewId = value.reviewId;
  const responseApproved = value.approved;
  const responseFeedback = value.feedback;
  return {
    status: value.status,
    ...(typeof responseReviewId === "string"
      ? { reviewId: responseReviewId }
      : {}),
    ...(typeof responseApproved === "boolean"
      ? { approved: responseApproved }
      : {}),
    ...(typeof responseFeedback === "string"
      ? { feedback: responseFeedback }
      : {}),
  };
}

function normalizeResponse(response: unknown): unknown {
  if (!isRecord(response) || typeof response.status !== "string") {
    throw new RuntimePortError(
      "infrastructure",
      "Plannotator returned an invalid response envelope",
    );
  }
  if (response.status === "handled") return response.result;
  if (response.status === "unavailable") {
    throw new RuntimePortError(
      "infrastructure",
      typeof response.error === "string"
        ? response.error
        : "Plannotator is unavailable",
    );
  }
  if (response.status === "error") {
    throw new RuntimePortError(
      "domain",
      typeof response.error === "string"
        ? response.error
        : "Plannotator rejected the request",
    );
  }
  throw new RuntimePortError(
    "infrastructure",
    "Plannotator returned an unknown response status",
  );
}

function reviewKey(reviewId: PlannotatorReviewId): string {
  return reviewId;
}

/**
 * Adapter for the published Plannotator Pi event-bus contract.
 *
 * It deliberately keeps plan identity on the orchestrator side: Plannotator
 * returns only a review id, so settled results are bound to the exact handle
 * created for the submitted plan before they cross the runtime port.
 */
export class PlannotatorIntegration implements PlannotatorGate {
  private readonly events: PlannotatorEventBus;
  private readonly planReader: PlannotatorPlanReader;
  private readonly timeoutMs: number;
  private readonly requestIdFactory: () => string;
  private readonly reviews = new Map<string, PlanReviewHandle>();

  constructor(options: PlannotatorIntegrationOptions) {
    if (!Number.isSafeInteger(options.timeoutMs ?? PLANNOTATOR_TIMEOUT_MS)) {
      throw new Error("Plannotator timeoutMs must be a safe integer");
    }
    if ((options.timeoutMs ?? PLANNOTATOR_TIMEOUT_MS) <= 0) {
      throw new Error("Plannotator timeoutMs must be positive");
    }
    this.events = options.events;
    this.planReader = options.planReader;
    this.timeoutMs = options.timeoutMs ?? PLANNOTATOR_TIMEOUT_MS;
    this.requestIdFactory = options.requestIdFactory ?? randomUUID;
  }

  async openPlanReview(input: PlanReviewRequest): Promise<PlanReviewHandle> {
    let planContent: string;
    try {
      planContent = await this.planReader.readText(input.planRef);
    } catch (error) {
      if (error instanceof RuntimePortError) throw error;
      throw new RuntimePortError(
        "infrastructure",
        `Unable to read plan for Plannotator: ${asErrorMessage(error)}`,
        { cause: error },
      );
    }
    if (planContent.trim().length === 0) {
      throw new RuntimePortError(
        "domain",
        "Cannot open an empty plan in Plannotator",
      );
    }

    const result = assertReviewStartResult(
      await this.request("plan-review", {
        planContent: planContent + (input.simplicityPresentation ?? ""),
      }),
      "plan-review",
    );
    const handle: PlanReviewHandle = {
      reviewId: plannotatorReviewId(result.reviewId),
      planRef: input.planRef,
      planVersion: input.planVersion,
      ...(input.simplicityReviewRef
        ? { simplicityReviewRef: input.simplicityReviewRef }
        : {}),
    };
    this.reviews.set(reviewKey(handle.reviewId), handle);
    return handle;
  }

  async getPlanReview(
    reviewId: PlannotatorReviewId,
    persistedBinding?: PlanReviewHandle,
  ): Promise<PlanReviewStatus> {
    const cached = this.reviews.get(reviewKey(reviewId));
    if (
      persistedBinding !== undefined &&
      (!isPlanReviewBinding(persistedBinding) ||
        persistedBinding.reviewId !== reviewId ||
        (cached &&
          (cached.planVersion !== persistedBinding.planVersion ||
            !sameArtifactRef(cached.planRef, persistedBinding.planRef) ||
            (cached.simplicityReviewRef !== undefined &&
              !sameArtifactRef(
                cached.simplicityReviewRef,
                persistedBinding.simplicityReviewRef,
              )))))
    ) {
      throw new RuntimePortError(
        "reconciliation",
        "Persisted plan review binding does not match the review identity",
      );
    }
    const handle = cached ?? persistedBinding;
    if (!handle) {
      return {
        reviewId,
        status: "unknown",
        reason: "No exact plan review binding is available",
      };
    }
    const result = parseReviewStatusResult(
      await this.request("review-status", { reviewId }),
      reviewId,
    );
    if (result.status === "pending") return { ...handle, status: "pending" };
    if (result.status === "missing") {
      return {
        reviewId,
        status: "unknown",
        reason: "Plannotator no longer has the review",
      };
    }
    if (result.approved) return { ...handle, status: "approved" };
    return {
      ...handle,
      status: "feedback",
      feedback: result.feedback ?? "",
    };
  }

  async openCodeReview(input: CodeReviewRequest): Promise<CodeReviewResult> {
    if (
      !isRecord(input) ||
      Object.keys(input).some(
        (key) =>
          ![
            "requestId",
            "cwd",
            "patchFile",
            "diffType",
            "defaultBranch",
            "vcsType",
            "useLocal",
          ].includes(key),
      ) ||
      !isNonEmptyString(input.requestId) ||
      !isNonEmptyString(input.cwd) ||
      (input.patchFile !== undefined && !isNonEmptyString(input.patchFile)) ||
      (input.diffType !== undefined && input.diffType !== "uncommitted") ||
      (input.vcsType !== undefined && input.vcsType !== "git") ||
      (input.useLocal !== undefined && typeof input.useLocal !== "boolean") ||
      (input.defaultBranch !== undefined &&
        !isNonEmptyString(input.defaultBranch))
    )
      throw new RuntimePortError(
        "domain",
        "Code review requires an exact local request and source",
      );
    const { requestId, ...payload } = input;
    const result = await this.request("code-review", payload, requestId);
    if (
      !isRecord(result) ||
      typeof result.approved !== "boolean" ||
      (result.feedback !== undefined && typeof result.feedback !== "string") ||
      (result.annotations !== undefined && !Array.isArray(result.annotations))
    )
      throw new RuntimePortError(
        "reconciliation",
        "Plannotator returned an invalid settled Code Review result",
      );
    // agentSwitch and other UI hints do not grant workflow authority.
    return {
      approved: result.approved,
      ...(typeof result.feedback === "string"
        ? { feedback: result.feedback }
        : {}),
      ...(Array.isArray(result.annotations)
        ? { annotations: structuredClone(result.annotations) }
        : {}),
    };
  }

  private request(
    action: PlannotatorAction,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<unknown> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (response: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          resolve(normalizeResponse(response));
        } catch (error) {
          resolve(Promise.reject(error));
        }
      };
      // Code Review settles only after the Human; elapsed time is not failure.
      if (action !== "code-review")
        timer = setTimeout(() => {
          finish({
            status: "unavailable",
            error: `Plannotator did not respond within ${this.timeoutMs}ms`,
          } satisfies PlannotatorResponse);
        }, this.timeoutMs);
      const request = {
        requestId: requestId ?? this.requestIdFactory(),
        action,
        payload,
        respond: finish,
      };
      try {
        Promise.resolve(
          this.events.emit(PLANNOTATOR_REQUEST_CHANNEL, request),
        ).catch((error: unknown) =>
          finish({
            status: "error",
            error: asErrorMessage(error),
          } satisfies PlannotatorResponse),
        );
      } catch (error) {
        finish({
          status: "error",
          error: asErrorMessage(error),
        } satisfies PlannotatorResponse);
      }
    });
  }
}

export const PlannotatorAdapter = PlannotatorIntegration;

export function createPlannotatorGate(
  options: PlannotatorIntegrationOptions,
): PlannotatorGate {
  return new PlannotatorIntegration(options);
}
