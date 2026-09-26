import {
  getPlaybookStagePolicy,
  resolvePlaybookPolicy,
  hotfixStagePolicy,
  type PlaybookContext,
} from "./policy.ts";

export const playbookKind = "hotfix" as const;
export const stagePolicy = hotfixStagePolicy;

export function getStagePolicy(context: PlaybookContext = {}) {
  return resolvePlaybookPolicy(playbookKind, context);
}

export function getHotfixStagePolicy() {
  return getPlaybookStagePolicy(playbookKind);
}
