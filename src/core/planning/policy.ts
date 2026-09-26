import type { ArtifactRef } from "../artifacts/references.ts";

export const planSections = [
  "Scope / Requirements",
  "Architecture / Design",
  "Implementation Plan",
  "Validation Contract",
] as const;

export type PlanSection = (typeof planSections)[number];

export const requiredPlanSections = [
  "Scope / Requirements",
  "Implementation Plan",
  "Validation Contract",
] as const satisfies readonly PlanSection[];

export interface PlanParserPolicy {
  architectureRequired?: boolean;
}

export interface PlannerInput {
  taskRef: ArtifactRef<"task">;
  scoutRef: ArtifactRef<"scout">;
  researchRef?: ArtifactRef<"research">;
  clarificationRef?: ArtifactRef<"clarification">;
  previousPlanRef?: ArtifactRef<"plan">;
  feedbackRef?: ArtifactRef<"plan-review">;
  targetVersion: number;
}

export function planSectionsRequired(
  policy: PlanParserPolicy = {},
): readonly PlanSection[] {
  return policy.architectureRequired
    ? [
        ...requiredPlanSections.slice(0, 1),
        "Architecture / Design",
        ...requiredPlanSections.slice(1),
      ]
    : requiredPlanSections;
}

export function plannerInputRefs(input: PlannerInput): readonly ArtifactRef[] {
  return [
    input.taskRef,
    input.scoutRef,
    ...(input.researchRef ? [input.researchRef] : []),
    ...(input.clarificationRef ? [input.clarificationRef] : []),
    ...(input.previousPlanRef ? [input.previousPlanRef] : []),
    ...(input.feedbackRef ? [input.feedbackRef] : []),
  ];
}
