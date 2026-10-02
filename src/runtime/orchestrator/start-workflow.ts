import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  playbookKinds,
  resolvePlaybookPolicy,
  type PlaybookContext,
} from "../../core/playbooks/policy.ts";
import type { WorkflowState } from "../../core/workflow/state.ts";
import {
  safeWorkflowId,
  type PlaybookKind,
  type WorkflowId,
} from "../../types.ts";
import { ArtifactStore } from "../persistence/artifact-store.ts";
import { StateStore } from "../persistence/state-store.ts";
import type { SubagentExecutor } from "../ports/index.ts";
import {
  PlanningOrchestrator,
  type ContextGatheringResult,
  type WorkflowArtifactWriter,
} from "./planning-orchestrator.ts";
import type { WorkflowStateWriter } from "./advance-workflow.ts";

export interface StartWorkflowInput {
  task: string;
  playbook: PlaybookKind;
  context?: PlaybookContext;
  cwd?: string;
}

export interface StartWorkflowOptions {
  runsDirectory: string;
  subagentExecutor: SubagentExecutor;
  workflowIdFactory?: () => string | WorkflowId;
  now?: () => string;
  artifactStore?: WorkflowArtifactWriter;
  stateStore?: WorkflowStateWriter;
}

export interface StartedWorkflow {
  workflowId: WorkflowId;
  runDirectory: string;
  taskRef: WorkflowState["taskRef"];
  state: WorkflowState;
  context: ContextGatheringResult;
  artifactStore: WorkflowArtifactWriter;
  stateStore: WorkflowStateWriter;
}

function defaultNow(): string {
  return new Date().toISOString();
}

function createWorkflowId(
  factory: StartWorkflowOptions["workflowIdFactory"],
): WorkflowId {
  return safeWorkflowId(factory ? factory() : randomUUID());
}

function assertStartInput(input: StartWorkflowInput): void {
  if (input.task.trim().length === 0) {
    throw new Error("Workflow task must not be empty");
  }
  if (!playbookKinds.includes(input.playbook)) {
    throw new Error(`Unsupported playbook: ${input.playbook}`);
  }
}

/** Persist the task and initial authority; no child or Human side effects. */
export async function createWorkflow(
  input: StartWorkflowInput,
  options: StartWorkflowOptions,
): Promise<StartedWorkflow> {
  assertStartInput(input);
  if (options.runsDirectory.trim().length === 0) {
    throw new Error("runsDirectory must not be empty");
  }

  const workflowId = createWorkflowId(options.workflowIdFactory);
  const runDirectory = resolve(join(options.runsDirectory, workflowId));
  const now = options.now ?? defaultNow;
  const artifactStore =
    options.artifactStore ?? new ArtifactStore(runDirectory);
  const stateStore =
    options.stateStore ?? new StateStore(runDirectory, { now });

  const taskRef = await artifactStore.writeText("task", "task.md", input.task);
  const timestamp = now();
  const policy = resolvePlaybookPolicy(input.playbook, input.context);
  const initialState: WorkflowState = {
    schemaVersion: 1,
    workflowId,
    projectRoot: resolve(input.cwd ?? process.cwd()),
    jevUsage: { attemptsReserved: 0 },
    stateRevision: 0,
    playbook: input.playbook,
    phase: "gathering-context",
    taskRef,
    planning: {
      agentAttempts: {},
      context: {},
      researchRequired: policy.research === "required",
      clarificationRequired: policy.clarification === "required",
      architectureRequired: policy.architecture === "required",
      currentPlanVersion: 0,
    },
    coding: {
      implementationRevision: 0,
      reviewRound: 0,
    },
    counters: {
      automatedFixRoundsUsed: 0,
      strongerRetriesUsed: 0,
      humanCodeFeedbackRounds: 0,
    },
    external: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  // This save is deliberately before any SubagentExecutor call.
  const persistedInitialState = await stateStore.saveState(initialState, 0);
  const context: ContextGatheringResult = { state: persistedInitialState };

  return {
    workflowId,
    runDirectory,
    taskRef,
    state: context.state,
    context,
    artifactStore,
    stateStore,
  };
}

/** Stage-level convenience retained for callers that explicitly manage Planning. */
export async function startWorkflow(
  input: StartWorkflowInput,
  options: StartWorkflowOptions,
): Promise<StartedWorkflow> {
  const created = await createWorkflow(input, options);
  const context = await new PlanningOrchestrator({
    artifactStore: created.artifactStore,
    stateStore: created.stateStore,
    subagentExecutor: options.subagentExecutor,
  }).gatherContext({ state: created.state, cwd: input.cwd });
  return { ...created, state: context.state, context };
}
