import { safeWorkflowId } from "../../../src/types.ts";
import { afterEach, expect, test, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  phaseCWorkflow,
  reviewFinding,
  type PhaseCWorkflow,
} from "../../fakes/phase-c-workflow.ts";
import { parseWorkerAttempt } from "../../../src/runtime/worker/attempt-evidence.ts";
import {
  parsePlanDeviationArtifact,
  readPlanDeviation,
  publishPlanDeviation,
} from "../../../src/runtime/orchestrator/plan-deviation.ts";
import { PlanningOrchestrator } from "../../../src/runtime/orchestrator/planning-orchestrator.ts";
import { assertOracleReason } from "../../../src/core/oracle.ts";
import type { WorkflowDriverDependencies } from "../../../src/runtime/orchestrator/drive-workflow.ts";

const workflows: PhaseCWorkflow[] = [];
async function setup(
  workers: ("deviation" | "success")[] = ["deviation", "success"],
) {
  const h = await phaseCWorkflow({ workers });
  workflows.push(h);
  return h;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(workflows.splice(0).map((h) => h.cleanup()));
});
function deps(h: PhaseCWorkflow) {
  return { ...h, loadState: h.load };
}
async function approve(h: PhaseCWorkflow) {
  await h.createPlan();
  return h.settlePlan();
}

test("exact Plan -> local freedom or stop -> automatic fresh simplicity/Human Gate -> new approval only", async () => {
  const h = await setup();
  const first = await h.drive();
  const stopped = await h.drive();
  expect(stopped.state.phase).toBe("awaiting-plan-review");
  expect(stopped.state.planning.currentPlanVersion).toBe(2);
  expect(stopped.state.planning.approvedPlanRef).toBeUndefined();
  expect(stopped.state.planning.simplicityReviewRef).not.toEqual(
    first.state.planning.simplicityReviewRef,
  );
  expect(stopped.state.coding.implementationRef).toBeUndefined();
  expect(stopped.state.coding.implementationRevision).toBe(0);
  expect(stopped.state.coding.executionRoutingRef).toBeUndefined();
  expect(h.validations).toHaveLength(0);
  const ref = stopped.state.coding.latestDeviationRef!;
  const deviation = parsePlanDeviationArtifact(
    JSON.parse(await h.artifactStore.readText(ref)),
  );
  const attempt = parseWorkerAttempt(
    JSON.parse(await h.artifactStore.readText(deviation.workerAttemptRef)),
  );
  expect(attempt.status).toBe("deviated");
  expect(attempt.after?.status).toBe("observed");
  expect(attempt.implementationRef).toBeUndefined();
  expect(deviation.report.approvedPlanRef).toEqual(
    first.state.planning.currentPlanRef,
  );
  const worker = h.children.find((c) => c.agent === "worker")!;
  const supplied = JSON.parse(
    worker.task.split(
      "Artifact inputs (refs and full contents verified through the orchestrator ArtifactStore; paths are relative to that store, not cwd). Use these contents directly; they do not grant authority to change Workflow State:\n",
    )[1],
  );
  expect(supplied[0]).toEqual({
    ref: first.state.planning.currentPlanRef,
    content: await h.artifactStore.readText(
      first.state.planning.currentPlanRef!,
    ),
  });
  expect(worker.task).toContain("Private helpers, local naming, test helpers");
  expect(worker.task).toContain("STOP ALL mutation");
  expect(worker.task).toContain(attempt.attemptId);
  expect(h.children.filter((c) => c.agent === "planner")[1].task).toContain(
    ref.sha256,
  );
  expect(
    h.children.filter((c) => c.agent === "plan-simplicity-reviewer"),
  ).toHaveLength(2);
  expect(h.children.filter((c) => c.agent === "worker")).toHaveLength(1);
  expect(
    await readFile(join(h.repositoryCwd, "implementation.txt"), "utf8"),
  ).toBe("implementation revision 1\n");
  const progressed = await h.drive();
  expect(progressed.state.phase).toBe("awaiting-code-review");
  expect(progressed.state.planning.approvedPlanVersion).toBe(2);
  expect(progressed.state.coding.implementationRevision).toBe(1);
  expect(h.children.filter((c) => c.agent === "worker")).toHaveLength(2);
  expect((await h.drive()).state.phase).toBe("completed");
});

test("stopped fixing Worker clears old Fix/Code/review authority and keeps prior evidence", async () => {
  const h = await phaseCWorkflow({
    workers: ["success", "deviation", "success"],
    reviews: [[reviewFinding("C1")]],
    rounds: [{ action: "RETRY" }],
  });
  workflows.push(h);
  await h.drive();
  const wait = await h.drive();
  expect(wait.state.phase).toBe("awaiting-plan-review");
  expect(wait.state.coding.implementationRevision).toBe(1);
  for (const key of [
    "acceptedFindingsRef",
    "findingEvaluationRef",
    "roundDecisionRef",
    "validationRef",
    "correctnessReviewRef",
    "ponytailReviewRef",
    "latestCodeReviewRef",
    "codeReview",
    "executionRoutingRef",
  ] as const)
    expect(wait.state.coding[key]).toBeUndefined();
  expect(wait.state.coding.previousRoundDecisionRef).toBeDefined();
  expect(wait.state.counters.automatedFixRoundsUsed).toBe(1);
  // Reapproval/normal continuation is covered above; this check ends at the Fix authority barrier.
  expect(h.children.filter((c) => c.agent === "worker")).toHaveLength(2);
});

test.each(["deviation-artifact", "deviation-state", "stopped-state"] as const)(
  "%s save failure recovers exact terminal output with zero redispatch",
  async (failure) => {
    const h = await setup();
    await approve(h);
    let triggered = false;
    const overrides: Partial<WorkflowDriverDependencies> =
      failure === "deviation-artifact"
        ? {
            artifactStore: {
              rootDirectory: h.artifactStore.rootDirectory,
              readText: h.artifactStore.readText.bind(h.artifactStore),
              writeText: h.artifactStore.writeText.bind(h.artifactStore),
              writeJson: async (kind, name, value, schema) => {
                if (!triggered && kind === "plan-deviation") {
                  triggered = true;
                  throw Error("injected deviation Artifact failure");
                }
                return h.artifactStore.writeJson(kind, name, value, schema);
              },
            },
          }
        : {
            stateStore: {
              saveState: async (state, revision) => {
                const stopped =
                  state.coding.workerAttemptRef?.path.endsWith(
                    "-deviated.json",
                  );
                if (
                  !triggered &&
                  (failure === "deviation-state"
                    ? state.coding.latestDeviationRef
                    : stopped)
                ) {
                  triggered = true;
                  throw Error("injected deviation State failure");
                }
                return h.stateStore.saveState(state, revision);
              },
            },
          };
    try {
      await h.drive(overrides);
    } catch {
      /* Failed save never counts as completion. */
    }
    expect(triggered).toBe(true);
    expect(h.children.filter((c) => c.agent === "worker")).toHaveLength(1);
    expect(h.validations).toHaveLength(0);
    const stillStopped = await h.drive();
    expect(stillStopped.state.phase).toBe("blocked");
    expect(stillStopped.state.failure).toBeUndefined();
    expect(h.children.filter((c) => c.agent === "worker")).toHaveLength(1);
    const resumed = await h.resume();
    expect(
      resumed.state.phase,
      resumed.state.block?.evidenceRef
        ? await h.artifactStore.readText(resumed.state.block.evidenceRef)
        : resumed.reason,
    ).toBe("awaiting-plan-review");
    expect(resumed.state.planning.approvedPlanRef).toBeUndefined();
    expect(h.children.filter((c) => c.agent === "worker")).toHaveLength(1);
    expect(resumed.state.coding.latestDeviationRef).toBeDefined();
  },
);

test("old approval and deviation cannot attach to a new Plan/workflow/revision", async () => {
  const h = await setup();
  const approved = await approve(h);
  const stop = await h.implement();
  expect(stop.state.phase).toBe("planning");
  expect(() =>
    assertOracleReason(approved.state, "material-plan-deviation"),
  ).toThrow();
  expect(() =>
    assertOracleReason(stop.state, "material-plan-deviation"),
  ).not.toThrow();
  const planning = new PlanningOrchestrator(deps(h));
  const oldBinding = approved.state.planning.planReview!;
  await expect(
    planning.applyPlanReview({
      state: stop.state,
      reviewId: oldBinding.reviewId,
      status: { ...oldBinding, status: "approved" },
    }),
  ).rejects.toThrow();
  const artifact = await readPlanDeviation(h.artifactStore, stop.state);
  expect(artifact).toBeDefined();
  await expect(
    readPlanDeviation(h.artifactStore, {
      ...stop.state,
      workflowId: safeWorkflowId("different"),
    }),
  ).rejects.toThrow();
  const attempt = parseWorkerAttempt(
    JSON.parse(
      await h.artifactStore.readText(stop.state.coding.workerAttemptRef!),
    ),
  );
  await expect(
    publishPlanDeviation(
      {
        ...approved.state,
        coding: { ...approved.state.coding, implementationRevision: 99 },
      },
      artifact!.workerAttemptRef,
      attempt,
      artifact!.output,
      deps(h),
    ),
  ).rejects.toThrow();
});

test("workspace drift after terminal stop blocks new mutation, no rollback/relaunch", async () => {
  const h = await setup();
  await h.drive();
  await h.drive();
  await writeFile(join(h.repositoryCwd, "foreign.txt"), "out-of-band change");
  expect((await h.drive()).state.phase).toBe("blocked");
  expect(h.children.filter((c) => c.agent === "worker")).toHaveLength(1);
});

test("unreported material boundary violation forces replan even when Jev round says COMPLETE", async () => {
  const finding = {
    ...reviewFinding("C1"),
    category: "plan-boundary-violation",
  };
  const h = await phaseCWorkflow({
    reviews: [[finding]],
    findings: { C1: { planConflict: true } },
  });
  workflows.push(h);
  await h.drive();
  const next = await h.drive();
  expect(next.state.phase).toBe("awaiting-plan-review");
  expect(next.state.planning.currentPlanVersion).toBe(2);
  expect(next.state.planning.approvedPlanRef).toBeUndefined();
  expect(h.children.filter((c) => c.agent === "worker")).toHaveLength(1);
  expect(h.gates.filter((g) => g.action === "code-review")).toHaveLength(0);
});
