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
  diagnosisRef?: ArtifactRef<"diagnosis">;
  decisionRefs?: readonly ArtifactRef<
    "conditional-stage" | "clarification-mode"
  >[];
  researchRef?: ArtifactRef<"research">;
  clarificationRef?: ArtifactRef<"clarification">;
  domainDocumentRef?: ArtifactRef<"domain-document-write">;
  previousPlanRef?: ArtifactRef<"plan">;
  feedbackRef?: ArtifactRef<"plan-review">;
  advisoryRef?: ArtifactRef<"oracle-advisory">;
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
    ...(input.diagnosisRef ? [input.diagnosisRef] : []),
    ...(input.decisionRefs ?? []),
    ...(input.researchRef ? [input.researchRef] : []),
    ...(input.clarificationRef ? [input.clarificationRef] : []),
    ...(input.domainDocumentRef ? [input.domainDocumentRef] : []),
    ...(input.previousPlanRef ? [input.previousPlanRef] : []),
    ...(input.feedbackRef ? [input.feedbackRef] : []),
    ...(input.advisoryRef ? [input.advisoryRef] : []),
  ];
}
