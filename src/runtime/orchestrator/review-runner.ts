import type {
  ArtifactKind,
  ArtifactRef,
} from "../../core/artifacts/references.ts";
import {
  isReviewFinding,
  type ReviewFinding,
  type ReviewFindingSource,
} from "../../core/coding/finding.ts";
import {
  parseValidationResult,
  type ValidationResult,
} from "../../core/decisions/types.ts";
import {
  hasOnlyKeys,
  isOneOf,
  isRecord,
  isSchemaVersion,
  parseSchema,
} from "../../core/schema.ts";
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
  AgentRunRequest,
  AgentRunResult,
  SubagentExecutor,
} from "../ports/index.ts";
import { RuntimePortError } from "../ports/index.ts";
import {
  advanceWorkflow,
  type WorkflowStateWriter,
} from "./advance-workflow.ts";
import type { WorkflowArtifactWriter } from "./planning-orchestrator.ts";

import { assertValidationAuthority } from "./coding-evidence.ts";
import {
  codingAuthority,
  assertCodingAuthority,
  isCodingAuthority,
  type CodingAuthority,
} from "../../core/coding/authority.ts";

export interface ReviewArtifact {
  /** Missing only on external reviewer output, never on persisted authority. */
  authority?: CodingAuthority;
  schemaVersion: 1;
  round: number;
  source: ReviewFindingSource;
  findings: ReviewFinding[];
}

export function isReviewArtifact(value: unknown): value is ReviewArtifact {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "round",
      "source",
      "findings",
      "authority",
    ]) ||
    (value.authority !== undefined && !isCodingAuthority(value.authority)) ||
    !isSchemaVersion(value.schemaVersion) ||
    typeof value.round !== "number" ||
    !Number.isSafeInteger(value.round) ||
    value.round <= 0 ||
    !isOneOf(["correctness", "ponytail"] as const, value.source) ||
    !Array.isArray(value.findings) ||
    !value.findings.every(isReviewFinding)
  ) {
    return false;
  }

  return value.findings.every((finding) => finding.source === value.source);
}

export function parseReviewArtifact(value: unknown): ReviewArtifact {
  return parseSchema(value, isReviewArtifact, "ReviewArtifact");
}

export const fixedReviewerSet = [
  {
    agent: "reviewer",
    source: "correctness",
    kind: "correctness-review",
  },
  {
    agent: "ponytail-reviewer",
    source: "ponytail",
    kind: "ponytail-review",
  },
] as const satisfies ReadonlyArray<{
  agent: string;
  source: ReviewFindingSource;
  kind: "correctness-review" | "ponytail-review";
}>;

export const REVIEWER_SET = fixedReviewerSet;

export interface ReviewRunInput {
  state: WorkflowState;
  cwd?: string;
}

export interface ReviewRunResult {
  state: WorkflowState;
  correctnessReviewRef: ArtifactRef<"correctness-review">;
  ponytailReviewRef: ArtifactRef<"ponytail-review">;
  correctnessReview: ReviewArtifact;
  ponytailReview: ReviewArtifact;
  findings: ReviewFinding[];
}

export interface ReviewRunnerDependencies {
  artifactStore: WorkflowArtifactWriter;
  stateStore: WorkflowStateWriter;
  subagentExecutor: SubagentExecutor;
}

export class ReviewRunnerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ReviewRunnerError";
  }
}

interface ReadableArtifactStore extends WorkflowArtifactWriter {
  readText<K extends ArtifactKind>(ref: ArtifactRef<K>): Promise<string>;
}

function requireReadableStore(
  store: WorkflowArtifactWriter,
): ReadableArtifactStore {
  if (typeof store.readText !== "function") {
    throw new ReviewRunnerError(
      "Automated review requires readable validation artifacts",
    );
  }
  return store as ReadableArtifactStore;
}

function reviewRefs(state: WorkflowState): ArtifactRef[] {
  const approvedPlanRef = state.planning.approvedPlanRef;
  const implementationRef = state.coding.implementationRef;
  const validationRef = state.coding.validationRef;
  if (!approvedPlanRef || !implementationRef || !validationRef) {
    throw new ReviewRunnerError(
      "Automated review requires approved plan, implementation, and validation evidence",
    );
  }
  return [approvedPlanRef, implementationRef, validationRef];
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
      throw new ReviewRunnerError(
        `Authoritative ${label} artifact ref does not match its content`,
      );
    }
    return content;
  } catch (error) {
    if (error instanceof ReviewRunnerError) throw error;
    throw new ReviewRunnerError(
      `Unable to read authoritative ${label} artifact`,
      { cause: error },
    );
  }
}

function reviewTask(source: ReviewFindingSource, round: number): string {
  const focus =
    source === "ponytail"
      ? "Review only for unnecessary complexity, speculative abstractions, duplication, and simpler existing or standard-library alternatives."
      : "Review correctness, regressions, security, and behavior against the approved Plan.";
  return `${focus} Read the supplied authoritative artifact refs and the current repository in the fresh review context. Return exactly one JSON object and no Markdown or prose: {"schemaVersion":1,"round":${round},"source":"${source}","findings":[{"id":"${source === "ponytail" ? "P1" : "C1"},"source":"${source}","category":"...","location":"path:line (optional)","summary":"...","evidence":"...","blocking":false}]}. Use an empty findings array for a clean review. Findings are evidence only: do not edit files, mutate State, choose accepted findings, grant Fix authority, or make approval decisions.`;
}

function createReviewRequest(
  reviewer: (typeof fixedReviewerSet)[number],
  state: WorkflowState,
  refs: readonly ArtifactRef[],
  cwd?: string,
): AgentRunRequest {
  return {
    agent: reviewer.agent,
    task: reviewTask(reviewer.source, state.coding.reviewRound),
    inputRefs: refs,
    ...(cwd ? { cwd } : {}),
  };
}

function assertUniqueFindingIds(reviews: readonly ReviewArtifact[]): void {
  const ids = new Set<string>();
  for (const review of reviews) {
    for (const finding of review.findings) {
      if (ids.has(finding.id)) {
        throw new ReviewRunnerError(`Duplicate finding ID: ${finding.id}`);
      }
      ids.add(finding.id);
    }
  }
}

function parseOutput(
  result: AgentRunResult,
  reviewer: (typeof fixedReviewerSet)[number],
  round: number,
): ReviewArtifact {
  if (result.status !== "succeeded") {
    throw new ReviewRunnerError(
      `${reviewer.agent} reviewer did not succeed: ${result.status}`,
      { cause: result },
    );
  }
  if (typeof result.output !== "string" || result.output.trim().length === 0) {
    throw new ReviewRunnerError(
      `${reviewer.agent} reviewer returned no structured output`,
      { cause: result },
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(result.output);
  } catch (error) {
    throw new ReviewRunnerError(
      `${reviewer.agent} reviewer returned invalid JSON`,
      { cause: error },
    );
  }

  let artifact: ReviewArtifact;
  try {
    artifact = parseReviewArtifact(value);
  } catch (error) {
    throw new ReviewRunnerError(
      `${reviewer.agent} reviewer returned an invalid review artifact`,
      { cause: error },
    );
  }
  if (artifact.source !== reviewer.source) {
    throw new ReviewRunnerError(
      `${reviewer.agent} reviewer returned source ${artifact.source}; expected ${reviewer.source}`,
    );
  }
  if (artifact.round !== round) {
    throw new ReviewRunnerError(
      `${reviewer.agent} reviewer returned round ${artifact.round}; expected ${round}`,
    );
  }
  return artifact;
}

async function readValidation(
  store: ReadableArtifactStore,
  ref: ArtifactRef<"validation">,
): Promise<ValidationResult> {
  if (ref.kind !== "validation") {
    throw new ReviewRunnerError("Review requires a validation artifact ref");
  }
  const content = await readAuthoritativeText(store, ref, "validation");
  try {
    return parseValidationResult(JSON.parse(content));
  } catch (error) {
    if (error instanceof ReviewRunnerError) throw error;
    throw new ReviewRunnerError(
      "Unable to parse the authoritative validation artifact",
      { cause: error },
    );
  }
}

function expectedRef<K extends ArtifactRef["kind"]>(
  kind: K,
  fileName: string,
  value: unknown,
): ArtifactRef<K> {
  const content = JSON.stringify(value);
  return createArtifactRef(kind, artifactRelativePath(kind, fileName), content);
}

async function persistReviewArtifact<
  K extends "correctness-review" | "ponytail-review",
>(
  store: ReadableArtifactStore,
  kind: K,
  fileName: string,
  value: ReviewArtifact,
): Promise<ArtifactRef<K>> {
  const content = JSON.stringify(value);
  const expected = expectedRef(kind, fileName, value);
  try {
    const ref = store.writeJson
      ? await store.writeJson(kind, fileName, value, parseReviewArtifact)
      : await store.writeText(kind, fileName, content);
    validateArtifactRef(ref);
    if (!sameArtifactRef(ref, expected)) {
      throw new ReviewRunnerError(
        `${kind} artifact writer returned a mismatched reference`,
      );
    }
    return ref;
  } catch (error) {
    if (!(error instanceof ArtifactImmutableError)) throw error;
    if ((await store.readText(expected)) === content) {
      return expected;
    }
    throw error;
  }
}

function blockReason(
  error: unknown,
): "agent-infrastructure-unavailable" | "agent-execution-ambiguous" {
  return error instanceof RuntimePortError && error.kind === "reconciliation"
    ? "agent-execution-ambiguous"
    : "agent-infrastructure-unavailable";
}

function resultBlockReason(
  result: AgentRunResult,
): "agent-infrastructure-unavailable" | "agent-execution-ambiguous" {
  return result.status === "ambiguous"
    ? "agent-execution-ambiguous"
    : "agent-infrastructure-unavailable";
}

async function blockAndThrow(
  state: WorkflowState,
  stateStore: WorkflowStateWriter,
  reason: "agent-infrastructure-unavailable" | "agent-execution-ambiguous",
  error: unknown,
): Promise<never> {
  await advanceWorkflow(state, { type: "BLOCK", reason }, stateStore);
  if (error instanceof Error) throw error;
  throw new ReviewRunnerError(String(error));
}

async function failAndThrow(
  state: WorkflowState,
  stateStore: WorkflowStateWriter,
  reason: "authoritative-artifact-corrupt" | "persistence-consistency-failure",
  error: unknown,
  evidenceRef?: ArtifactRef,
): Promise<never> {
  try {
    await advanceWorkflow(
      state,
      {
        type: "FAIL",
        reason,
        ...(evidenceRef ? { evidenceRef } : {}),
      },
      stateStore,
    );
  } catch {
    // Preserve the original boundary error; reconciliation owns any orphaned state.
  }
  if (error instanceof Error) throw error;
  throw new ReviewRunnerError(String(error));
}

export class ReviewRunner {
  constructor(private readonly dependencies: ReviewRunnerDependencies) {}

  async execute(input: ReviewRunInput): Promise<ReviewRunResult> {
    try {
      assertStateInvariants(input.state);
    } catch (error) {
      throw new ReviewRunnerError(
        "Automated review requires valid Workflow State",
        {
          cause: error,
        },
      );
    }
    if (input.state.phase !== "reviewing") {
      throw new ReviewRunnerError(
        "Automated review requires the reviewing Workflow phase",
      );
    }

    const validationRef = input.state.coding.validationRef;
    if (!validationRef) {
      throw new ReviewRunnerError(
        "Automated review requires persisted validation evidence",
      );
    }
    const store = requireReadableStore(this.dependencies.artifactStore);
    let validation: ValidationResult;
    try {
      validation = await readValidation(store, validationRef);
      await assertValidationAuthority(store, input.state, validation);
    } catch (error) {
      return failAndThrow(
        input.state,
        this.dependencies.stateStore,
        "authoritative-artifact-corrupt",
        error,
        validationRef,
      );
    }
    if (
      validation.status !== "passed" ||
      validation.implementationRevision !==
        input.state.coding.implementationRevision
    ) {
      return failAndThrow(
        input.state,
        this.dependencies.stateStore,
        "authoritative-artifact-corrupt",
        new ReviewRunnerError(
          "Automated review requires a passed validation for the current implementation",
        ),
        validationRef,
      );
    }

    let refs: ArtifactRef[];
    try {
      refs = reviewRefs(input.state);
      await readAuthoritativeText(store, refs[0], "approved plan");
      await readAuthoritativeText(store, refs[1], "implementation");
    } catch (error) {
      return failAndThrow(
        input.state,
        this.dependencies.stateStore,
        "authoritative-artifact-corrupt",
        error,
      );
    }
    const requests = fixedReviewerSet.map((reviewer) =>
      createReviewRequest(reviewer, input.state, refs, input.cwd),
    );
    let results: AgentRunResult[];
    try {
      results = await this.dependencies.subagentExecutor.runParallel(requests);
    } catch (error) {
      return blockAndThrow(
        input.state,
        this.dependencies.stateStore,
        blockReason(error),
        error,
      );
    }
    if (results.length !== fixedReviewerSet.length) {
      return blockAndThrow(
        input.state,
        this.dependencies.stateStore,
        "agent-execution-ambiguous",
        new ReviewRunnerError(
          `Expected ${fixedReviewerSet.length} reviewer results, received ${results.length}`,
        ),
      );
    }

    let reviews: ReviewArtifact[];
    try {
      reviews = fixedReviewerSet.map((reviewer, index) => {
        const review = parseOutput(
          results[index],
          reviewer,
          input.state.coding.reviewRound,
        );
        if (review.authority !== undefined)
          assertCodingAuthority(input.state, review.authority);
        return { ...review, authority: codingAuthority(input.state) };
      });
      assertUniqueFindingIds(reviews);
    } catch (error) {
      const result = results.find(({ status }) => status !== "succeeded");
      return blockAndThrow(
        input.state,
        this.dependencies.stateStore,
        result ? resultBlockReason(result) : "agent-execution-ambiguous",
        error,
      );
    }

    const correctnessReview = reviews[0];
    const ponytailReview = reviews[1];
    let correctnessReviewRef: ArtifactRef<"correctness-review"> | undefined;
    let ponytailReviewRef: ArtifactRef<"ponytail-review"> | undefined;
    try {
      correctnessReviewRef = await persistReviewArtifact(
        store,
        "correctness-review",
        `correctness-${input.state.coding.reviewRound}.json`,
        correctnessReview,
      );
      ponytailReviewRef = await persistReviewArtifact(
        store,
        "ponytail-review",
        `ponytail-${input.state.coding.reviewRound}.json`,
        ponytailReview,
      );
    } catch (error) {
      return failAndThrow(
        input.state,
        this.dependencies.stateStore,
        "persistence-consistency-failure",
        error,
        correctnessReviewRef,
      );
    }

    if (!correctnessReviewRef || !ponytailReviewRef) {
      throw new ReviewRunnerError("Review artifacts were not persisted");
    }

    let state: WorkflowState;
    try {
      state = await advanceWorkflow(
        input.state,
        {
          type: "REVIEW_ARTIFACTS_PERSISTED",
          correctnessReviewRef,
          ponytailReviewRef,
        },
        this.dependencies.stateStore,
      );
    } catch (error) {
      return failAndThrow(
        input.state,
        this.dependencies.stateStore,
        "persistence-consistency-failure",
        error,
        correctnessReviewRef,
      );
    }

    return {
      state,
      correctnessReviewRef,
      ponytailReviewRef,
      correctnessReview,
      ponytailReview,
      findings: [...correctnessReview.findings, ...ponytailReview.findings],
    };
  }

  run(input: ReviewRunInput): Promise<ReviewRunResult> {
    return this.execute(input);
  }
}

export async function executeAutomatedReview(
  input: ReviewRunInput,
  dependencies: ReviewRunnerDependencies,
): Promise<ReviewRunResult> {
  return new ReviewRunner(dependencies).execute(input);
}

export const executeReview = executeAutomatedReview;
export const runAutomatedReview = executeAutomatedReview;
export const runReview = executeAutomatedReview;
