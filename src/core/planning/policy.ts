import type { DevelopmentMethod } from "../decisions/planning-routing.ts";
import type { ArtifactRef } from "../artifacts/references.ts";

export const planSections = [
  "Scope / Requirements",
  "Architecture / Design",
  "Implementation Approach",
  "Expected Change Surface",
  "New Components",
  "New Dependencies",
  "Non-goals",
  "Development Method",
  "Test Seams",
  "Do not test",
  "Supporting Skills",
  "Validation Contract",
] as const;

export type PlanSection = (typeof planSections)[number];

export const requiredPlanSections = [
  "Scope / Requirements",
  "Implementation Approach",
  "Expected Change Surface",
  "New Components",
  "New Dependencies",
  "Non-goals",
  "Development Method",
  "Validation Contract",
] as const satisfies readonly PlanSection[];

export interface PlanParserPolicy {
  architectureRequired?: boolean;
  developmentMethod?: DevelopmentMethod;
}

export interface PlannerInput {
  taskRef: ArtifactRef<"task">;
  scoutRef: ArtifactRef<"scout">;
  diagnosisRef?: ArtifactRef<"diagnosis">;
  decisionRefs?: readonly ArtifactRef<
    "conditional-stage" | "clarification-mode" | "development-method"
  >[];
  researchRef?: ArtifactRef<"research">;
  clarificationRef?: ArtifactRef<"clarification">;
  domainDocumentRef?: ArtifactRef<"domain-document-write">;
  deviationRef?: ArtifactRef<"plan-deviation">;
  previousPlanRef?: ArtifactRef<"plan">;
  feedbackRef?: ArtifactRef<"plan-review">;
  advisoryRef?: ArtifactRef<"oracle-advisory">;
  simplicityRef?: ArtifactRef<"plan-simplicity-review">;
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
    ...(input.deviationRef ? [input.deviationRef] : []),
    ...(input.feedbackRef ? [input.feedbackRef] : []),
    ...(input.advisoryRef ? [input.advisoryRef] : []),
    ...(input.simplicityRef ? [input.simplicityRef] : []),
  ];
}
