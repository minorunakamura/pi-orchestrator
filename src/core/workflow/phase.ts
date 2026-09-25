import { isOneOf, parseSchema } from "../schema.ts";

export const workflowPhases = [
  "gathering-context",
  "clarifying",
  "planning",
  "awaiting-plan-review",
  "implementing",
  "validating",
  "reviewing",
  "fixing",
  "awaiting-code-review",
  "blocked",
  "completed",
  "failed",
] as const;

export type WorkflowPhase = (typeof workflowPhases)[number];

export function isWorkflowPhase(value: unknown): value is WorkflowPhase {
  return isOneOf(workflowPhases, value);
}

export function parseWorkflowPhase(value: unknown): WorkflowPhase {
  return parseSchema(value, isWorkflowPhase, "WorkflowPhase");
}
