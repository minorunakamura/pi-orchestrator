import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  playbookKinds,
  resolvePlaybookPolicy,
  type PlaybookContext,
} from "../../core/playbooks/policy.ts";
import type { WorkflowState } from "../../core/workflow/state.ts";
import type { PlaybookKind, WorkflowId } from "../../types.ts";
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
  const value = factory ? factory() : randomUUID();
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  ) {
    throw new Error("Workflow ID must be a safe non-empty path segment");
  }
  return value as WorkflowId;
}

function assertStartInput(input: StartWorkflowInput): void {
  if (input.task.trim().length === 0) {
    throw new Error("Workflow task must not be empty");
  }
  if (!playbookKinds.includes(input.playbook)) {
    throw new Error(`Unsupported playbook: ${input.playbook}`);
  }
}

export async function startWorkflow(
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
  const initialState: WorkflowState = {
    schemaVersion: 1,
    workflowId,
    stateRevision: 0,
    playbook: input.playbook,
    phase: "gathering-context",
    taskRef,
    planning: {
      context: {},
      architectureRequired:
        resolvePlaybookPolicy(input.playbook, input.context).architecture ===
        "required",
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
  const context = await new PlanningOrchestrator({
    artifactStore,
    stateStore,
    subagentExecutor: options.subagentExecutor,
  }).gatherContext({
    state: persistedInitialState,
    context: input.context,
    cwd: input.cwd,
  });

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

export const createWorkflow = startWorkflow;
