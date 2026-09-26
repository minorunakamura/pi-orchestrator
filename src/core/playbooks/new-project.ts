import {
  getPlaybookStagePolicy,
  resolvePlaybookPolicy,
  newProjectStagePolicy,
  type PlaybookContext,
} from "./policy.ts";

export const playbookKind = "new-project" as const;
export const stagePolicy = newProjectStagePolicy;

export function getStagePolicy(context: PlaybookContext = {}) {
  return resolvePlaybookPolicy(playbookKind, context);
}

export function getNewProjectStagePolicy() {
  return getPlaybookStagePolicy(playbookKind);
}
