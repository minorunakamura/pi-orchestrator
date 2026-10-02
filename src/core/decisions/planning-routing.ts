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

export interface PlanningDecisionBinding {
  schemaVersion: 1;
  decisionSchemaVersion: 1;
  workflowId: string;
  playbook: PlaybookKind;
  stage: ConditionalStage;
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
    !isOneOf(conditionalStages, value.stage) ||
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
  if (value.family === "stage")
    return (
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
