import { isArtifactRef, type ArtifactRef } from "../artifacts/references.ts";
import {
  hasOnlyKeys,
  isNonEmptyString,
  isNonNegativeInteger,
  isRecord,
  isSchemaVersion,
} from "../schema.ts";

export interface DecisionFreshness {
  schemaVersion: 1;
  planVersion: number;
  implementationRevision: number;
  inputRefs: readonly ArtifactRef[];
  inputDigest: string;
  policyDigest: string;
  configurationDigest?: string;
}

export interface DecisionFreshnessExpectation
  extends Omit<DecisionFreshness, "schemaVersion"> {
  schemaVersion?: 1;
}

export interface DecisionFreshnessCheck {
  fresh: boolean;
  mismatches: string[];
}

const freshnessKeys = [
  "schemaVersion",
  "planVersion",
  "implementationRevision",
  "inputRefs",
  "inputDigest",
  "policyDigest",
  "configurationDigest",
] as const;

function sameRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return (
    left.kind === right.kind &&
    left.path === right.path &&
    left.schemaVersion === right.schemaVersion &&
    left.sha256 === right.sha256
  );
}

function sameRefs(left: unknown, right: readonly ArtifactRef[]): boolean {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every(
      (candidate, index) =>
        isArtifactRef(candidate) && sameRef(candidate, right[index]),
    )
  );
}

function hasFreshnessFields(value: unknown): value is DecisionFreshness {
  if (!isRecord(value)) return false;
  return (
    isSchemaVersion(value.schemaVersion) &&
    isNonNegativeInteger(value.planVersion) &&
    isNonNegativeInteger(value.implementationRevision) &&
    Array.isArray(value.inputRefs) &&
    value.inputRefs.every(isArtifactRef) &&
    isNonEmptyString(value.inputDigest) &&
    isNonEmptyString(value.policyDigest) &&
    (value.configurationDigest === undefined ||
      isNonEmptyString(value.configurationDigest))
  );
}

export function isDecisionFreshness(
  value: unknown,
): value is DecisionFreshness {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, freshnessKeys) &&
    hasFreshnessFields(value)
  );
}

export function checkDecisionFreshness(
  decision: unknown,
  expected: DecisionFreshnessExpectation,
): DecisionFreshnessCheck {
  const mismatches: string[] = [];
  if (!isRecord(decision) || !isSchemaVersion(decision.schemaVersion)) {
    mismatches.push("schemaVersion");
  }
  if (!isRecord(decision) || decision.planVersion !== expected.planVersion) {
    mismatches.push("planVersion");
  }
  if (
    !isRecord(decision) ||
    decision.implementationRevision !== expected.implementationRevision
  ) {
    mismatches.push("implementationRevision");
  }
  if (
    !isRecord(decision) ||
    !sameRefs(decision.inputRefs, expected.inputRefs)
  ) {
    mismatches.push("inputRefs");
  }
  if (!isRecord(decision) || decision.inputDigest !== expected.inputDigest) {
    mismatches.push("inputDigest");
  }
  if (!isRecord(decision) || decision.policyDigest !== expected.policyDigest) {
    mismatches.push("policyDigest");
  }
  if (
    expected.configurationDigest !== undefined &&
    (!isRecord(decision) ||
      decision.configurationDigest !== expected.configurationDigest)
  ) {
    mismatches.push("configurationDigest");
  }
  if (!hasFreshnessFields(decision)) {
    if (!mismatches.includes("schemaVersion")) mismatches.push("schema");
  }
  return { fresh: mismatches.length === 0, mismatches };
}

export function isDecisionFresh(
  decision: unknown,
  expected: DecisionFreshnessExpectation,
): boolean {
  return checkDecisionFreshness(decision, expected).fresh;
}
