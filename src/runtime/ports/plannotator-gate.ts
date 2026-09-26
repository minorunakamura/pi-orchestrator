import type { ArtifactRef } from "../../core/artifacts/references.ts";
import type { PlannotatorReviewId } from "../../types.ts";
import type { PlanReviewBinding } from "../../core/workflow/state.ts";

export interface PlanReviewRequest {
  planRef: ArtifactRef<"plan">;
  planVersion: number;
}

export type PlanReviewHandle = PlanReviewBinding;

export type PlanReviewStatus =
  | (PlanReviewHandle & { status: "pending" })
  | (PlanReviewHandle & { status: "approved" })
  | (PlanReviewHandle & { status: "feedback"; feedback: string })
  | {
      reviewId: PlannotatorReviewId;
      status: "unknown";
      reason?: string;
    };

export interface CodeReviewRequest {
  implementationRef: ArtifactRef<"implementation">;
  implementationRevision: number;
}

export interface CodeReviewHandle {
  reviewId: PlannotatorReviewId;
  implementationRef: ArtifactRef<"implementation">;
  implementationRevision: number;
}

export type CodeReviewStatus =
  | (CodeReviewHandle & { status: "pending" })
  | (CodeReviewHandle & { status: "approved" })
  | (CodeReviewHandle & { status: "feedback"; feedback: string })
  | {
      reviewId: PlannotatorReviewId;
      status: "unknown";
      reason?: string;
    };

export interface PlannotatorGate {
  openPlanReview(input: PlanReviewRequest): Promise<PlanReviewHandle>;
  getPlanReview(
    reviewId: PlannotatorReviewId,
    persistedBinding?: PlanReviewHandle,
  ): Promise<PlanReviewStatus>;
  openCodeReview(input: CodeReviewRequest): Promise<CodeReviewHandle>;
  getCodeReview(reviewId: PlannotatorReviewId): Promise<CodeReviewStatus>;
}
