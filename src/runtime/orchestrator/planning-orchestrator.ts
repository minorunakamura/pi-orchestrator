import type {
  ArtifactKind,
  ArtifactRef,
} from "../../core/artifacts/references.ts";
import {
  plannerInputRefs,
  type PlannerInput,
} from "../../core/planning/policy.ts";
import {
  resolvePlaybookPolicy,
  type PlaybookContext,
} from "../../core/playbooks/policy.ts";
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
  type SubagentExecutor,
} from "../ports/index.ts";
import {
  advanceWorkflow,
  type WorkflowStateWriter,
} from "./advance-workflow.ts";

export interface WorkflowArtifactWriter {
  writeText<K extends ArtifactKind>(
    kind: K,
    fileName: string,
    content: string,
  ): Promise<ArtifactRef<K>>;
}

export interface GatherContextInput {
  state: WorkflowState;
  context?: PlaybookContext;
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
  context?: PlaybookContext;
  cwd?: string;
  previousPlanRef?: ArtifactRef<"plan">;
  feedbackRef?: ArtifactRef<"plan-review">;
}

export interface PlanCreationResult {
  state: WorkflowState;
  planRef: ArtifactRef<"plan">;
  plannerInput: PlannerInput;
  parsedPlan: ParsedPlan;
}

export interface PlanningOrchestratorDependencies {
  artifactStore: WorkflowArtifactWriter;
  stateStore: WorkflowStateWriter;
  subagentExecutor: SubagentExecutor;
  clarificationPort?: ClarificationPort;
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

    const taskRef = input.state.taskRef;
    let state = input.state;
    const scoutResult = await this.run(
      state,
      request(
        "workflow-scout",
        "Gather repository-local facts and evidence for the task. Return paths, line ranges, constraints, and unknowns; do not make decisions or mutate State.",
        [taskRef],
        input.cwd,
      ),
    );
    if ("state" in scoutResult) {
      return { state: scoutResult.state };
    }

    const scoutRef = await this.writeOutput(
      "scout",
      "scout.md",
      scoutResult.result.output,
    );
    state = await advanceWorkflow(
      state,
      { type: "CONTEXT_EVIDENCE_PERSISTED", scoutRef },
      this.dependencies.stateStore,
    );

    const policy = resolvePlaybookPolicy(input.state.playbook, input.context);
    let researchRef: ArtifactRef<"research"> | undefined;
    if (policy.research === "required") {
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

    const event: WorkflowEvent =
      policy.clarification === "required"
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
    const architectureRequired =
      input.state.planning.architectureRequired ??
      (input.context
        ? resolvePlaybookPolicy(input.state.playbook, input.context)
            .architecture === "required"
        : true);
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
    const state = await advanceWorkflow(
      input.state,
      { type: "PLAN_CREATED", planRef, version: targetVersion },
      this.dependencies.stateStore,
    );
    return { state, planRef, plannerInput, parsedPlan };
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
