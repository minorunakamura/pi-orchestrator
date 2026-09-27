export type Brand<T, B extends string> = T & {
  readonly __brand: B;
};

export type WorkflowId = Brand<string, "WorkflowId">;
export type SubagentRunId = Brand<string, "SubagentRunId">;
export type PlannotatorReviewId = Brand<string, "PlannotatorReviewId">;

export function isWorkflowId(value: unknown): value is WorkflowId {
  return typeof value === "string" && value.length > 0;
}

export function workflowId(value: string): WorkflowId {
  if (!isWorkflowId(value)) throw new Error("Workflow ID must not be empty");
  return value;
}

export function safeWorkflowId(value: string): WorkflowId {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw new Error("Workflow ID must be a safe non-empty path segment");
  }
  return workflowId(value);
}

export function isSubagentRunId(value: unknown): value is SubagentRunId {
  return typeof value === "string" && value.length > 0;
}

export function subagentRunId(value: string): SubagentRunId {
  if (!isSubagentRunId(value)) {
    throw new Error("Subagent run ID must not be empty");
  }
  return value;
}

export function isPlannotatorReviewId(
  value: unknown,
): value is PlannotatorReviewId {
  return typeof value === "string" && value.length > 0;
}

export function plannotatorReviewId(value: string): PlannotatorReviewId {
  if (!isPlannotatorReviewId(value)) {
    throw new Error("Plannotator review ID must not be empty");
  }
  return value;
}

export type PlaybookKind =
  | "new-project"
  | "feature"
  | "bugfix"
  | "hotfix"
  | "chore";
