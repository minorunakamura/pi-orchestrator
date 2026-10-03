import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ArtifactStore } from "../../../src/runtime/persistence/artifact-store.ts";
import { StateStore } from "../../../src/runtime/persistence/state-store.ts";
import { createWorkflow } from "../../../src/runtime/orchestrator/start-workflow.ts";
import { driveWorkflow } from "../../../src/runtime/orchestrator/drive-workflow.ts";
import { resumeWorkflow } from "../../../src/runtime/orchestrator/resume-workflow.ts";
import { SubagentsIntegration } from "../../fakes/agent-launch.ts";
import { FakeSubagentRpc } from "../../fakes/subagent-rpc.ts";
import { FakeJevDecisionClient } from "../../fakes/index.ts";
import { diagnosisReport } from "../../fakes/diagnosis.ts";
import {
  projectWorkflowStatus,
  renderWorkflowStatus,
} from "../../../src/ui/workflow-status.ts";
import { configuration } from "../../fakes/coding-scenario.ts";
import { jevPolicy } from "../../fakes/jev-policy.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function setup(receipt = true) {
  const root = await mkdtemp(join(tmpdir(), "diagnosis-recovery-"));
  roots.push(root);
  const runDirectory = join(root, "runs", "diagnosis");
  const artifactStore = new ArtifactStore(runDirectory);
  const stateStore = new StateStore(runDirectory);
  let diagnosisRequest: Record<string, unknown> | undefined;
  const bus = new FakeSubagentRpc((request, rpc) => {
    if (String(request.task).startsWith("Diagnose the")) {
      diagnosisRequest = request;
      if (receipt) rpc.receipt(request, "diagnosis-run");
    } else {
      rpc.receipt(request, "scout-run");
      rpc.complete(request, "scout-run", "complete", "Repository facts");
    }
  });
  const executor = new SubagentsIntegration(bus, {
    cwd: root,
    artifactReader: artifactStore,
    timeoutMs: 150,
  });
  const classifier = new FakeJevDecisionClient({
    stages: { clarification: "RUN" },
  });
  const deps = {
    artifactStore,
    stateStore,
    subagentExecutor: executor,
    loadState: () => stateStore.loadState(),
    cwd: root,
    configuration: { ...configuration, jev: jevPolicy("diagnosis", root) },
    jevDecisionClient: classifier,
  };
  await createWorkflow(
    { task: "Diagnose the reported failure", playbook: "bugfix", cwd: root },
    {
      ...deps,
      runsDirectory: join(root, "runs"),
      workflowIdFactory: () => "diagnosis",
    },
  );
  await driveWorkflow("diagnosis", deps);
  const recoveryBus = new FakeSubagentRpc();
  const recover = () =>
    resumeWorkflow("diagnosis", {
      ...deps,
      runDirectory,
      subagentExecutor: new SubagentsIntegration(recoveryBus, {
        cwd: root,
        artifactReader: artifactStore,
      }),
    });
  return { deps, bus, recoveryBus, recover, request: () => diagnosisRequest! };
}

test("Diagnosis running public receipt waits; exact completed output recovers and continues without a replacement child", async () => {
  const h = await setup();
  const waiting = await h.deps.stateStore.loadState();
  expect(waiting.planning.agentAttempts!.diagnosis.receipt?.runId).toBe(
    "diagnosis-run",
  );
  expect(h.deps.jevDecisionClient.calls.routeStage).toEqual([]);
  expect(renderWorkflowStatus(projectWorkflowStatus(waiting))).toContain(
    "run=diagnosis-run",
  );
  expect((await h.recover()).status).toBe("pending");
  expect((await h.deps.stateStore.loadState()).stateRevision).toBe(
    waiting.stateRevision,
  );
  h.bus.complete(
    h.request(),
    "diagnosis-run",
    "complete",
    JSON.stringify(diagnosisReport),
  );
  const resumed = await h.recover();
  expect(resumed.state.phase).toBe("clarifying");
  expect(resumed.state.planning.context.diagnosisRef).toBeDefined();
  expect(h.recoveryBus.emitted).toEqual([]);
  expect(
    h.deps.jevDecisionClient.calls.routeStage.map((input) => input.stage),
  ).toEqual(["research", "clarification"]);
});

test("Diagnosis intent without receipt cannot be relaunched by resume", async () => {
  const h = await setup(false);
  const state = await h.deps.stateStore.loadState();
  expect(state.planning.agentAttempts!.diagnosis.receipt).toBeUndefined();
  expect((await h.recover()).status).toBe("blocked");
  expect((await h.recover()).status).toBe("blocked");
  expect(h.recoveryBus.emitted).toEqual([]);
  expect(h.deps.jevDecisionClient.calls.routeStage).toEqual([]);
});
