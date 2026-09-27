import type { ArtifactRef } from "../../core/artifacts/references.ts";
import type { WorkflowState } from "../../core/workflow/state.ts";
import type { ReviewFinding } from "../../core/coding/finding.ts";
import type {
  CodingDecisionEvidence,
  ReviewEvidenceRefs,
  SourcedFinding,
} from "../ports/jev-decision-client.ts";
import type { WorkflowArtifactWriter } from "./planning-orchestrator.ts";
import {
  calculateSha256,
  validateArtifactRef,
} from "../persistence/artifact-store.ts";
import { parsePlan } from "../planning/plan-parser.ts";
import { parseValidationContractBlock } from "../validation/contract-parser.ts";
import type {
  ValidationResult,
  ValidationContract,
  ValidationExecutionResult,
} from "../../core/decisions/types.ts";
import { sameArtifactRef } from "../../core/workflow/invariants.ts";

import {
  isDecisionFreshness,
  type DecisionFreshness,
} from "../../core/decisions/decision-freshness.ts";
import { parseImplementationArtifact } from "./coding-orchestrator.ts";
import { parseRoundDecisionArtifact } from "../../core/decisions/types.ts";

export function decisionFreshness(
  state: WorkflowState,
  input: unknown,
  inputRefs: readonly ArtifactRef[],
  configuration: unknown,
): DecisionFreshness {
  return {
    schemaVersion: 1,
    decisionSchemaVersion: 1,
    policyVersion: "phase-c-authority-1",
    planVersion: state.planning.approvedPlanVersion!,
    implementationRevision: state.coding.implementationRevision,
    inputRefs,
    inputDigest: calculateSha256(JSON.stringify(input)),
    policyDigest: calculateSha256(
      JSON.stringify({
        version: "phase-c-authority-1",
        bounds: CODING_EVIDENCE_LIMITS,
      }),
    ),
    configurationDigest: calculateSha256(JSON.stringify(configuration)),
  };
}

export const CODING_EVIDENCE_LIMITS = {
  plan: 12000,
  implementation: 12000,
  previousDecision: 6000,
  findings: 16000,
} as const;

export async function authoritativeText(
  store: WorkflowArtifactWriter,
  ref: ArtifactRef,
): Promise<string> {
  validateArtifactRef(ref);
  if (!store.readText)
    throw Error("Readable authoritative ArtifactStore required");
  const text = await store.readText(ref);
  if (calculateSha256(text) !== ref.sha256)
    throw Error("Authoritative artifact hash mismatch");
  return text;
}
export function assertValidationChecks(
  contract: ValidationContract,
  execution: ValidationExecutionResult,
): void {
  if (
    execution.checks.length !== contract.checks.length ||
    execution.checks.some(
      (check, index) =>
        check.id !== contract.checks[index]?.id ||
        (check.status === "passed" && check.exitCode !== 0) ||
        (check.status === "failed" &&
          (check.exitCode === undefined || check.exitCode === 0)),
    )
  )
    throw Error("Validation result does not cover the approved contract");
  const status = execution.checks.some(
    (check) => check.status === "infrastructure-error",
  )
    ? "infrastructure-error"
    : execution.checks.some(
          (check, index) =>
            check.status === "failed" && contract.checks[index]?.required,
        )
      ? "failed"
      : "passed";
  if (execution.status !== status)
    throw Error("Validation result aggregation does not match approved checks");
}
export async function assertValidationAuthority(
  store: WorkflowArtifactWriter,
  state: WorkflowState,
  result: ValidationResult,
): Promise<void> {
  const ref = state.planning.approvedPlanRef;
  if (
    !ref ||
    !sameArtifactRef(result.approvedPlanRef, ref) ||
    result.planVersion !== state.planning.approvedPlanVersion ||
    !sameArtifactRef(
      result.implementationRef,
      state.coding.implementationRef,
    ) ||
    result.implementationRevision !== state.coding.implementationRevision
  )
    throw Error(
      "Stale or missing validation authority binding for Approved Plan / implementation",
    );
  const contract = parseValidationContractBlock(
    await authoritativeText(store, ref),
  );
  if (
    result.validationContractDigest !==
    calculateSha256(JSON.stringify(contract))
  )
    throw Error("Validation Contract digest mismatch");
  assertValidationChecks(contract, result);
}
function bounded(text: string, limit: number): string {
  if (!text.trim() || text.length > limit)
    throw Error("Required decision evidence missing or exceeds safe bound");
  return text;
}
export function reviewEvidenceRefs(state: WorkflowState): ReviewEvidenceRefs {
  const { correctnessReviewRef, ponytailReviewRef } = state.coding;
  if (!correctnessReviewRef || !ponytailReviewRef)
    throw Error("Missing raw review provenance");
  return { correctness: correctnessReviewRef, ponytail: ponytailReviewRef };
}
export function sourcedFindings(
  findings: readonly ReviewFinding[],
  refs: ReviewEvidenceRefs,
): SourcedFinding[] {
  const summaries = findings.map((finding) => ({
    finding,
    sourceRef: refs[finding.source],
  }));
  bounded(JSON.stringify(summaries), CODING_EVIDENCE_LIMITS.findings);
  return summaries;
}
function parseEvidence<T>(
  content: string,
  parser: (value: unknown) => T,
  label: string,
): T {
  try {
    return parser(JSON.parse(content));
  } catch (cause) {
    throw new Error(`${label} evidence schema is invalid`, { cause });
  }
}
export async function assembleCodingEvidence(
  store: WorkflowArtifactWriter,
  state: WorkflowState,
): Promise<CodingDecisionEvidence> {
  const planRef = state.planning.approvedPlanRef;
  const implementationRef = state.coding.implementationRef;
  if (!planRef || !implementationRef)
    throw Error("Missing approved coding evidence");
  const plan = bounded(
    await authoritativeText(store, planRef),
    CODING_EVIDENCE_LIMITS.plan,
  );
  const parsed = parsePlan(plan, {
    architectureRequired: state.planning.architectureRequired !== false,
  });
  const implementation = bounded(
    await authoritativeText(store, implementationRef),
    CODING_EVIDENCE_LIMITS.implementation,
  );
  const implementationArtifact = parseEvidence(
    implementation,
    parseImplementationArtifact,
    "Implementation",
  );
  if (
    !sameArtifactRef(implementationArtifact.approvedPlanRef, planRef) ||
    implementationArtifact.implementationRevision !==
      state.coding.implementationRevision
  )
    throw Error(
      "Implementation evidence binding does not match current authority",
    );
  const previousRef = state.coding.previousRoundDecisionRef;
  if (!previousRef && state.coding.implementationRevision > 1)
    throw Error("Previous decision history is missing");
  let previousDecision: CodingDecisionEvidence["previousDecision"] = null;
  if (previousRef) {
    const content = bounded(
      await authoritativeText(store, previousRef),
      CODING_EVIDENCE_LIMITS.previousDecision,
    );
    const previous = parseEvidence(
      content,
      parseRoundDecisionArtifact,
      "Previous decision",
    );
    if (
      previous.implementationRevision !==
        state.coding.implementationRevision - 1 ||
      previous.planVersion > state.planning.approvedPlanVersion! ||
      !isDecisionFreshness(previous.freshness) ||
      previous.freshness.implementationRevision !==
        previous.implementationRevision ||
      previous.freshness.planVersion !== previous.planVersion
    )
      throw Error("Previous decision history binding is inconsistent");
    previousDecision = { ref: previousRef, content };
  }
  return {
    plan: { ref: planRef, content: plan },
    architecture: parsed.sections.includes("Architecture / Design")
      ? "included-in-plan"
      : "not-required",
    implementation: { ref: implementationRef, content: implementation },
    counters: structuredClone(state.counters),
    previousDecision,
  };
}
