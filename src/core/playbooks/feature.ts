import {
  getPlaybookStagePolicy,
  resolvePlaybookPolicy,
  featureStagePolicy,
  type PlaybookContext,
} from "./policy.ts";

export const playbookKind = "feature" as const;
export const stagePolicy = featureStagePolicy;

export function getStagePolicy(context: PlaybookContext = {}) {
  return resolvePlaybookPolicy(playbookKind, context);
}

export function getFeatureStagePolicy() {
  return getPlaybookStagePolicy(playbookKind);
}
