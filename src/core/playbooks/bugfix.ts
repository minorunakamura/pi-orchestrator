import {
  getPlaybookStagePolicy,
  resolvePlaybookPolicy,
  bugfixStagePolicy,
  type PlaybookContext,
} from "./policy.ts";

export const playbookKind = "bugfix" as const;
export const stagePolicy = bugfixStagePolicy;

export function getStagePolicy(context: PlaybookContext = {}) {
  return resolvePlaybookPolicy(playbookKind, context);
}

export function getBugfixStagePolicy() {
  return getPlaybookStagePolicy(playbookKind);
}
