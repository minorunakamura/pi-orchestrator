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
export type ResolvedStagePolicy = Exclude<StagePolicy, "conditional">;
export type PlaybookStagePolicy = Record<PlaybookStage, StagePolicy>;
export type ResolvedPlaybookStagePolicy = Record<
  PlaybookStage,
  ResolvedStagePolicy
>;

export interface PlaybookContext {
  requiresResearch?: boolean;
  requiresClarification?: boolean;
  requiresArchitecture?: boolean;
}

export const newProjectStagePolicy: PlaybookStagePolicy = Object.freeze({
  research: "required",
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
  research: "skip",
  clarification: "conditional",
  architecture: "skip",
  "plan-review": "required",
  "code-review": "required",
});

export const choreStagePolicy: PlaybookStagePolicy = Object.freeze({
  research: "skip",
  clarification: "skip",
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

function conditionalStageRuns(
  stage: PlaybookStage,
  context: PlaybookContext,
): boolean {
  switch (stage) {
    case "research":
      return context.requiresResearch === true;
    case "clarification":
      return context.requiresClarification === true;
    case "architecture":
      return context.requiresArchitecture === true;
    case "plan-review":
    case "code-review":
      return true;
  }
  return false;
}

export function resolveStagePolicy(
  stage: PlaybookStage,
  policy: StagePolicy,
  context: PlaybookContext = {},
): ResolvedStagePolicy {
  // Human Gates are hard v1 rules, not configurable stage choices.
  if (stage === "plan-review" || stage === "code-review") return "required";
  if (policy === "required") return "required";
  if (policy === "skip") return "skip";
  return conditionalStageRuns(stage, context) ? "required" : "skip";
}

export function getPlaybookStagePolicy(
  playbook: PlaybookKind,
): PlaybookStagePolicy {
  return { ...stagePolicies[playbook] };
}

export function resolvePlaybookPolicy(
  playbook: PlaybookKind,
  context: PlaybookContext = {},
): ResolvedPlaybookStagePolicy {
  const policy = stagePolicies[playbook];
  return {
    research: resolveStagePolicy("research", policy.research, context),
    clarification: resolveStagePolicy(
      "clarification",
      policy.clarification,
      context,
    ),
    architecture: resolveStagePolicy(
      "architecture",
      policy.architecture,
      context,
    ),
    "plan-review": resolveStagePolicy(
      "plan-review",
      policy["plan-review"],
      context,
    ),
    "code-review": resolveStagePolicy(
      "code-review",
      policy["code-review"],
      context,
    ),
  };
}
