import type {
  ArtifactKind,
  ArtifactRef,
} from "../../core/artifacts/references.ts";
import {
  resolvePlaybookPolicy,
  type PlaybookContext,
} from "../../core/playbooks/policy.ts";
import type {
  WorkflowEvent,
  WorkflowState,
} from "../../core/workflow/state.ts";
import {
  RuntimePortError,
  type AgentRunRequest,
  type AgentRunResult,
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

export interface PlanningOrchestratorDependencies {
  artifactStore: WorkflowArtifactWriter;
  stateStore: WorkflowStateWriter;
  subagentExecutor: SubagentExecutor;
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
