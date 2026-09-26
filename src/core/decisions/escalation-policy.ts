import type { EscalationReason } from "./types.ts";

export type EscalationTarget =
  | "stronger-execution"
  | "planning"
  | "clarification";

export type EscalationEvent =
  | "STRONGER_RETRY_REQUIRED"
  | "REPLAN_REQUIRED"
  | "CLARIFICATION_REQUIRED";

export interface EscalationRoute {
  reason: EscalationReason;
  target: EscalationTarget;
  event: EscalationEvent;
}

const routes: Record<EscalationReason, EscalationRoute> = {
  "implementation-capability": {
    reason: "implementation-capability",
    target: "stronger-execution",
    event: "STRONGER_RETRY_REQUIRED",
  },
  "plan-conflict": {
    reason: "plan-conflict",
    target: "planning",
    event: "REPLAN_REQUIRED",
  },
  "human-decision": {
    reason: "human-decision",
    target: "clarification",
    event: "CLARIFICATION_REQUIRED",
  },
  uncertain: {
    reason: "uncertain",
    target: "clarification",
    event: "CLARIFICATION_REQUIRED",
  },
};

export function mapEscalationReason(reason: EscalationReason): EscalationRoute {
  const route = routes[reason];
  if (!route) throw new Error(`Unsupported escalation reason: ${reason}`);
  return { ...route };
}
