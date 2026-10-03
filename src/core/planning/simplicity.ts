import { isArtifactRef, type ArtifactRef } from "../artifacts/references.ts";
import {
  hasOnlyKeys,
  isNonEmptyString,
  isOneOf,
  isRecord,
  parseSchema,
} from "../schema.ts";
import { planSections, type PlanSection } from "./policy.ts";

export const simplicityCategories = [
  "unnecessary-abstraction",
  "speculative-flexibility",
  "avoidable-dependency",
  "ignored-pattern",
  "broad-change-surface",
  "duplicated-responsibility",
] as const;

export interface SimplicityFinding {
  id: string;
  category: (typeof simplicityCategories)[number];
  summary: string;
  planSection: PlanSection;
  repositoryEvidence: { ref: ArtifactRef; location: string; excerpt: string }[];
  alternative: string;
}
export interface SimplicityReport {
  schemaVersion: 1;
  findings: SimplicityFinding[];
}
export function isSimplicityReport(value: unknown): value is SimplicityReport {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["schemaVersion", "findings"]) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.findings) ||
    value.findings.length > 20
  )
    return false;
  const ids = new Set<string>();
  for (const finding of value.findings) {
    if (
      !isRecord(finding) ||
      !hasOnlyKeys(finding, [
        "id",
        "category",
        "summary",
        "planSection",
        "repositoryEvidence",
        "alternative",
      ]) ||
      ![finding.id, finding.summary, finding.alternative].every(
        isNonEmptyString,
      ) ||
      typeof finding.id !== "string" ||
      ids.has(finding.id) ||
      !isOneOf(simplicityCategories, finding.category) ||
      !isOneOf(planSections, finding.planSection) ||
      !Array.isArray(finding.repositoryEvidence) ||
      finding.repositoryEvidence.length === 0 ||
      finding.repositoryEvidence.length > 8 ||
      !finding.repositoryEvidence.every(
        (evidence: unknown) =>
          isRecord(evidence) &&
          hasOnlyKeys(evidence, ["ref", "location", "excerpt"]) &&
          isArtifactRef(evidence.ref) &&
          ["scout", "diagnosis"].includes(evidence.ref.kind) &&
          isNonEmptyString(evidence.location) &&
          isNonEmptyString(evidence.excerpt),
      )
    )
      return false;
    ids.add(finding.id);
  }
  return true;
}
export function parseSimplicityReport(value: unknown): SimplicityReport {
  return parseSchema(
    value,
    isSimplicityReport,
    "SimplicityReport (concrete repository evidence required)",
  );
}
