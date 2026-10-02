import { JevAuthorization, jevBlockedReason } from "./jev-authorization.ts";
import type {
  ArtifactKind,
  ArtifactRef,
} from "../../core/artifacts/references.ts";
import { evaluateFindings } from "../../core/decisions/finding-evaluation.ts";
import type {
  AcceptedFindingsArtifact,
  EvaluatedFinding,
  FindingEvaluationArtifact,
} from "../../core/decisions/types.ts";
import {
  isAcceptedFindingsArtifact,
  isFindingEvaluationArtifact,
} from "../../core/decisions/types.ts";
import type { ReviewFinding } from "../../core/coding/finding.ts";
import { isReviewFinding } from "../../core/coding/finding.ts";
import type { ConfidencePolicy } from "../../core/decisions/confidence-policy.ts";
import type { OrchestratorConfiguration } from "../../core/configuration.ts";
import {
  assertStateInvariants,
  sameArtifactRef,
} from "../../core/workflow/invariants.ts";
import type { WorkflowState } from "../../core/workflow/state.ts";
import {
  ArtifactImmutableError,
  calculateSha256,
  createArtifactRef,
  validateArtifactRef,
} from "../persistence/artifact-store.ts";
import { artifactRelativePath } from "../persistence/artifact-paths.ts";
import type {
  FindingEvaluationInput,
  JevDecisionClient,
} from "../ports/jev-decision-client.ts";
import {
  advanceWorkflow,
  type WorkflowStateWriter,
} from "./advance-workflow.ts";
import type { WorkflowArtifactWriter } from "./planning-orchestrator.ts";
import { parseReviewArtifact, type ReviewArtifact } from "./review-runner.ts";

import {
  assembleCodingEvidence,
  decisionFreshness,
  reviewEvidenceRefs,
  sourcedFindings,
} from "./coding-evidence.ts";
import {
  assertCodingAuthority,
  codingAuthority,
} from "../../core/coding/authority.ts";

export type {
  AcceptedFindingsArtifact,
  FindingEvaluationArtifact,
} from "../../core/decisions/types.ts";

export interface FindingEvaluationRunInput {
  state: WorkflowState;
  /** Raw structured findings returned by the persisted review artifacts. */
  findings?: readonly ReviewFinding[];
}

export interface FindingEvaluationRunResult {
  state: WorkflowState;
  findingEvaluationRef: ArtifactRef<"finding-evaluation">;
  acceptedFindingsRef: ArtifactRef<"accepted-findings">;
  evaluation: FindingEvaluationArtifact;
  acceptedFindings: AcceptedFindingsArtifact;
}

export interface FindingEvaluationRunnerDependencies {
  artifactStore: WorkflowArtifactWriter;
  stateStore: WorkflowStateWriter;
  jevDecisionClient: JevDecisionClient;
  configuration: Pick<OrchestratorConfiguration, "decision"> &
    Partial<Pick<OrchestratorConfiguration, "jev">>;
}

export class FindingEvaluationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FindingEvaluationError";
  }
}

interface ReadableArtifactStore extends WorkflowArtifactWriter {
  readText<K extends ArtifactKind>(ref: ArtifactRef<K>): Promise<string>;
}

function isReadableStore(
  store: WorkflowArtifactWriter,
): store is ReadableArtifactStore {
  return typeof store.readText === "function";
}

function requireReadableStore(
  store: WorkflowArtifactWriter,
): ReadableArtifactStore {
  if (!isReadableStore(store)) {
    throw new FindingEvaluationError(
      "Finding evaluation requires a readable ArtifactStore",
    );
  }
  return store;
}

function policyFrom(
  dependencies: FindingEvaluationRunnerDependencies,
): ConfidencePolicy {
  return dependencies.configuration.decision;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function assertCurrentReviewState(state: WorkflowState): ArtifactRef<"plan"> {
  try {
    assertStateInvariants(state);
  } catch (error) {
    throw new FindingEvaluationError(
      "Finding evaluation requires valid Workflow State",
      {
        cause: error,
      },
    );
  }
  if (state.phase !== "reviewing") {
    throw new FindingEvaluationError(
      "Finding evaluation requires the reviewing Workflow phase",
    );
  }
  const planRef = state.planning.approvedPlanRef;
  if (
    !planRef ||
    state.planning.approvedPlanVersion === undefined ||
    !sameArtifactRef(planRef, state.planning.currentPlanRef)
  ) {
    throw new FindingEvaluationError(
      "Finding evaluation requires the current approved plan",
    );
  }
  try {
    validateArtifactRef(planRef);
  } catch (error) {
    throw new FindingEvaluationError(
      "Finding evaluation requires a valid approved plan reference",
      { cause: error },
    );
  }
  if (!positiveInteger(state.coding.reviewRound)) {
    throw new FindingEvaluationError(
      "Finding evaluation requires a positive review round",
    );
  }
  if (!positiveInteger(state.coding.implementationRevision)) {
    throw new FindingEvaluationError(
      "Finding evaluation requires a positive implementation revision",
    );
  }
  return planRef;
}

function assertUniqueFindings(findings: readonly ReviewFinding[]): void {
  const ids = new Set<string>();
  for (const finding of findings) {
    if (!isReviewFinding(finding)) {
      throw new FindingEvaluationError("Raw review findings are malformed");
    }
    if (ids.has(finding.id)) {
      throw new FindingEvaluationError(`Duplicate finding ID: ${finding.id}`);
    }
    ids.add(finding.id);
  }
}

function sameFinding(left: ReviewFinding, right: ReviewFinding): boolean {
  return (
    left.id === right.id &&
    left.source === right.source &&
    left.category === right.category &&
    left.location === right.location &&
    left.summary === right.summary &&
    left.evidence === right.evidence &&
    left.blocking === right.blocking
  );
}

function assertMatchesPersistedFindings(
  supplied: readonly ReviewFinding[] | undefined,
  persisted: readonly ReviewFinding[],
): void {
  if (!supplied) return;
  assertUniqueFindings(supplied);
  if (
    supplied.length !== persisted.length ||
    supplied.some((finding, index) => !sameFinding(finding, persisted[index]))
  ) {
    throw new FindingEvaluationError(
      "Supplied findings do not match the persisted review artifacts",
    );
  }
}

function reviewRefs(
  state: WorkflowState,
): [ArtifactRef<"correctness-review">, ArtifactRef<"ponytail-review">] {
  const correctness = state.coding.correctnessReviewRef;
  const ponytail = state.coding.ponytailReviewRef;
  if (!correctness || !ponytail) {
    throw new FindingEvaluationError(
      "Finding evaluation requires both persisted review artifacts",
    );
  }
  return [correctness, ponytail];
}

async function readAuthoritativeText(
  store: ReadableArtifactStore,
  ref: ArtifactRef,
  label: string,
): Promise<string> {
  try {
    validateArtifactRef(ref);
    const content = await store.readText(ref);
    if (calculateSha256(content) !== ref.sha256) {
      throw new FindingEvaluationError(
        `Authoritative ${label} artifact ref does not match its content`,
      );
    }
    return content;
  } catch (error) {
    if (error instanceof FindingEvaluationError) throw error;
    throw new FindingEvaluationError(
      `Unable to read authoritative ${label} artifact`,
      { cause: error },
    );
  }
}

async function readReview(
  store: ReadableArtifactStore,
  ref: ArtifactRef<"correctness-review" | "ponytail-review">,
): Promise<ReviewArtifact> {
  const content = await readAuthoritativeText(store, ref, "review");
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new FindingEvaluationError("Review artifact is not valid JSON", {
      cause: error,
    });
  }
  try {
    const review = parseReviewArtifact(value);
    if (
      (ref.kind === "correctness-review" && review.source !== "correctness") ||
      (ref.kind === "ponytail-review" && review.source !== "ponytail")
    ) {
      throw new FindingEvaluationError(
        `Review artifact source does not match ${ref.kind}`,
      );
    }
    return review;
  } catch (error) {
    if (error instanceof FindingEvaluationError) throw error;
    throw new FindingEvaluationError("Review artifact schema is invalid", {
      cause: error,
    });
  }
}

export async function persistedFindings(
  store: ReadableArtifactStore,
  state: WorkflowState,
): Promise<ReviewFinding[]> {
  const [correctness, ponytail] = reviewRefs(state);
  const reviews = await Promise.all([
    readReview(store, correctness),
    readReview(store, ponytail),
  ]);
  for (const review of reviews) assertCodingAuthority(state, review.authority);
  if (
    reviews.some(
      (review) =>
        review.round !== state.coding.reviewRound ||
        !review.findings.every((finding) => finding.source === review.source),
    )
  ) {
    throw new FindingEvaluationError(
      "Review artifacts do not match the current review round",
    );
  }
  const rawFindings = reviews.flatMap(
    ({ findings: reviewFindings }) => reviewFindings,
  );
  assertUniqueFindings(rawFindings);
  return rawFindings;
}

function expectedArtifactRef<K extends ArtifactRef["kind"]>(
  kind: K,
  fileName: string,
  value: unknown,
): ArtifactRef<K> {
  const content = JSON.stringify(value);
  return createArtifactRef(kind, artifactRelativePath(kind, fileName), content);
}

async function writeJsonFallback<K extends ArtifactRef["kind"]>(
  store: ReadableArtifactStore,
  kind: K,
  fileName: string,
  content: string,
  value: unknown,
  schema: (candidate: unknown) => unknown,
): Promise<ArtifactRef<K>> {
  const validated = schema(value);
  if (validated === false || validated === undefined) {
    throw new FindingEvaluationError(`Invalid ${kind} artifact`);
  }
  return store.writeText(kind, fileName, content);
}

async function persistJson<K extends ArtifactRef["kind"]>(
  store: ReadableArtifactStore,
  kind: K,
  fileName: string,
  value: unknown,
  schema: (candidate: unknown) => unknown,
): Promise<ArtifactRef<K>> {
  const content = JSON.stringify(value);
  const expected = expectedArtifactRef(kind, fileName, value);
  try {
    const ref = store.writeJson
      ? await store.writeJson(kind, fileName, value, schema)
      : await writeJsonFallback(store, kind, fileName, content, value, schema);
    validateArtifactRef(ref);
    if (!sameArtifactRef(ref, expected)) {
      throw new FindingEvaluationError(
        `${kind} artifact writer returned a mismatched reference`,
      );
    }
    return ref;
  } catch (error) {
    if (!(error instanceof ArtifactImmutableError)) throw error;
    try {
      if ((await store.readText(expected)) === content) return expected;
    } catch {
      // An immutable collision with unreadable content is not reusable.
    }
    const suffix = calculateSha256(content).slice(0, 16);
    const fallbackName = `${fileName.slice(0, -5)}-${suffix}.json`;
    if (store.writeJson) {
      return store.writeJson(kind, fallbackName, value, schema);
    }
    return store.writeText(kind, fallbackName, content);
  }
}

async function blockAndThrow(
  state: WorkflowState,
  stateStore: WorkflowStateWriter,
  error: unknown,
): Promise<never> {
  await advanceWorkflow(
    state,
    { type: "BLOCK", reason: jevBlockedReason(error) },
    stateStore,
  );
  if (error instanceof Error) throw error;
  throw new FindingEvaluationError(String(error));
}

async function failAndThrow(
  state: WorkflowState,
  stateStore: WorkflowStateWriter,
  error: unknown,
  evidenceRef?: ArtifactRef,
): Promise<never> {
  try {
    await advanceWorkflow(
      state,
      {
        type: "FAIL",
        reason: "persistence-consistency-failure",
        ...(evidenceRef ? { evidenceRef } : {}),
      },
      stateStore,
    );
  } catch {
    // Preserve the original persistence error; reconciliation owns the orphan.
  }
  if (error instanceof Error) throw error;
  throw new FindingEvaluationError(String(error));
}

function findingEvaluationInput(
  approvedPlanRef: ArtifactRef<"plan">,
  state: WorkflowState,
  findings: readonly ReviewFinding[],
  evidence: FindingEvaluationInput["evidence"],
): FindingEvaluationInput {
  const refs = reviewEvidenceRefs(state);
  sourcedFindings(findings, refs);
  return {
    approvedPlanRef,
    implementationRevision: state.coding.implementationRevision,
    findings,
    evidence,
    reviewRefs: refs,
  };
}

export class FindingEvaluationRunner {
  constructor(
    private readonly dependencies: FindingEvaluationRunnerDependencies,
  ) {}

  async execute(
    input: FindingEvaluationRunInput,
  ): Promise<FindingEvaluationRunResult> {
    const approvedPlanRef = assertCurrentReviewState(input.state);
    const store = requireReadableStore(this.dependencies.artifactStore);
    let findings: ReviewFinding[];
    try {
      const persisted = await persistedFindings(store, input.state);
      assertMatchesPersistedFindings(input.findings, persisted);
      findings = persisted;
    } catch (error) {
      if (error instanceof FindingEvaluationError) throw error;
      throw new FindingEvaluationError(
        "Unable to load persisted review findings",
        {
          cause: error,
        },
      );
    }

    const evidence = await assembleCodingEvidence(store, input.state);
    const request = findingEvaluationInput(
      approvedPlanRef,
      input.state,
      findings,
      evidence,
    );
    const freshness = decisionFreshness(
      input.state,
      request,
      [
        approvedPlanRef,
        input.state.coding.implementationRef!,
        ...reviewRefs(input.state),
        ...(evidence.previousDecision ? [evidence.previousDecision.ref] : []),
      ],
      {
        decision: this.dependencies.configuration.decision,
        ...(this.dependencies.configuration.jev
          ? { jev: this.dependencies.configuration.jev }
          : {}),
      },
    );
    const authorization = new JevAuthorization(
      input.state,
      this.dependencies.configuration.jev,
      store,
      this.dependencies.stateStore,
      "finding",
      [
        "plan",
        "implementation",
        "review",
        ...(evidence.previousDecision ? ["history" as const] : []),
      ],
    );
    let evaluated: EvaluatedFinding[];
    try {
      if (findings.length) authorization.assertAllowed();
      const rawDecisions =
        findings.length === 0
          ? []
          : await this.dependencies.jevDecisionClient.evaluateFindings(
              request,
              authorization.context,
            );
      input = { ...input, state: authorization.state };
      if (!Array.isArray(rawDecisions)) {
        throw new FindingEvaluationError(
          "Jev finding evaluation response is not an array",
        );
      }
      evaluated = evaluateFindings(
        findings,
        rawDecisions,
        policyFrom(this.dependencies),
      );
    } catch (error) {
      return blockAndThrow(
        authorization.state,
        this.dependencies.stateStore,
        error,
      );
    }

    const evaluation: FindingEvaluationArtifact = {
      schemaVersion: 1,
      freshness,
      authority: codingAuthority(input.state),
      round: input.state.coding.reviewRound,
      planVersion: input.state.planning.approvedPlanVersion!,
      implementationRevision: input.state.coding.implementationRevision,
      approvedPlanRef,
      findings: evaluated,
    };
    const acceptedFindings: AcceptedFindingsArtifact = {
      schemaVersion: 1,
      authority: codingAuthority(input.state),
      round: input.state.coding.reviewRound,
      planVersion: input.state.planning.approvedPlanVersion!,
      implementationRevision: input.state.coding.implementationRevision,
      approvedPlanRef,
      accepted: findings
        .filter((finding) =>
          evaluated.some(
            (candidate) =>
              candidate.findingId === finding.id &&
              candidate.decision === "ACCEPT",
          ),
        )
        .map((finding) => structuredClone(finding)),
    };

    let findingEvaluationRef: ArtifactRef<"finding-evaluation"> | undefined;
    let acceptedFindingsRef: ArtifactRef<"accepted-findings"> | undefined;
    try {
      findingEvaluationRef = await persistJson(
        store,
        "finding-evaluation",
        `finding-evaluation-${input.state.coding.reviewRound}.json`,
        evaluation,
        isFindingEvaluationArtifact,
      );
      acceptedFindingsRef = await persistJson(
        store,
        "accepted-findings",
        `accepted-findings-${input.state.coding.reviewRound}.json`,
        acceptedFindings,
        isAcceptedFindingsArtifact,
      );
    } catch (error) {
      return failAndThrow(
        input.state,
        this.dependencies.stateStore,
        error,
        findingEvaluationRef,
      );
    }

    if (!findingEvaluationRef || !acceptedFindingsRef) {
      throw new FindingEvaluationError(
        "Finding evaluation artifacts were not persisted",
      );
    }

    let state: WorkflowState;
    try {
      state = await advanceWorkflow(
        input.state,
        {
          type: "FINDING_EVALUATION_PERSISTED",
          findingEvaluationRef,
          acceptedFindingsRef,
        },
        this.dependencies.stateStore,
      );
    } catch (error) {
      return failAndThrow(
        input.state,
        this.dependencies.stateStore,
        error,
        findingEvaluationRef,
      );
    }

    return {
      state,
      findingEvaluationRef,
      acceptedFindingsRef,
      evaluation,
      acceptedFindings,
    };
  }

  run(input: FindingEvaluationRunInput): Promise<FindingEvaluationRunResult> {
    return this.execute(input);
  }
}

export async function executeFindingEvaluation(
  input: FindingEvaluationRunInput,
  dependencies: FindingEvaluationRunnerDependencies,
): Promise<FindingEvaluationRunResult> {
  return new FindingEvaluationRunner(dependencies).execute(input);
}

export const evaluateReviewFindings = executeFindingEvaluation;
