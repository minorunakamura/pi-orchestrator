import type {
  ArtifactKind,
  ArtifactRef,
} from "../../core/artifacts/references.ts";
import {
  plannerInputRefs,
  type PlannerInput,
} from "../../core/planning/policy.ts";
import { isPlanReviewBinding } from "../../core/workflow/state.ts";
import { sameArtifactRef } from "../../core/workflow/invariants.ts";
import {
  ArtifactImmutableError,
  createArtifactRef,
} from "../persistence/artifact-store.ts";
import type {
  WorkflowEvent,
  WorkflowState,
} from "../../core/workflow/state.ts";
import { parsePlan, type ParsedPlan } from "../planning/plan-parser.ts";
import {
  RuntimePortError,
  type AgentRunRequest,
  type AgentRunResult,
  type ClarificationPort,
  type ClarificationResult,
  type PlanReviewHandle,
  type PlanReviewStatus,
  type PlannotatorGate,
  type SubagentExecutor,
} from "../ports/index.ts";
import type { PlannotatorReviewId } from "../../types.ts";
import {
  advanceWorkflow,
  type WorkflowStateWriter,
} from "./advance-workflow.ts";

export interface WorkflowArtifactWriter {
  readonly rootDirectory?: string;
  writeText<K extends ArtifactKind>(
    kind: K,
    fileName: string,
    content: string,
  ): Promise<ArtifactRef<K>>;
  writeJson?<K extends ArtifactKind, R>(
    kind: K,
    fileName: string,
    value: unknown,
    schema: (value: unknown) => R,
  ): Promise<ArtifactRef<K>>;
  readText?<K extends ArtifactKind>(ref: ArtifactRef<K>): Promise<string>;
  readJson?<K extends ArtifactKind, R>(
    ref: ArtifactRef<K>,
    schema: (value: unknown) => R,
  ): Promise<R>;
}

export interface GatherContextInput {
  state: WorkflowState;
  cwd?: string;
}

export interface ContextGatheringResult {
  state: WorkflowState;
  scoutRef?: ArtifactRef<"scout">;
  researchRef?: ArtifactRef<"research">;
}

export interface ClarificationInput {
  state: WorkflowState;
  prompt: string;
  contextRefs?: readonly ArtifactRef[];
}

export type ClarificationOutcome =
  | {
      status: "provided";
      state: WorkflowState;
      clarificationRef: ArtifactRef<"clarification">;
    }
  | {
      status: "declined";
      state: WorkflowState;
      reason?: string;
    }
  | { status: "blocked"; state: WorkflowState };

export interface CreatePlanInput {
  state: WorkflowState;
  cwd?: string;
  previousPlanRef?: ArtifactRef<"plan">;
  feedbackRef?: ArtifactRef<"plan-review">;
}

export interface PlanCreationResult {
  state: WorkflowState;
  planRef: ArtifactRef<"plan">;
  plannerInput: PlannerInput;
  parsedPlan: ParsedPlan;
  planReview?: PlanReviewHandle;
}

export interface OpenPlanReviewInput {
  state: WorkflowState;
}

export type OpenPlanReviewResult =
  | { status: "opened"; state: WorkflowState; handle: PlanReviewHandle }
  | { status: "reconciled"; state: WorkflowState; outcome: PlanReviewOutcome }
  | { status: "blocked"; state: WorkflowState };

export interface ReconcilePlanReviewInput {
  state: WorkflowState;
  reviewId: PlannotatorReviewId;
}

export type PlanReviewOutcome =
  | { status: "pending"; state: WorkflowState; reviewId: PlannotatorReviewId }
  | {
      status: "approved";
      state: WorkflowState;
      reviewId: PlannotatorReviewId;
      reviewRef: ArtifactRef<"plan-review">;
    }
  | {
      status: "feedback";
      state: WorkflowState;
      reviewId: PlannotatorReviewId;
      reviewRef: ArtifactRef<"plan-review">;
    }
  | {
      status: "unknown";
      state: WorkflowState;
      reviewId: PlannotatorReviewId;
      reason?: string;
    }
  | { status: "blocked"; state: WorkflowState; reviewId: PlannotatorReviewId };

export class StalePlanReviewError extends Error {
  constructor(
    message = "Plan review does not match the current plan and version",
  ) {
    super(message);
    this.name = "StalePlanReviewError";
  }
}

interface PlanReviewArtifact {
  schemaVersion: 1;
  reviewId: string;
  status: "approved" | "feedback";
  planRef: ArtifactRef<"plan">;
  planVersion: number;
  feedback?: string;
}

export interface PlanningOrchestratorDependencies {
  artifactStore: WorkflowArtifactWriter;
  stateStore: WorkflowStateWriter;
  subagentExecutor: SubagentExecutor;
  clarificationPort?: ClarificationPort;
  plannotatorGate?: PlannotatorGate;
}

function request(
  agent: string,
  task: string,
  inputRefs: readonly ArtifactRef[],
  cwd: string | undefined,
): AgentRunRequest {
  return {
    agent,
    task,
    inputRefs,
    ...(cwd ? { cwd } : {}),
  };
}

function planningContextRefs(state: WorkflowState): readonly ArtifactRef[] {
  const refs: Array<ArtifactRef | undefined> = [
    state.taskRef,
    state.planning.context.scoutRef,
    state.planning.context.researchRef,
  ];
  return refs.filter((ref): ref is ArtifactRef => ref !== undefined);
}

function clarificationArtifact(answer: string, prompt: string): string {
  return `# Clarification\n\n## Question\n${prompt.trim()}\n\n## Answer\n${answer.trim()}\n`;
}

function blockedReason(
  error: unknown,
): "agent-infrastructure-unavailable" | "agent-execution-ambiguous" {
  if (error instanceof RuntimePortError && error.kind === "reconciliation") {
    return "agent-execution-ambiguous";
  }
  return "agent-infrastructure-unavailable";
}

function resultBlockedReason(
  result: AgentRunResult,
): "agent-infrastructure-unavailable" | "agent-execution-ambiguous" {
  return result.status === "ambiguous"
    ? "agent-execution-ambiguous"
    : "agent-infrastructure-unavailable";
}

function reviewFileName(reviewId: PlannotatorReviewId): string {
  const encoded = encodeURIComponent(reviewId);
  if (encoded.length === 0) throw new Error("Plan review id must not be empty");
  return `${encoded}.md`;
}

function planReviewIdentityKey(version: number): string {
  return `plannotator.plan-review.v${version}`;
}

function reviewArtifactContent(artifact: PlanReviewArtifact): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

function reviewArtifactRef(
  reviewId: PlannotatorReviewId,
  status: Extract<PlanReviewStatus, { status: "approved" | "feedback" }>,
): ArtifactRef<"plan-review"> {
  const artifact: PlanReviewArtifact = {
    schemaVersion: 1,
    reviewId,
    status: status.status,
    planRef: status.planRef,
    planVersion: status.planVersion,
    ...(status.status === "feedback" ? { feedback: status.feedback } : {}),
  };
  return createArtifactRef(
    "plan-review",
    `plan-reviews/${reviewFileName(reviewId)}`,
    reviewArtifactContent(artifact),
  );
}

function currentPlan(state: WorkflowState): ArtifactRef<"plan"> {
  if (!state.planning.currentPlanRef) {
    throw new Error("Plan review requires a current plan");
  }
  return state.planning.currentPlanRef;
}

function assertSettledReviewMatchesCurrentPlan(
  state: WorkflowState,
  status: PlanReviewHandle,
): void {
  const plan = currentPlan(state);
  if (
    status.planVersion !== state.planning.currentPlanVersion ||
    !sameArtifactRef(status.planRef, plan)
  ) {
    throw new StalePlanReviewError();
  }
}

function requirePlanReviewBinding(
  state: WorkflowState,
  reviewId: PlannotatorReviewId,
): PlanReviewHandle {
  const binding = state.planning.planReview;
  if (
    !isPlanReviewBinding(binding) ||
    binding.reviewId !== reviewId ||
    binding.planVersion !== state.planning.currentPlanVersion ||
    !sameArtifactRef(binding.planRef, state.planning.currentPlanRef) ||
    state.external[planReviewIdentityKey(binding.planVersion)] !== reviewId
  ) {
    throw new StalePlanReviewError(
      "Persisted plan review binding is missing or does not match the current plan and version",
    );
  }
  return binding;
}

function requirePlanningPolicy(state: WorkflowState): void {
  const { researchRequired, clarificationRequired, architectureRequired } =
    state.planning;
  if (
    [researchRequired, clarificationRequired, architectureRequired].some(
      (value) => typeof value !== "boolean",
    )
  ) {
    throw new Error(
      "Persisted resolved planning policy is required; legacy policy must not be inferred",
    );
  }
}

export class PlanningOrchestrator {
  constructor(
    private readonly dependencies: PlanningOrchestratorDependencies,
  ) {}

  async gatherContext(
    input: GatherContextInput,
  ): Promise<ContextGatheringResult> {
    if (input.state.phase !== "gathering-context") {
      throw new Error("Context gathering requires gathering-context phase");
    }

    requirePlanningPolicy(input.state);
    const taskRef = input.state.taskRef;
    let state = input.state;
    let scoutRef = state.planning.context.scoutRef;
    if (!scoutRef) {
      const scoutResult = await this.run(
        state,
        request(
          "workflow-scout",
          "Gather repository-local facts and evidence for the task. Return paths, line ranges, constraints, and unknowns; do not make decisions or mutate State.",
          [taskRef],
          input.cwd,
        ),
      );
      if ("state" in scoutResult) return { state: scoutResult.state };
      scoutRef = await this.writeOutput(
        "scout",
        "scout.md",
        scoutResult.result.output,
      );
      state = await advanceWorkflow(
        state,
        { type: "CONTEXT_EVIDENCE_PERSISTED", scoutRef },
        this.dependencies.stateStore,
      );
    }

    let researchRef = state.planning.context.researchRef;
    if (state.planning.researchRequired && !researchRef) {
      const researchResult = await this.run(
        state,
        request(
          "pi-ketch.researcher",
          "Gather external facts relevant to the task and the local scout evidence. Return sources and uncertainty; do not make product decisions or mutate Workflow State.",
          [taskRef, scoutRef],
          input.cwd,
        ),
      );
      if ("state" in researchResult) {
        return {
          state: researchResult.state,
          scoutRef,
        };
      }

      researchRef = await this.writeOutput(
        "research",
        "research.md",
        researchResult.result.output,
      );
      state = await advanceWorkflow(
        state,
        { type: "CONTEXT_EVIDENCE_PERSISTED", researchRef },
        this.dependencies.stateStore,
      );
    }

    const event: WorkflowEvent = state.planning.clarificationRequired
      ? { type: "CLARIFICATION_REQUIRED" }
      : { type: "CONTEXT_READY" };
    state = await advanceWorkflow(state, event, this.dependencies.stateStore);

    return { state, scoutRef, ...(researchRef ? { researchRef } : {}) };
  }

  async requestClarification(
    input: ClarificationInput,
  ): Promise<ClarificationOutcome> {
    if (input.state.phase !== "clarifying") {
      throw new Error("Clarification requires clarifying phase");
    }
    if (input.prompt.trim().length === 0) {
      throw new Error("Clarification prompt must not be empty");
    }
    const port = this.dependencies.clarificationPort;
    if (!port) throw new Error("ClarificationPort is required");

    let result: ClarificationResult;
    try {
      result = await port.request({
        prompt: input.prompt,
        contextRefs: input.contextRefs ?? planningContextRefs(input.state),
      });
    } catch {
      const state = await advanceWorkflow(
        input.state,
        { type: "BLOCK", reason: "human-gate-unavailable" },
        this.dependencies.stateStore,
      );
      return { status: "blocked", state };
    }

    if (result.status === "declined") {
      return {
        status: "declined",
        state: input.state,
        ...(result.reason ? { reason: result.reason } : {}),
      };
    }
    if (result.answer.trim().length === 0) {
      throw new Error("Clarification answer must not be empty");
    }

    const clarificationRef = await this.dependencies.artifactStore.writeText(
      "clarification",
      "clarification.md",
      clarificationArtifact(result.answer, input.prompt),
    );
    const state = await advanceWorkflow(
      input.state,
      { type: "CLARIFICATION_COMPLETE", clarificationRef },
      this.dependencies.stateStore,
    );
    return { status: "provided", state, clarificationRef };
  }

  async createPlan(input: CreatePlanInput): Promise<PlanCreationResult> {
    if (input.state.phase !== "planning") {
      throw new Error("Plan creation requires planning phase");
    }
    const scoutRef = input.state.planning.context.scoutRef;
    if (!scoutRef) throw new Error("Plan creation requires scout evidence");

    const targetVersion = input.state.planning.currentPlanVersion + 1;
    if (!Number.isSafeInteger(targetVersion)) {
      throw new Error("Plan version cannot be incremented safely");
    }
    requirePlanningPolicy(input.state);
    const architectureRequired = input.state.planning.architectureRequired;
    const plannerInput: PlannerInput = {
      taskRef: input.state.taskRef,
      scoutRef,
      ...(input.state.planning.context.researchRef
        ? { researchRef: input.state.planning.context.researchRef }
        : {}),
      ...(input.state.planning.context.clarificationRef
        ? { clarificationRef: input.state.planning.context.clarificationRef }
        : {}),
      ...((input.previousPlanRef ?? input.state.planning.currentPlanRef)
        ? {
            previousPlanRef:
              input.previousPlanRef ?? input.state.planning.currentPlanRef,
          }
        : {}),
      ...((input.feedbackRef ?? input.state.planning.latestPlanReviewRef)
        ? {
            feedbackRef:
              input.feedbackRef ?? input.state.planning.latestPlanReviewRef,
          }
        : {}),
      targetVersion,
    };
    const plannerResult = await this.runPlanner(
      input.state,
      request(
        "planner",
        `Target version: ${targetVersion}. Produce a plan from the supplied artifact refs. Include Scope / Requirements, ${architectureRequired ? "Architecture / Design, " : ""}Implementation Plan, and exactly one machine-readable Validation Contract. Do not implement source code or mutate State.`,
        plannerInputRefs(plannerInput),
        input.cwd,
      ),
    );
    const parsedPlan = parsePlan(plannerResult.output, {
      architectureRequired,
    });
    const planRef = await this.dependencies.artifactStore.writeText(
      "plan",
      `plan-v${targetVersion}.md`,
      plannerResult.output,
    );
    let state = await advanceWorkflow(
      input.state,
      { type: "PLAN_CREATED", planRef, version: targetVersion },
      this.dependencies.stateStore,
    );
    let planReview: PlanReviewHandle | undefined;
    if (this.dependencies.plannotatorGate) {
      const opened = await this.openPlanReview({ state });
      state = opened.state;
      if (opened.status === "opened") planReview = opened.handle;
    }
    return {
      state,
      planRef,
      plannerInput,
      parsedPlan,
      ...(planReview ? { planReview } : {}),
    };
  }

  async openPlanReview(
    input: OpenPlanReviewInput,
  ): Promise<OpenPlanReviewResult> {
    if (input.state.phase !== "awaiting-plan-review") {
      throw new Error("Plan review requires awaiting-plan-review phase");
    }
    const gate = this.dependencies.plannotatorGate;
    if (!gate) throw new Error("PlannotatorGate is required");
    const planRef = currentPlan(input.state);
    const existingId =
      input.state.external[
        planReviewIdentityKey(input.state.planning.currentPlanVersion)
      ];
    if (existingId || input.state.planning.planReview) {
      const reviewId =
        input.state.planning.planReview?.reviewId ??
        (existingId as PlannotatorReviewId);
      requirePlanReviewBinding(input.state, reviewId);
      const outcome = await this.reconcilePlanReview({
        state: input.state,
        reviewId,
      });
      return { status: "reconciled", state: outcome.state, outcome };
    }
    let handle: PlanReviewHandle;
    try {
      handle = await gate.openPlanReview({
        planRef,
        planVersion: input.state.planning.currentPlanVersion,
      });
    } catch {
      const state = await advanceWorkflow(
        input.state,
        { type: "BLOCK", reason: "human-gate-unavailable" },
        this.dependencies.stateStore,
      );
      return { status: "blocked", state };
    }
    if (
      !isPlanReviewBinding(handle) ||
      handle.planVersion !== input.state.planning.currentPlanVersion ||
      !sameArtifactRef(handle.planRef, planRef)
    ) {
      const state = await advanceWorkflow(
        input.state,
        { type: "BLOCK", reason: "human-gate-unavailable" },
        this.dependencies.stateStore,
      );
      return { status: "blocked", state };
    }
    const stateWithIdentity = structuredClone(input.state);
    stateWithIdentity.planning.planReview = structuredClone(handle);
    stateWithIdentity.external[planReviewIdentityKey(handle.planVersion)] =
      handle.reviewId;
    const state = await this.dependencies.stateStore.saveState(
      stateWithIdentity,
      input.state.stateRevision,
    );
    return { status: "opened", state, handle };
  }

  async reconcilePlanReview(
    input: ReconcilePlanReviewInput,
  ): Promise<PlanReviewOutcome> {
    if (!this.dependencies.plannotatorGate) {
      throw new Error("PlannotatorGate is required");
    }
    const binding = requirePlanReviewBinding(input.state, input.reviewId);
    let status: PlanReviewStatus;
    try {
      status = await this.dependencies.plannotatorGate.getPlanReview(
        input.reviewId,
        binding,
      );
    } catch {
      const state = await advanceWorkflow(
        input.state,
        { type: "BLOCK", reason: "human-gate-unavailable" },
        this.dependencies.stateStore,
      );
      return { status: "blocked", state, reviewId: input.reviewId };
    }
    return this.applyPlanReview({ ...input, status });
  }

  async applyPlanReview(input: {
    state: WorkflowState;
    reviewId: PlannotatorReviewId;
    status: PlanReviewStatus;
  }): Promise<PlanReviewOutcome> {
    const { state, reviewId, status } = input;
    requirePlanReviewBinding(state, reviewId);
    if (status.reviewId !== reviewId) {
      throw new StalePlanReviewError(
        "Plan review result has a different review identity",
      );
    }
    if (status.status === "pending") {
      assertSettledReviewMatchesCurrentPlan(state, status);
      return { status: "pending", state, reviewId };
    }
    if (status.status === "unknown") {
      return {
        status: "unknown",
        state,
        reviewId,
        ...(status.reason ? { reason: status.reason } : {}),
      };
    }
    assertSettledReviewMatchesCurrentPlan(state, status);
    const expectedReviewRef = reviewArtifactRef(reviewId, status);
    const alreadyApplied = sameArtifactRef(
      state.planning.latestPlanReviewRef,
      expectedReviewRef,
    );
    if (alreadyApplied) {
      return {
        status: status.status,
        state,
        reviewId,
        reviewRef: expectedReviewRef,
      };
    }

    if (state.planning.latestPlanReviewRef) {
      throw new StalePlanReviewError(
        "A settled review identity was reused for another result",
      );
    }
    if (state.phase !== "awaiting-plan-review") {
      throw new StalePlanReviewError(
        "Unapplied plan review requires awaiting-plan-review phase",
      );
    }

    const reviewRef = await this.persistPlanReview(reviewId, status);
    const event: WorkflowEvent =
      status.status === "approved"
        ? {
            type: "PLAN_APPROVED",
            planRef: status.planRef,
            version: status.planVersion,
            reviewRef,
          }
        : { type: "PLAN_FEEDBACK", feedbackRef: reviewRef };
    const nextState = await advanceWorkflow(
      state,
      event,
      this.dependencies.stateStore,
    );
    return {
      status: status.status,
      state: nextState,
      reviewId,
      reviewRef,
    };
  }

  private async persistPlanReview(
    reviewId: PlannotatorReviewId,
    status: Extract<PlanReviewStatus, { status: "approved" | "feedback" }>,
  ): Promise<ArtifactRef<"plan-review">> {
    const artifact: PlanReviewArtifact = {
      schemaVersion: 1,
      reviewId,
      status: status.status,
      planRef: status.planRef,
      planVersion: status.planVersion,
      ...(status.status === "feedback" ? { feedback: status.feedback } : {}),
    };
    const content = reviewArtifactContent(artifact);
    const fileName = reviewFileName(reviewId);
    const expectedRef = reviewArtifactRef(reviewId, status);
    try {
      return await this.dependencies.artifactStore.writeText(
        "plan-review",
        fileName,
        content,
      );
    } catch (error) {
      const readText = this.dependencies.artifactStore.readText?.bind(
        this.dependencies.artifactStore,
      );
      if (!(error instanceof ArtifactImmutableError) || !readText) throw error;
      try {
        if ((await readText(expectedRef)) === content) {
          return expectedRef;
        }
      } catch {
        // Preserve the original immutable-write error below.
      }
      throw error;
    }
  }

  private async runPlanner(
    state: WorkflowState,
    input: AgentRunRequest,
  ): Promise<Extract<AgentRunResult, { status: "succeeded" }>> {
    let result: AgentRunResult;
    try {
      result = await this.dependencies.subagentExecutor.run(input);
    } catch (error) {
      await advanceWorkflow(
        state,
        { type: "BLOCK", reason: blockedReason(error) },
        this.dependencies.stateStore,
      );
      throw error;
    }
    if (result.status !== "succeeded") {
      await advanceWorkflow(
        state,
        { type: "BLOCK", reason: resultBlockedReason(result) },
        this.dependencies.stateStore,
      );
      throw new Error(`Planner did not succeed: ${result.status}`);
    }
    if (result.output.trim().length === 0) {
      await advanceWorkflow(
        state,
        { type: "BLOCK", reason: "agent-execution-ambiguous" },
        this.dependencies.stateStore,
      );
      throw new Error("Planner returned empty output");
    }
    return result;
  }

  private async run(
    state: WorkflowState,
    input: AgentRunRequest,
  ): Promise<
    | { result: Extract<AgentRunResult, { status: "succeeded" }> }
    | { state: WorkflowState }
  > {
    let result: AgentRunResult;
    try {
      result = await this.dependencies.subagentExecutor.run(input);
    } catch (error) {
      const blocked = await advanceWorkflow(
        state,
        { type: "BLOCK", reason: blockedReason(error) },
        this.dependencies.stateStore,
      );
      return { state: blocked };
    }

    if (result.status !== "succeeded") {
      const blocked = await advanceWorkflow(
        state,
        { type: "BLOCK", reason: resultBlockedReason(result) },
        this.dependencies.stateStore,
      );
      return { state: blocked };
    }

    if (result.output.trim().length === 0) {
      const blocked = await advanceWorkflow(
        state,
        { type: "BLOCK", reason: "agent-execution-ambiguous" },
        this.dependencies.stateStore,
      );
      return { state: blocked };
    }

    return { result };
  }

  private writeOutput<K extends "scout" | "research">(
    kind: K,
    fileName: string,
    output: string,
  ): Promise<ArtifactRef<K>> {
    return this.dependencies.artifactStore.writeText(kind, fileName, output);
  }
}

export async function gatherContext(
  input: GatherContextInput,
  dependencies: PlanningOrchestratorDependencies,
): Promise<ContextGatheringResult> {
  return new PlanningOrchestrator(dependencies).gatherContext(input);
}

export async function requestClarification(
  input: ClarificationInput,
  dependencies: PlanningOrchestratorDependencies,
): Promise<ClarificationOutcome> {
  return new PlanningOrchestrator(dependencies).requestClarification(input);
}

export async function createPlan(
  input: CreatePlanInput,
  dependencies: PlanningOrchestratorDependencies,
): Promise<PlanCreationResult> {
  return new PlanningOrchestrator(dependencies).createPlan(input);
}

export async function openPlanReview(
  input: OpenPlanReviewInput,
  dependencies: PlanningOrchestratorDependencies,
): Promise<OpenPlanReviewResult> {
  return new PlanningOrchestrator(dependencies).openPlanReview(input);
}

export async function reconcilePlanReview(
  input: ReconcilePlanReviewInput,
  dependencies: PlanningOrchestratorDependencies,
): Promise<PlanReviewOutcome> {
  return new PlanningOrchestrator(dependencies).reconcilePlanReview(input);
}
