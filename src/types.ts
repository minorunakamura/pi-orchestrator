export type Brand<T, B extends string> = T & {
  readonly __brand: B;
};

export type WorkflowId = Brand<string, "WorkflowId">;
export type SubagentRunId = Brand<string, "SubagentRunId">;
export type PlannotatorReviewId = Brand<string, "PlannotatorReviewId">;

export type PlaybookKind =
  | "new-project"
  | "feature"
  | "bugfix"
  | "hotfix"
  | "chore";
