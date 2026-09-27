import type { ArtifactRef } from "../../core/artifacts/references.ts";
import type { OrchestratorConfiguration } from "../../core/configuration.ts";
import {
  decideRound,
  routeRoundDecision,
  strongerExecutionProfile,
  type LogicalExecutionProfile,
  type RoundDecisionFinding,
} from "../../core/decisions/round-decision.ts";
import {
  isRoundDecisionArtifact,
  parseAcceptedFindingsArtifact,
  parseFindingEvaluationArtifact,
  parseValidationResult,
  type AcceptedFindingsArtifact,
  type FindingEvaluationArtifact,
  type RoundDecisionArtifact,
  type RoundDecision,
  type ValidationResult,
} from "../../core/decisions/types.ts";
import {
  assertStateInvariants,
  sameArtifactRef,
} from "../../core/workflow/invariants.ts";
import type {
  WorkflowEvent,
  WorkflowState,
} from "../../core/workflow/state.ts";
import {
  ArtifactImmutableError,
  calculateSha256,
  createArtifactRef,
  validateArtifactRef,
} from "../persistence/artifact-store.ts";
import { artifactRelativePath } from "../persistence/artifact-paths.ts";
import {
  isExecutionRoutingArtifact,
  type ExecutionRoutingArtifact,
} from "./coding-orchestrator.ts";
import type {
  JevDecisionClient,
  RoundDecisionInput,
} from "../ports/jev-decision-client.ts";
import {
  advanceWorkflow,
  type WorkflowStateWriter,
} from "./advance-workflow.ts";
import type { WorkflowArtifactWriter } from "./planning-orchestrator.ts";

import { assertCodingAuthority } from "../../core/coding/authority.ts";
import { isDecisionFresh } from "../../core/decisions/decision-freshness.ts";
import { persistedFindings } from "./finding-evaluation.ts";
import {
  assembleCodingEvidence,
  decisionFreshness,
  assertValidationAuthority,
  reviewEvidenceRefs,
  sourcedFindings,
} from "./coding-evidence.ts";

export interface RoundDecisionRunInput {
  state: WorkflowState;
  validation: ValidationResult;
  validationRef?: ArtifactRef<"validation">;
  findings?: readonly RoundDecisionFinding[];
  acceptedBlockingFindingIds?: readonly string[];
  currentProfile?: LogicalExecutionProfile;
  currentRouting?: ExecutionRoutingArtifact;
}

export interface RoundDecisionRunnerDependencies {
  artifactStore: WorkflowArtifactWriter;
  stateStore: WorkflowStateWriter;
  jevDecisionClient: JevDecisionClient;
  configuration: Pick<OrchestratorConfiguration, "decision" | "retries">;
}

export interface RoundDecisionRunResult {
  state: WorkflowState;
  roundDecisionRef: ArtifactRef<"round-decision">;
  decision: RoundDecision;
  event: WorkflowEvent;
  nextExecutionProfile?: LogicalExecutionProfile;
}

export class RoundDecisionRunnerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RoundDecisionRunnerError";
  }
}

function roundNumber(state: WorkflowState): number {
  return Math.max(1, state.coding.reviewRound);
}

async function readAuthoritativeJson<T>(
  store: WorkflowArtifactWriter,
  ref: ArtifactRef,
  parse: (value: unknown) => T,
  label: string,
): Promise<T> {
  if (!store.readText) {
    throw new RoundDecisionRunnerError(
      `Round Decision requires a readable ${label} artifact store`,
    );
  }
  try {
    validateArtifactRef(ref);
    const content = await store.readText(ref);
    if (calculateSha256(content) !== ref.sha256) {
      throw new RoundDecisionRunnerError(
        `Authoritative ${label} artifact ref does not match its content`,
      );
    }
    return parse(JSON.parse(content));
  } catch (error) {
    if (error instanceof RoundDecisionRunnerError) throw error;
    throw new RoundDecisionRunnerError(
      `Unable to read the authoritative ${label} artifact`,
      { cause: error },
    );
  }
}

async function authoritativeValidation(
  store: WorkflowArtifactWriter,
  ref: ArtifactRef<"validation"> | undefined,
  expected: ValidationResult,
): Promise<ValidationResult> {
  if (!ref) {
    throw new RoundDecisionRunnerError(
      "Round Decision requires a validation artifact reference",
    );
  }
  const parsed = await readAuthoritativeJson(
    store,
    ref,
    parseValidationResult,
    "validation",
  );
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
    throw new RoundDecisionRunnerError(
      "Round Decision validation evidence does not match the authoritative artifact",
    );
  }
  return parsed;
}

async function authoritativeRouting(
  store: WorkflowArtifactWriter,
  state: WorkflowState,
): Promise<ExecutionRoutingArtifact> {
  const ref = state.coding.executionRoutingRef;
  const approvedPlanRef = state.planning.approvedPlanRef;
  if (
    !ref ||
    !approvedPlanRef ||
    state.planning.approvedPlanVersion === undefined
  ) {
    throw new RoundDecisionRunnerError(
      "Round Decision requires current execution routing authority",
    );
  }
  const routing = await readAuthoritativeJson(
    store,
    ref,
    (value) => {
      if (!isExecutionRoutingArtifact(value)) {
        throw new RoundDecisionRunnerError(
          "Authoritative execution routing artifact is invalid",
        );
      }
      return value;
    },
    "execution routing",
  );
  if (
    !sameArtifactRef(routing.approvedPlanRef, approvedPlanRef) ||
    routing.planVersion !== state.planning.approvedPlanVersion
  ) {
    throw new RoundDecisionRunnerError(
      "Execution routing authority does not match the approved plan",
    );
  }
  return routing;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

function assertFindingArtifactBinding(
  state: WorkflowState,
  artifact: FindingEvaluationArtifact | AcceptedFindingsArtifact,
): void {
  if (
    artifact.round !== roundNumber(state) ||
    artifact.planVersion !== state.planning.approvedPlanVersion ||
    artifact.implementationRevision !== state.coding.implementationRevision ||
    !state.planning.approvedPlanRef ||
    !sameArtifactRef(artifact.approvedPlanRef, state.planning.approvedPlanRef)
  ) {
    throw new RoundDecisionRunnerError(
      "Finding authority does not match the current coding round",
    );
  }
}

async function authoritativeFindings(
  store: WorkflowArtifactWriter,
  state: WorkflowState,
  supplied: readonly RoundDecisionFinding[] | undefined,
  suppliedBlockingIds: readonly string[] | undefined,
  policy: OrchestratorConfiguration["decision"],
): Promise<{
  findings: readonly RoundDecisionFinding[];
  findingSummaries: RoundDecisionInput["findingSummaries"];
  acceptedBlockingFindingIds?: readonly string[];
}> {
  const evaluationRef = state.coding.findingEvaluationRef;
  const acceptedRef = state.coding.acceptedFindingsRef;
  if (
    state.phase === "reviewing" &&
    (!state.coding.correctnessReviewRef ||
      !state.coding.ponytailReviewRef ||
      !evaluationRef ||
      !acceptedRef)
  ) {
    throw new RoundDecisionRunnerError(
      "Passed review round requires both reviews, finding evaluation and accepted findings",
    );
  }
  if (!evaluationRef && !acceptedRef) {
    if (supplied?.length || suppliedBlockingIds?.length)
      throw new RoundDecisionRunnerError(
        "Failed-validation rounds cannot accept supplied findings",
      );
    return {
      findings: supplied ?? [],
      findingSummaries: [],
      ...(suppliedBlockingIds
        ? { acceptedBlockingFindingIds: suppliedBlockingIds }
        : {}),
    };
  }
  if (!evaluationRef || !acceptedRef) {
    throw new RoundDecisionRunnerError(
      "Finding authority requires both evaluation and accepted artifacts",
    );
  }
  const evaluation = await readAuthoritativeJson(
    store,
    evaluationRef,
    parseFindingEvaluationArtifact,
    "finding evaluation",
  );
  const accepted = await readAuthoritativeJson(
    store,
    acceptedRef,
    parseAcceptedFindingsArtifact,
    "accepted findings",
  );
  assertFindingArtifactBinding(state, evaluation);
  assertFindingArtifactBinding(state, accepted);
  assertCodingAuthority(state, evaluation.authority);
  assertCodingAuthority(state, accepted.authority);
  if (!store.readText)
    throw new RoundDecisionRunnerError("Missing readable review evidence");
  const raw = await persistedFindings(
    {
      ...store,
      readText: store.readText.bind(store),
      writeText: store.writeText.bind(store),
    },
    state,
  );
  if (
    !sameIds(
      raw.map((f) => f.id),
      evaluation.findings.map((f) => f.findingId),
    )
  )
    throw new RoundDecisionRunnerError(
      "Finding evaluation does not cover current raw review IDs",
    );
  const expectedAccepted = raw.filter((f) =>
    evaluation.findings.some(
      (e) => e.findingId === f.id && e.decision === "ACCEPT",
    ),
  );
  if (
    JSON.stringify(expectedAccepted) !== JSON.stringify(accepted.accepted) ||
    raw.some((f, index) => f.blocking !== evaluation.findings[index]?.blocking)
  )
    throw new RoundDecisionRunnerError(
      "Accepted findings differ from current raw review evidence",
    );
  const evidence = await assembleCodingEvidence(store, state);
  const request = {
    approvedPlanRef: state.planning.approvedPlanRef!,
    implementationRevision: state.coding.implementationRevision,
    findings: raw,
    evidence,
    reviewRefs: reviewEvidenceRefs(state),
  };
  const expectedFreshness = decisionFreshness(
    state,
    request,
    [
      request.approvedPlanRef,
      state.coding.implementationRef!,
      state.coding.correctnessReviewRef!,
      state.coding.ponytailReviewRef!,
      ...(evidence.previousDecision ? [evidence.previousDecision.ref] : []),
    ],
    policy,
  );
  if (!isDecisionFresh(evaluation.freshness, expectedFreshness))
    throw new RoundDecisionRunnerError("Stale finding evaluation freshness");
  const acceptedIds = accepted.accepted.map(({ id }) => id);
  const evaluatedAcceptedIds = evaluation.findings
    .filter(({ decision }) => decision === "ACCEPT")
    .map(({ findingId }) => findingId);
  if (!sameIds(acceptedIds, evaluatedAcceptedIds)) {
    throw new RoundDecisionRunnerError(
      "Accepted findings do not match finding evaluation authority",
    );
  }
  if (
    supplied &&
    JSON.stringify(supplied) !== JSON.stringify(evaluation.findings)
  ) {
    throw new RoundDecisionRunnerError(
      "Supplied findings do not match the authoritative finding evaluation",
    );
  }
  const blockingIds = accepted.accepted
    .filter(({ blocking }) => blocking)
    .map(({ id }) => id);
  if (suppliedBlockingIds && !sameIds(suppliedBlockingIds, blockingIds)) {
    throw new RoundDecisionRunnerError(
      "Supplied blocking finding IDs do not match accepted authority",
    );
  }
  return {
    findings: evaluation.findings,
    findingSummaries: sourcedFindings(raw, request.reviewRefs),
    acceptedBlockingFindingIds: blockingIds,
  };
}

function decisionArtifact(
  state: WorkflowState,
  decision: RoundDecision,
): RoundDecisionArtifact {
  const approvedPlanRef = state.planning.approvedPlanRef;
  const planVersion = state.planning.approvedPlanVersion;
  if (!approvedPlanRef || planVersion === undefined) {
    throw new RoundDecisionRunnerError(
      "Round Decision requires the current approved plan",
    );
  }
  return {
    schemaVersion: 1,
    round: roundNumber(state),
    planVersion,
    implementationRevision: state.coding.implementationRevision,
    approvedPlanRef,
    decision: decision.decision,
    confidence: decision.confidence,
    ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    ...(decision.decision === "ESCALATE"
      ? { escalationReason: decision.escalationReason }
      : {}),
  } as RoundDecisionArtifact;
}

function expectedRef(
  fileName: string,
  value: RoundDecisionArtifact,
): ArtifactRef<"round-decision"> {
  return createArtifactRef(
    "round-decision",
    artifactRelativePath("round-decision", fileName),
    JSON.stringify(value),
  );
}

async function persistDecision(
  store: WorkflowArtifactWriter,
  value: RoundDecisionArtifact,
): Promise<ArtifactRef<"round-decision">> {
  const fileName = `round-decision-${value.implementationRevision}.json`;
  const content = JSON.stringify(value);
  const expected = expectedRef(fileName, value);
  try {
    const ref = store.writeJson
      ? await store.writeJson(
          "round-decision",
          fileName,
          value,
          isRoundDecisionArtifact,
        )
      : await store.writeText("round-decision", fileName, content);
    validateArtifactRef(ref);
    if (!sameArtifactRef(ref, expected)) {
      throw new RoundDecisionRunnerError(
        "Round Decision artifact writer returned a mismatched reference",
      );
    }
    return ref;
  } catch (error) {
    if (!(error instanceof ArtifactImmutableError)) throw error;
    if (store.readText && (await store.readText(expected)) === content) {
      return expected;
    }
    throw error;
  }
}

function routingArtifactForStrongerRetry(
  state: WorkflowState,
  profile: LogicalExecutionProfile,
  confidence: number,
  currentRouting?: ExecutionRoutingArtifact,
): ExecutionRoutingArtifact {
  const approvedPlanRef = state.planning.approvedPlanRef;
  const planVersion = state.planning.approvedPlanVersion;
  if (!approvedPlanRef || planVersion === undefined) {
    throw new RoundDecisionRunnerError(
      "Stronger retry requires the current approved plan",
    );
  }
  const base = currentRouting;
  const attempt = (base?.attempt ?? state.coding.implementationRevision) + 1;
  return {
    schemaVersion: 1,
    approvedPlanRef,
    planVersion,
    attempt,
    priorRetryCount: state.counters.automatedFixRoundsUsed,
    modelTier: {
      value: profile.modelTier,
      confidence: base?.modelTier.confidence ?? confidence,
    },
    reasoningTier: {
      value: profile.reasoningTier,
      confidence: base?.reasoningTier.confidence ?? confidence,
    },
    effectiveConfidence: Math.min(
      base?.modelTier.confidence ?? confidence,
      base?.reasoningTier.confidence ?? confidence,
    ),
  };
}

async function persistStrongerRouting(
  store: WorkflowArtifactWriter,
  artifact: ExecutionRoutingArtifact,
): Promise<ArtifactRef<"execution-routing">> {
  const fileName = `execution-routing-${artifact.attempt}.json`;
  const content = JSON.stringify(artifact);
  const expected = createArtifactRef(
    "execution-routing",
    artifactRelativePath("execution-routing", fileName),
    content,
  );
  const ref = store.writeJson
    ? await store.writeJson(
        "execution-routing",
        fileName,
        artifact,
        isExecutionRoutingArtifact,
      )
    : await store.writeText("execution-routing", fileName, content);
  validateArtifactRef(ref);
  if (!sameArtifactRef(ref, expected)) {
    throw new RoundDecisionRunnerError(
      "Stronger routing artifact writer returned a mismatched reference",
    );
  }
  return ref;
}

async function blockAndThrow(
  state: WorkflowState,
  stateStore: WorkflowStateWriter,
  error: unknown,
): Promise<never> {
  try {
    await advanceWorkflow(
      state,
      { type: "BLOCK", reason: "integration-unavailable" },
      stateStore,
    );
  } catch {
    // Preserve the original integration failure; recovery owns a failed write.
  }
  if (error instanceof Error) throw error;
  throw new RoundDecisionRunnerError(String(error));
}

function assertInputState(
  state: WorkflowState,
): asserts state is WorkflowState & {
  phase: "validating" | "reviewing";
} {
  try {
    assertStateInvariants(state);
  } catch (error) {
    throw new RoundDecisionRunnerError(
      "Round Decision requires valid Workflow State",
      { cause: error },
    );
  }
  if (state.phase !== "validating" && state.phase !== "reviewing") {
    throw new RoundDecisionRunnerError(
      "Round Decision requires the validating or reviewing Workflow phase",
    );
  }
  if (!state.planning.approvedPlanRef) {
    throw new RoundDecisionRunnerError(
      "Round Decision requires the current approved plan",
    );
  }
}

export class RoundDecisionRunner {
  constructor(private readonly dependencies: RoundDecisionRunnerDependencies) {}

  async execute(input: RoundDecisionRunInput): Promise<RoundDecisionRunResult> {
    assertInputState(input.state);
    const validationRef =
      input.validationRef ??
      (input.state.phase === "reviewing"
        ? input.state.coding.validationRef
        : undefined);
    if (
      input.state.phase === "reviewing" &&
      input.validationRef &&
      input.state.coding.validationRef &&
      !sameArtifactRef(input.validationRef, input.state.coding.validationRef)
    ) {
      throw new RoundDecisionRunnerError(
        "Round Decision validation reference does not match State",
      );
    }
    const validation = await authoritativeValidation(
      this.dependencies.artifactStore,
      validationRef,
      input.validation,
    );
    if (
      validation.implementationRevision !==
      input.state.coding.implementationRevision
    ) {
      throw new RoundDecisionRunnerError(
        "Round Decision validation evidence is stale",
      );
    }
    await assertValidationAuthority(
      this.dependencies.artifactStore,
      input.state,
      validation,
    );
    if (input.state.phase === "reviewing" && validation.status !== "passed")
      throw new RoundDecisionRunnerError(
        "Review round requires passed validation",
      );
    if (input.state.phase === "validating" && validation.status === "passed")
      throw new RoundDecisionRunnerError(
        "Passed validation must enter the complete review pipeline",
      );
    const currentRouting = await authoritativeRouting(
      this.dependencies.artifactStore,
      input.state,
    );
    if (
      input.currentRouting &&
      JSON.stringify(input.currentRouting) !== JSON.stringify(currentRouting)
    ) {
      throw new RoundDecisionRunnerError(
        "Supplied execution routing does not match State authority",
      );
    }
    if (
      input.currentProfile &&
      (input.currentProfile.modelTier !== currentRouting.modelTier.value ||
        input.currentProfile.reasoningTier !==
          currentRouting.reasoningTier.value)
    ) {
      throw new RoundDecisionRunnerError(
        "Supplied execution profile does not match State authority",
      );
    }
    const authoritative = await authoritativeFindings(
      this.dependencies.artifactStore,
      input.state,
      input.findings,
      input.acceptedBlockingFindingIds,
      this.dependencies.configuration.decision,
    );
    const currentProfile = {
      modelTier: currentRouting.modelTier.value,
      reasoningTier: currentRouting.reasoningTier.value,
    };

    const evidence = await assembleCodingEvidence(
      this.dependencies.artifactStore,
      input.state,
    );
    const request: RoundDecisionInput = {
      evidence,
      branch:
        input.state.phase === "reviewing"
          ? "review-passed"
          : "validation-failed",
      retryLimits: this.dependencies.configuration.retries,
      currentProfile,
      inputRefs: [
        validationRef!,
        ...[
          input.state.coding.correctnessReviewRef,
          input.state.coding.ponytailReviewRef,
          input.state.coding.findingEvaluationRef,
          input.state.coding.acceptedFindingsRef,
        ].filter((ref) => ref !== undefined),
      ],
      approvedPlanRef: input.state.planning.approvedPlanRef!,
      implementationRevision: input.state.coding.implementationRevision,
      validation,
      findings: authoritative.findings,
      findingSummaries: authoritative.findingSummaries,
    };
    let rawDecision;
    try {
      rawDecision =
        await this.dependencies.jevDecisionClient.decideRound(request);
    } catch (error) {
      return blockAndThrow(input.state, this.dependencies.stateStore, error);
    }
    const decision = decideRound(
      {
        rawDecision,
        validation,
        findings: authoritative.findings,
        acceptedBlockingFindingIds: authoritative.acceptedBlockingFindingIds,
      },
      this.dependencies.configuration.decision,
    );
    const artifact = {
      ...decisionArtifact(input.state, decision),
      rawDecision,
      freshness: decisionFreshness(
        input.state,
        request,
        [
          request.approvedPlanRef,
          input.state.coding.implementationRef!,
          ...request.inputRefs,
          ...(evidence.previousDecision ? [evidence.previousDecision.ref] : []),
        ],
        this.dependencies.configuration,
      ),
    };
    const roundDecisionRef = await persistDecision(
      this.dependencies.artifactStore,
      artifact,
    );
    let event = routeRoundDecision({
      phase: input.state.phase,
      counters: input.state.counters,
      retries: this.dependencies.configuration.retries,
      decision,
      decisionRef: roundDecisionRef,
      ...(validationRef ? { validationRef } : {}),
      ...(input.state.coding.acceptedFindingsRef
        ? { findingsRef: input.state.coding.acceptedFindingsRef }
        : {}),
      currentProfile,
    });
    let nextExecutionProfile: LogicalExecutionProfile | undefined;
    if (event.type === "STRONGER_RETRY_REQUIRED") {
      nextExecutionProfile = strongerExecutionProfile(currentProfile);
      const routingArtifact = routingArtifactForStrongerRetry(
        input.state,
        nextExecutionProfile,
        decision.confidence,
        currentRouting,
      );
      routingArtifact.sourceDecisionRef = roundDecisionRef;
      routingArtifact.freshness = decisionFreshness(
        input.state,
        { sourceDecisionRef: roundDecisionRef, nextExecutionProfile },
        [
          input.state.planning.approvedPlanRef!,
          input.state.coding.implementationRef!,
          roundDecisionRef,
        ],
        this.dependencies.configuration,
      );
      const executionRoutingRef = await persistStrongerRouting(
        this.dependencies.artifactStore,
        routingArtifact,
      );
      event = { ...event, executionRoutingRef };
    }
    const state = await advanceWorkflow(
      input.state,
      event,
      this.dependencies.stateStore,
    );
    return {
      state,
      roundDecisionRef,
      decision,
      event,
      ...(nextExecutionProfile ? { nextExecutionProfile } : {}),
    };
  }

  run(input: RoundDecisionRunInput): Promise<RoundDecisionRunResult> {
    return this.execute(input);
  }
}

export async function executeRoundDecision(
  input: RoundDecisionRunInput,
  dependencies: RoundDecisionRunnerDependencies,
): Promise<RoundDecisionRunResult> {
  return new RoundDecisionRunner(dependencies).execute(input);
}

export const decideCodingRound = executeRoundDecision;
