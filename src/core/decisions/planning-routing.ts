import { isArtifactRef, type ArtifactRef } from "../artifacts/references.ts";
import {
  isClassifierIdentity,
  type ClassifierIdentity,
} from "../configuration.ts";
import {
  hasOnlyKeys,
  isConfidence,
  isOneOf,
  isRecord,
  parseSchema,
} from "../schema.ts";
import { playbookKinds, type StagePolicy } from "../playbooks/policy.ts";
import type { PlaybookKind } from "../../types.ts";
import type { Decision } from "./types.ts";

export const conditionalStages = [
  "research",
  "clarification",
  "architecture",
] as const;
export type ConditionalStage = (typeof conditionalStages)[number];
/** The same instructions are sent to the classifier and bound into policy freshness. */
export const planningRoutingInstructions = {
  stage: {
    research:
      "Decide whether external Research is needed, not whether implementation is ready. RUN for missing external API/library/source facts; SKIP when local evidence suffices and no external facts are needed. Unanswered product choices belong to downstream Clarification and do not alone require Research or ESCALATE. ESCALATE only when the need for external Research cannot safely be determined.",
    clarification:
      "Decide whether Human Clarification is needed. RUN for unresolved product, scope, behavior or architecture choices that a Human can answer; SKIP only when no Human decisions remain. Unanswered Human choices are a reason to RUN, not to ESCALATE. ESCALATE only when the clarification need itself cannot safely be determined. This decision neither answers questions nor authorizes writes.",
    architecture:
      "Decide whether the Planner needs an Architecture / Design section beyond local implementation details. RUN for architectural boundaries, components, dependencies or design trade-offs; SKIP when the confirmed scope is a local change with no architectural decisions. ESCALATE when the need for Architecture cannot safely be determined. Do not approve a design or broaden scope.",
  },
  clarification:
    "Select the Human clarification mode. GRILL_ME for Human choices without domain-document work; GRILL_WITH_DOCS for Human choices requiring CONTEXT/context-map/ADR creation or updates; SKIP only with sufficient evidence and no unresolved Human choices. Unanswered choices are the purpose of grilling, not alone a reason to ESCALATE. ESCALATE only when a safe mode cannot be determined. Do not generate questions, answer for the Human, or grant write authority.",
  method:
    "Which implementation method fits the eligible behavior change? STANDARD or TDD, ESCALATE for unresolved Human preference. Explicit Human TDD and inapplicable work are resolved deterministically before this call.",
} as const;
export const stageOutcomes = ["RUN", "SKIP", "ESCALATE"] as const;
export type StageOutcome = (typeof stageOutcomes)[number];
export const clarificationModes = [
  "SKIP",
  "GRILL_ME",
  "GRILL_WITH_DOCS",
  "ESCALATE",
] as const;
export type ClarificationMode = (typeof clarificationModes)[number];
export type ConditionalStageDecision = Decision<StageOutcome>;
export type ClarificationModeDecision = Decision<ClarificationMode>;

export const developmentIntents = ["AUTO", "TDD", "BEHAVIOR_FREE"] as const;
export type DevelopmentIntent = (typeof developmentIntents)[number];
export type DevelopmentMethod = "STANDARD" | "TDD";
export const developmentMethodOutcomes = [
  "STANDARD",
  "TDD",
  "ESCALATE",
] as const;
export type DevelopmentMethodDecision = Decision<
  (typeof developmentMethodOutcomes)[number]
>;
export type PlanningDecisionStage = ConditionalStage | "development-method";

export function developmentMethodOutcome(
  policy: StagePolicy,
  decision: DevelopmentMethodDecision | null,
  threshold: number,
): (typeof developmentMethodOutcomes)[number] {
  if (policy === "required") return "TDD";
  if (policy === "skip") return "STANDARD";
  return decision && decision.confidence >= threshold
    ? decision.value
    : "ESCALATE";
}

export interface PlanningDecisionBinding {
  schemaVersion: 1;
  decisionSchemaVersion: 1;
  workflowId: string;
  playbook: PlaybookKind;
  stage: PlanningDecisionStage;
  policy: StagePolicy;
  policyVersion: "planning-routing-1";
  /** A pre-plan decision is never implementation/Plan approval authority. */
  approvedPlanRef: null;
  planVersion: null;
  inputRefs: readonly ArtifactRef[];
  inputDigest: string;
  policyDigest: string;
  configurationDigest: string;
  classifier: ClassifierIdentity | null;
}

export type PlanningDecisionArtifact = PlanningDecisionBinding &
  (
    | {
        family: "stage";
        rawDecision: ConditionalStageDecision | null;
        outcome: StageOutcome;
      }
    | {
        family: "clarification";
        rawDecision: ClarificationModeDecision | null;
        outcome: ClarificationMode;
      }
    | {
        family: "method";
        rawDecision: DevelopmentMethodDecision | null;
        outcome: (typeof developmentMethodOutcomes)[number];
      }
  ) & {
    /** Exact outbound reservation/usage, including probabilities, when a classifier was called. */
    requestRef?: ArtifactRef<"jev-request">;
    usageRef?: ArtifactRef<"jev-request">;
  };

export function stageOutcome(
  policy: StagePolicy,
  decision: ConditionalStageDecision | null,
  threshold: number,
): StageOutcome {
  if (policy === "required") return "RUN";
  if (policy === "skip") return "SKIP";
  return decision && decision.confidence >= threshold
    ? decision.value
    : "ESCALATE";
}

export function clarificationOutcome(
  stage: StageOutcome,
  decision: ClarificationModeDecision | null,
  threshold: number,
): ClarificationMode {
  if (stage === "SKIP") return "SKIP";
  // A mode selection cannot reverse a RUN or an unresolved stage decision.
  if (
    stage !== "RUN" ||
    !decision ||
    decision.confidence < threshold ||
    decision.value === "SKIP"
  )
    return "ESCALATE";
  return decision.value;
}

function isRawDecision(value: unknown, values: readonly string[]): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["value", "confidence"]) &&
    isOneOf(values, value.value) &&
    isConfidence(value.confidence)
  );
}
export function isConditionalStageDecision(
  value: unknown,
): value is ConditionalStageDecision {
  return isRawDecision(value, stageOutcomes);
}
export function isDevelopmentMethodDecision(
  value: unknown,
): value is DevelopmentMethodDecision {
  return isRawDecision(value, developmentMethodOutcomes);
}
export function isClarificationModeDecision(
  value: unknown,
): value is ClarificationModeDecision {
  return isRawDecision(value, clarificationModes);
}
export function isPlanningDecisionArtifact(
  value: unknown,
): value is PlanningDecisionArtifact {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "decisionSchemaVersion",
      "workflowId",
      "playbook",
      "stage",
      "policy",
      "policyVersion",
      "approvedPlanRef",
      "planVersion",
      "inputRefs",
      "inputDigest",
      "policyDigest",
      "configurationDigest",
      "classifier",
      "family",
      "rawDecision",
      "outcome",
      "requestRef",
      "usageRef",
    ])
  )
    return false;
  if (
    value.schemaVersion !== 1 ||
    value.decisionSchemaVersion !== 1 ||
    typeof value.workflowId !== "string" ||
    !value.workflowId ||
    !isOneOf(playbookKinds, value.playbook) ||
    !isOneOf(
      [...conditionalStages, "development-method"] as const,
      value.stage,
    ) ||
    !isOneOf(["required", "conditional", "skip"] as const, value.policy) ||
    value.policyVersion !== "planning-routing-1" ||
    value.approvedPlanRef !== null ||
    value.planVersion !== null ||
    !Array.isArray(value.inputRefs) ||
    !value.inputRefs.every(isArtifactRef) ||
    ![value.inputDigest, value.policyDigest, value.configurationDigest].every(
      (digest) => typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest),
    )
  )
    return false;
  for (const key of ["requestRef", "usageRef"] as const) {
    if (
      value[key] !== undefined &&
      (!isArtifactRef(value[key]) || value[key].kind !== "jev-request")
    )
      return false;
  }
  if (value.rawDecision === null) {
    if (
      value.classifier !== null ||
      value.requestRef !== undefined ||
      value.usageRef !== undefined
    )
      return false;
  } else if (
    !isClassifierIdentity(value.classifier) ||
    !isArtifactRef(value.requestRef)
  )
    return false;
  if (value.family === "method")
    return (
      value.stage === "development-method" &&
      isOneOf(developmentMethodOutcomes, value.outcome) &&
      (value.policy === "conditional"
        ? isDevelopmentMethodDecision(value.rawDecision)
        : value.rawDecision === null &&
          value.outcome === developmentMethodOutcome(value.policy, null, 1))
    );
  if (value.family === "stage")
    return (
      isOneOf(conditionalStages, value.stage) &&
      isOneOf(stageOutcomes, value.outcome) &&
      (value.policy === "conditional"
        ? isConditionalStageDecision(value.rawDecision)
        : value.rawDecision === null)
    );
  return (
    value.family === "clarification" &&
    value.stage === "clarification" &&
    isOneOf(clarificationModes, value.outcome) &&
    (value.rawDecision === null
      ? value.outcome === "SKIP"
      : isClarificationModeDecision(value.rawDecision))
  );
}
export function parsePlanningDecisionArtifact(
  value: unknown,
): PlanningDecisionArtifact {
  return parseSchema(
    value,
    isPlanningDecisionArtifact,
    "PlanningDecisionArtifact",
  );
}
