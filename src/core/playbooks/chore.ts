import {
  getPlaybookStagePolicy,
  resolvePlaybookPolicy,
  choreStagePolicy,
  type PlaybookContext,
} from "./policy.ts";

export const playbookKind = "chore" as const;
export const stagePolicy = choreStagePolicy;

export function getStagePolicy(context: PlaybookContext = {}) {
  return resolvePlaybookPolicy(playbookKind, context);
}

export function getChoreStagePolicy() {
  return getPlaybookStagePolicy(playbookKind);
}
