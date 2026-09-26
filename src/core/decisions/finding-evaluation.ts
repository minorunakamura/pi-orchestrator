import type { ReviewFinding } from "../coding/finding.ts";
import {
  applyConfidencePolicy,
  type ConfidencePolicy,
} from "./confidence-policy.ts";
import type {
  EvaluatedFinding,
  FindingDecision,
  NormalizedFindingEvaluationDecision,
} from "./types.ts";

function isLowConfidence(
  raw: NormalizedFindingEvaluationDecision,
  policy: ConfidencePolicy,
): boolean {
  return [
    raw.evidenceSupported,
    raw.conflictsWithApprovedPlan,
    raw.conflictsWithArchitecture,
    raw.inScope,
    raw.requiresHumanDecision,
  ].some(
    ({ confidence }) => applyConfidencePolicy(confidence, policy) !== "auto",
  );
}

function result(
  finding: ReviewFinding,
  raw: NormalizedFindingEvaluationDecision,
  decision: FindingDecision,
  reasonCode: string,
): EvaluatedFinding {
  return {
    findingId: raw.findingId,
    blocking: finding.blocking,
    evidenceSupported: raw.evidenceSupported,
    conflictsWithApprovedPlan: raw.conflictsWithApprovedPlan,
    conflictsWithArchitecture: raw.conflictsWithArchitecture,
    inScope: raw.inScope,
    requiresHumanDecision: raw.requiresHumanDecision,
    decision,
    reasonCode,
  };
}

export function evaluateFinding(
  finding: ReviewFinding,
  raw: NormalizedFindingEvaluationDecision,
  policy: ConfidencePolicy,
): EvaluatedFinding {
  if (finding.id !== raw.findingId) {
    throw new Error(`Finding decision ID does not match ${finding.id}`);
  }

  if (isLowConfidence(raw, policy)) {
    return result(finding, raw, "ESCALATE", "uncertain");
  }
  if (raw.requiresHumanDecision.value) {
    return result(finding, raw, "ESCALATE", "human-decision");
  }
  if (raw.conflictsWithApprovedPlan.value) {
    return result(finding, raw, "REJECT", "approved-plan-conflict");
  }
  if (raw.conflictsWithArchitecture.value) {
    return result(finding, raw, "REJECT", "approved-architecture-conflict");
  }
  if (!raw.evidenceSupported.value) {
    return result(finding, raw, "REJECT", "unsupported-evidence");
  }
  if (!raw.inScope.value) {
    return result(finding, raw, "REJECT", "out-of-scope");
  }
  return result(finding, raw, "ACCEPT", "accepted");
}

export function evaluateFindings(
  findings: readonly ReviewFinding[],
  rawDecisions: readonly NormalizedFindingEvaluationDecision[],
  policy: ConfidencePolicy,
): EvaluatedFinding[] {
  if (findings.length !== rawDecisions.length) {
    throw new Error("Finding decisions must cover every finding exactly once");
  }

  const decisions = new Map<string, NormalizedFindingEvaluationDecision>();
  for (const raw of rawDecisions) {
    if (decisions.has(raw.findingId)) {
      throw new Error(`Duplicate finding decision: ${raw.findingId}`);
    }
    decisions.set(raw.findingId, raw);
  }

  return findings.map((finding) => {
    const raw = decisions.get(finding.id);
    if (!raw) throw new Error(`Missing finding decision: ${finding.id}`);
    return evaluateFinding(finding, raw, policy);
  });
}
