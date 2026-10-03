import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  parsePlanDeviationReport,
  workerDeviation,
  type PlanDeviationReport,
} from "../../core/coding/plan-deviation.ts";
import {
  isArtifactRef,
  type ArtifactRef,
} from "../../core/artifacts/references.ts";
import { hasOnlyKeys, isRecord } from "../../core/schema.ts";
import { sameArtifactRef } from "../../core/workflow/invariants.ts";
import type { WorkflowState } from "../../core/workflow/state.ts";
import {
  createArtifactRef,
  ArtifactImmutableError,
} from "../persistence/artifact-store.ts";
import { artifactRelativePath } from "../persistence/artifact-paths.ts";
import {
  parseWorkerAttempt,
  type WorkerAttemptEvidence,
} from "../worker/attempt-evidence.ts";
import { validateWorkerStrategy } from "../worker/development-strategy.ts";
import { authoritativeText } from "./coding-evidence.ts";
import {
  advanceWorkflow,
  type WorkflowStateWriter,
} from "./advance-workflow.ts";
import type { WorkflowArtifactWriter } from "./planning-orchestrator.ts";

export interface PlanDeviationArtifact {
  schemaVersion: 1;
  report: PlanDeviationReport;
  workerAttemptRef: ArtifactRef<"implementation">;
  /** Full bounded terminal output, not display/notification text. */
  output: string;
}

export function parsePlanDeviationArtifact(
  value: unknown,
): PlanDeviationArtifact {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "report",
      "workerAttemptRef",
      "output",
    ]) ||
    value.schemaVersion !== 1 ||
    !isArtifactRef(value.workerAttemptRef) ||
    value.workerAttemptRef.kind !== "implementation" ||
    typeof value.output !== "string" ||
    value.output.length > 16_000
  )
    throw Error("Invalid Plan deviation artifact");
  const report = parsePlanDeviationReport(value.report);
  if (!isDeepStrictEqual(report, workerDeviation(value.output)))
    throw Error("Deviation output/report mismatch");
  return {
    schemaVersion: 1,
    report,
    workerAttemptRef: { ...value.workerAttemptRef, kind: "implementation" },
    output: value.output,
  };
}

async function existing<K extends ArtifactRef["kind"]>(
  store: WorkflowArtifactWriter,
  kind: K,
  name: string,
): Promise<ArtifactRef<K> | undefined> {
  if (!store.rootDirectory)
    throw Error("Deviation requires rooted ArtifactStore");
  const path = artifactRelativePath(kind, name);
  let text: string;
  try {
    text = await readFile(join(store.rootDirectory, path), "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  const ref = createArtifactRef(kind, path, text);
  await authoritativeText(store, ref);
  return ref;
}

async function persist<K extends ArtifactRef["kind"]>(
  store: WorkflowArtifactWriter,
  kind: K,
  name: string,
  value: unknown,
): Promise<ArtifactRef<K>> {
  const text = JSON.stringify(value);
  const expected = createArtifactRef(
    kind,
    artifactRelativePath(kind, name),
    text,
  );
  try {
    if (!store.writeJson)
      throw Error("Deviation requires schema-validated JSON ArtifactStore");
    const ref = await store.writeJson(kind, name, value, (candidate) =>
      kind === "implementation"
        ? parseWorkerAttempt(candidate)
        : parsePlanDeviationArtifact(candidate),
    );
    if (!sameArtifactRef(ref, expected))
      throw Error("Deviation writer returned wrong ref");
    return ref;
  } catch (error) {
    if (
      error instanceof ArtifactImmutableError &&
      (await authoritativeText(store, expected)) === text
    )
      return expected;
    throw error;
  }
}

function assertReportBinding(
  report: PlanDeviationReport,
  attempt: WorkerAttemptEvidence,
): void {
  if (
    report.workflowId !== attempt.workflowId ||
    report.attemptId !== attempt.attemptId ||
    report.planVersion !== attempt.planVersion ||
    report.inputRevision !== attempt.inputRevision ||
    !sameArtifactRef(report.approvedPlanRef, attempt.approvedPlanRef)
  )
    throw Error("Deviation belongs to a different Plan/Worker/revision");
}

function assertTerminal(attempt: WorkerAttemptEvidence): void {
  if (
    !attempt.launch ||
    !attempt.receipt ||
    !attempt.runId ||
    attempt.launchStatus !== "observed" ||
    attempt.receipt.runId !== attempt.runId ||
    attempt.receipt.requestId !== attempt.dispatch.requestId ||
    attempt.receipt.launchContractDigest !==
      attempt.launch.launchContractDigest ||
    attempt.dispatch.ownerRunId !== attempt.workflowId ||
    attempt.receipt.agent !== "worker" ||
    attempt.receipt.cwd !== attempt.before.cwd ||
    attempt.after?.status !== "observed" ||
    attempt.before.root !== attempt.after.snapshot.root ||
    attempt.before.cwd !== attempt.after.snapshot.cwd
  )
    throw Error("Deviation has no exact terminal Worker/workspace binding");
}

/** Validates retained history without attaching old stopped authority to a newer Plan. */
export async function readPlanDeviation(
  store: WorkflowArtifactWriter,
  state: WorkflowState,
): Promise<PlanDeviationArtifact | undefined> {
  const ref = state.coding.latestDeviationRef;
  if (!ref) return undefined;
  const artifact = parsePlanDeviationArtifact(
    JSON.parse(await authoritativeText(store, ref)),
  );
  const attempt = parseWorkerAttempt(
    JSON.parse(await authoritativeText(store, artifact.workerAttemptRef)),
  );
  assertReportBinding(artifact.report, attempt);
  assertTerminal(attempt);
  if (
    attempt.status !== "deviated" ||
    attempt.workflowId !== state.workflowId ||
    attempt.planVersion > state.planning.currentPlanVersion ||
    attempt.inputRevision > state.coding.implementationRevision
  )
    throw Error("Stale/mismatched deviation history");
  const plan = await validateWorkerStrategy(store, state, attempt);
  if (!plan.content.includes(artifact.report.constraint))
    throw Error("Deviation constraint is not in approved Plan");
  return artifact;
}

export async function validateStoppedWorker(
  store: WorkflowArtifactWriter,
  state: WorkflowState,
  ref: ArtifactRef<"implementation">,
  attempt: WorkerAttemptEvidence,
): Promise<boolean> {
  if (attempt.status !== "deviated") return false;
  // An unpublished stop still under its old approval belongs to exact recovery,
  // not terminal corruption and never a fresh Worker dispatch.
  if (sameArtifactRef(attempt.approvedPlanRef, state.planning.approvedPlanRef))
    return false;
  const deviation = await readPlanDeviation(store, state);
  if (
    !deviation ||
    !sameArtifactRef(deviation.workerAttemptRef, ref) ||
    attempt.inputRevision !== state.coding.implementationRevision ||
    !state.planning.approvedPlanVersion ||
    state.planning.approvedPlanVersion <= attempt.planVersion ||
    sameArtifactRef(state.planning.approvedPlanRef, attempt.approvedPlanRef)
  )
    throw Error("Stopped Worker requires a distinct newly Human-approved Plan");
  return true;
}

/** Terminal stop -> immutable workspace/attempt evidence -> deviation -> CAS invalidation. No Oracle required. */
export async function publishPlanDeviation(
  state: WorkflowState,
  attemptRef: ArtifactRef<"implementation">,
  attempt: WorkerAttemptEvidence,
  output: string,
  deps: {
    artifactStore: WorkflowArtifactWriter;
    stateStore: WorkflowStateWriter;
  },
): Promise<{
  state: WorkflowState;
  deviationRef: ArtifactRef<"plan-deviation">;
}> {
  const report = workerDeviation(output);
  if (!report) throw Error("Missing Worker deviation stop signal");
  assertReportBinding(report, attempt);
  assertTerminal(attempt);
  if (
    !["implementing", "fixing"].includes(state.phase) ||
    state.workflowId !== attempt.workflowId ||
    !sameArtifactRef(state.coding.workerAttemptRef, attemptRef) ||
    !sameArtifactRef(state.planning.approvedPlanRef, attempt.approvedPlanRef) ||
    state.planning.approvedPlanVersion !== attempt.planVersion ||
    state.coding.implementationRevision !== attempt.inputRevision ||
    !sameArtifactRef(
      state.coding.executionRoutingRef,
      attempt.executionRoutingRef,
    )
  )
    throw Error("Deviation cannot invalidate different current authority");
  const plan = await validateWorkerStrategy(deps.artifactStore, state, attempt);
  if (!plan.content.includes(report.constraint))
    throw Error("Deviation must cite an exact approved Plan constraint");
  const name = `attempt-${attempt.attemptId}-deviated.json`;
  let stoppedRef = await existing(deps.artifactStore, "implementation", name);
  const stopped = stoppedRef
    ? parseWorkerAttempt(
        JSON.parse(await authoritativeText(deps.artifactStore, stoppedRef)),
      )
    : parseWorkerAttempt({
        ...attempt,
        previousRef: attemptRef,
        status: "deviated",
      });
  assertTerminal(stopped);
  assertReportBinding(report, stopped);
  for (const key of [
    "inputRefs",
    "inputImplementationRef",
    "before",
    "after",
    "launch",
    "receipt",
    "runId",
    "dispatch",
    "executionProfile",
    "executionRoutingRef",
  ] as const)
    if (!isDeepStrictEqual(stopped[key], attempt[key]))
      throw Error("Stopped Worker identity/workspace drift");
  if (stopped.status !== "deviated")
    throw Error("Invalid stopped Worker record");
  stoppedRef ??= await persist(
    deps.artifactStore,
    "implementation",
    name,
    stopped,
  );
  let current = sameArtifactRef(state.coding.workerAttemptRef, stoppedRef)
    ? state
    : await deps.stateStore.saveState(
        {
          ...state,
          coding: { ...state.coding, workerAttemptRef: stoppedRef },
        },
        state.stateRevision,
      );
  const artifact = parsePlanDeviationArtifact({
    schemaVersion: 1,
    report,
    workerAttemptRef: stoppedRef,
    output,
  });
  const deviationRef = await persist(
    deps.artifactStore,
    "plan-deviation",
    `deviation-${attempt.attemptId}.json`,
    artifact,
  );
  current = await advanceWorkflow(
    current,
    { type: "PLAN_DEVIATION_REPORTED", deviationRef },
    deps.stateStore,
  );
  return { state: current, deviationRef };
}
