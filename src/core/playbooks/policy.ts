import type { PlaybookKind } from "../../types.ts";

export const playbookKinds = [
  "new-project",
  "feature",
  "bugfix",
  "hotfix",
  "chore",
] as const satisfies readonly PlaybookKind[];

export const playbookStages = [
  "research",
  "clarification",
  "architecture",
  "plan-review",
  "code-review",
] as const;

export type PlaybookStage = (typeof playbookStages)[number];
export type StagePolicy = "required" | "conditional" | "skip";
export type PlaybookStagePolicy = Record<PlaybookStage, StagePolicy>;

/** Legacy hints are accepted at the API boundary but never resolve authority. */
export interface PlaybookContext {
  requiresResearch?: boolean;
  requiresClarification?: boolean;
  requiresArchitecture?: boolean;
}

export const newProjectStagePolicy: PlaybookStagePolicy = Object.freeze({
  research: "conditional",
  clarification: "conditional",
  architecture: "required",
  "plan-review": "required",
  "code-review": "required",
});

export const featureStagePolicy: PlaybookStagePolicy = Object.freeze({
  research: "conditional",
  clarification: "conditional",
  architecture: "conditional",
  "plan-review": "required",
  "code-review": "required",
});

export const bugfixStagePolicy: PlaybookStagePolicy = Object.freeze({
  research: "conditional",
  clarification: "conditional",
  architecture: "conditional",
  "plan-review": "required",
  "code-review": "required",
});

export const hotfixStagePolicy: PlaybookStagePolicy = Object.freeze({
  research: "conditional",
  clarification: "conditional",
  architecture: "skip",
  "plan-review": "required",
  "code-review": "required",
});

export const choreStagePolicy: PlaybookStagePolicy = Object.freeze({
  research: "conditional",
  clarification: "conditional",
  architecture: "skip",
  "plan-review": "required",
  "code-review": "required",
});

const stagePolicies: Record<PlaybookKind, PlaybookStagePolicy> = {
  "new-project": newProjectStagePolicy,
  feature: featureStagePolicy,
  bugfix: bugfixStagePolicy,
  hotfix: hotfixStagePolicy,
  chore: choreStagePolicy,
};

export function getPlaybookStagePolicy(
  playbook: PlaybookKind,
): PlaybookStagePolicy {
  return { ...stagePolicies[playbook] };
}

/** @deprecated Conditional policy stays unresolved until durable evidence exists. */
export function resolvePlaybookPolicy(
  playbook: PlaybookKind,
  _context?: PlaybookContext,
): PlaybookStagePolicy {
  return getPlaybookStagePolicy(playbook);
}
