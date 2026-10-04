import type { ArtifactRef } from "../../core/artifacts/references.ts";
import type { PlannotatorReviewId } from "../../types.ts";
import type { PlanReviewBinding } from "../../core/workflow/state.ts";

export interface PlanReviewRequest {
  planRef: ArtifactRef<"plan">;
  planVersion: number;
  simplicityReviewRef?: ArtifactRef<"plan-simplicity-review">;
  simplicityPresentation?: string;
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
  requestId: string;
  cwd: string;
  /** Static patch is pinned by the Orchestrator before requesting review. */
  patchFile?: string;
  diffType?: "uncommitted";
  defaultBranch?: string;
  vcsType?: "git";
  useLocal?: boolean;
}

export interface CodeReviewResult {
  approved: boolean;
  feedback?: string;
  annotations?: unknown[];
}

export interface PlannotatorGate {
  openPlanReview(input: PlanReviewRequest): Promise<PlanReviewHandle>;
  getPlanReview(
    reviewId: PlannotatorReviewId,
    persistedBinding?: PlanReviewHandle,
  ): Promise<PlanReviewStatus>;
  openCodeReview(input: CodeReviewRequest): Promise<CodeReviewResult>;
}
