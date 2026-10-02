import { join, resolve } from "node:path";
import { driveWorkflow } from "./drive-workflow.ts";
import type { WorkflowId } from "../../types.ts";
import type { WorkflowState } from "../../core/workflow/state.ts";
import { ArtifactStore } from "../persistence/artifact-store.ts";
import { StateStore } from "../persistence/state-store.ts";
import type { WorkflowArtifactWriter } from "./planning-orchestrator.ts";
import type { WorkflowStateWriter } from "./advance-workflow.ts";
import {
  WorkflowReconciler,
  type ReconciliationResult,
  type ResumeReconcilerDependencies,
} from "./reconciler.ts";
import type { SubagentExecutor } from "../ports/subagent-executor.ts";

export interface ResumeStateStore extends WorkflowStateWriter {
  loadState?: () => Promise<WorkflowState>;
  withLock?<T>(operation: () => T | Promise<T>): Promise<T>;
}

export type ResumeWorkflowOptions = Omit<
  ResumeReconcilerDependencies,
  "artifactStore" | "stateStore"
> & {
  runDirectory?: string;
  runsDirectory?: string;
  stateStore?: ResumeStateStore;
  artifactStore?: WorkflowArtifactWriter;
  signal?: AbortSignal;
};

export interface ResumeWorkflowInput
  extends Omit<
    ResumeWorkflowOptions,
    "runDirectory" | "runsDirectory" | "stateStore" | "artifactStore"
  > {
  workflowId: WorkflowId | string;
  runDirectory?: string;
  runsDirectory?: string;
  stateStore?: ResumeStateStore;
  artifactStore?: WorkflowArtifactWriter;
}

const workflowIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function assertSafeWorkflowId(workflowId: WorkflowId | string): void {
  if (typeof workflowId !== "string" || !workflowIdPattern.test(workflowId)) {
    throw new Error("Workflow ID must be a safe non-empty path segment");
  }
}

function runDirectoryFor(
  workflowId: WorkflowId | string,
  options: Pick<
    ResumeWorkflowOptions,
    "runDirectory" | "runsDirectory" | "artifactStore"
  >,
): string {
  if (options.runDirectory) return resolve(options.runDirectory);
  if (options.artifactStore?.rootDirectory)
    return resolve(options.artifactStore.rootDirectory);
  if (options.runsDirectory)
    return resolve(join(options.runsDirectory, workflowId));
  throw new Error(
    "Resume requires runDirectory, ArtifactStore.rootDirectory, or runsDirectory",
  );
}

function lockedWriter(store: ResumeStateStore): WorkflowStateWriter {
  return {
    saveState: (state, expectedRevision) =>
      store.saveState(state, expectedRevision, { lockHeld: true }),
  };
}

async function runReconciliation(
  workflowId: WorkflowId | string,
  options: ResumeWorkflowOptions,
): Promise<ReconciliationResult> {
  assertSafeWorkflowId(workflowId);
  const runDirectory = runDirectoryFor(workflowId, options);
  const artifactStore =
    options.artifactStore ?? new ArtifactStore(runDirectory);
  const stateStore = options.stateStore ?? new StateStore(runDirectory);
  const stateRoot = (
    stateStore as ResumeStateStore & { rootDirectory?: string }
  ).rootDirectory;
  if (stateRoot && resolve(stateRoot) !== runDirectory) {
    throw new Error("StateStore root does not match the resume run directory");
  }
  if (
    artifactStore.rootDirectory &&
    resolve(artifactStore.rootDirectory) !== runDirectory
  ) {
    throw new Error(
      "ArtifactStore root does not match the resume run directory",
    );
  }
  const fallbackReader = new StateStore(runDirectory);
  const load: () => Promise<WorkflowState> =
    options.loadState ??
    (stateStore.loadState
      ? stateStore.loadState.bind(stateStore)
      : fallbackReader.loadState.bind(fallbackReader));
  const deps: ResumeReconcilerDependencies = {
    ...options,
    artifactStore,
    stateStore: stateStore.withLock ? lockedWriter(stateStore) : stateStore,
    loadState: load,
  };
  const execute = async (): Promise<
    { planning: WorkflowState } | { result: ReconciliationResult }
  > => {
    const state = await load();
    if (state.workflowId !== workflowId) {
      throw new Error(
        "Persisted Workflow State identity does not match resume input",
      );
    }
    const phase =
      state.phase === "blocked" ? state.block?.blockedFrom : state.phase;
    if (
      state.planning.agentAttempts &&
      (phase === "gathering-context" || phase === "planning")
    )
      return { planning: state };
    return { result: await new WorkflowReconciler(deps).reconcile(state) };
  };
  const selected = stateStore.withLock
    ? await stateStore.withLock(execute)
    : await execute();
  if ("result" in selected) return selected.result;
  const snapshot = selected.planning;
  // Planning dispatch is guarded by a durable CAS intent, not a lock held across a child wait.
  return new WorkflowReconciler({
    ...deps,
    stateStore,
    plannotatorGate: undefined,
  }).reconcile(snapshot);
}

export function resumeWorkflow(
  workflowId: WorkflowId | string,
  options: ResumeWorkflowOptions,
): Promise<ReconciliationResult>;
export function resumeWorkflow(
  input: ResumeWorkflowInput,
): Promise<ReconciliationResult>;
export function resumeWorkflow(
  workflowIdOrInput: WorkflowId | string | ResumeWorkflowInput,
  options?: ResumeWorkflowOptions,
): Promise<ReconciliationResult> {
  if (typeof workflowIdOrInput === "string") {
    if (!options) {
      throw new Error(
        "Resume requires runDirectory, ArtifactStore.rootDirectory, or runsDirectory",
      );
    }
    return resumeAndDrive(workflowIdOrInput, options);
  }
  const { workflowId, ...inputOptions } = workflowIdOrInput;
  return resumeAndDrive(workflowId, inputOptions);
}

async function resumeAndDrive(
  workflowId: string,
  options: ResumeWorkflowOptions,
): Promise<ReconciliationResult> {
  const reconciled = await runReconciliation(workflowId, options);
  if (
    reconciled.status !== "advanced" ||
    reconciled.state.phase === "completed"
  )
    return reconciled;
  const runDirectory = runDirectoryFor(workflowId, options);
  const stateStore = options.stateStore ?? new StateStore(runDirectory);
  return driveWorkflow(workflowId, {
    ...options,
    artifactStore: options.artifactStore ?? new ArtifactStore(runDirectory),
    stateStore,
    loadState:
      options.loadState ??
      (stateStore.loadState
        ? stateStore.loadState.bind(stateStore)
        : () => new StateStore(runDirectory).loadState()),
  });
}

export class WorkflowController {
  constructor(private readonly options: ResumeWorkflowOptions) {}

  resume(workflowId: WorkflowId): Promise<ReconciliationResult> {
    return resumeWorkflow(workflowId, this.options);
  }
}

/** Recovery only; normal commands use resumeWorkflow to continue after reconciliation. */
export const reconcileWorkflow: typeof resumeWorkflow = (
  workflowIdOrInput: WorkflowId | string | ResumeWorkflowInput,
  options?: ResumeWorkflowOptions,
) => {
  if (typeof workflowIdOrInput !== "string") {
    const { workflowId, ...inputOptions } = workflowIdOrInput;
    return runReconciliation(workflowId, inputOptions);
  }
  if (!options)
    throw new Error("Reconciliation requires workflow runtime options");
  return runReconciliation(workflowIdOrInput, options);
};
export type ResumeWorkflowResult = ReconciliationResult;

// Keep the public runtime boundary available without making commands part of ORCH-018.
export type { SubagentExecutor };
