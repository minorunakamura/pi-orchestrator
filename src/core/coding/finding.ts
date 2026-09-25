import {
  hasOnlyKeys,
  isNonEmptyString,
  isOneOf,
  isRecord,
  optional,
  parseSchema,
} from "../schema.ts";

export const reviewFindingSources = ["correctness", "ponytail"] as const;
export type ReviewFindingSource = (typeof reviewFindingSources)[number];

export interface ReviewFinding {
  id: string;
  source: ReviewFindingSource;
  category: string;
  location?: string;
  summary: string;
  evidence: string;
  blocking: boolean;
}

export function isReviewFinding(value: unknown): value is ReviewFinding {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "id",
      "source",
      "category",
      "location",
      "summary",
      "evidence",
      "blocking",
    ]) &&
    isNonEmptyString(value.id) &&
    isOneOf(reviewFindingSources, value.source) &&
    isNonEmptyString(value.category) &&
    optional(value, "location", isNonEmptyString) &&
    isNonEmptyString(value.summary) &&
    isNonEmptyString(value.evidence) &&
    typeof value.blocking === "boolean"
  );
}

export function parseReviewFinding(value: unknown): ReviewFinding {
  return parseSchema(value, isReviewFinding, "ReviewFinding");
}
