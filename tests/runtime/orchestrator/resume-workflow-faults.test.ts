import { afterEach, describe, expect, test } from "vitest";
import {
  phaseCWorkflow,
  type PhaseCWorkflow,
} from "../../fakes/phase-c-workflow.ts";
import type { WorkflowArtifactWriter } from "../../../src/runtime/orchestrator/planning-orchestrator.ts";
import { resumeWorkflow } from "../../../src/runtime/orchestrator/resume-workflow.ts";
import { RuntimePortError } from "../../../src/runtime/ports/errors.ts";

const workflows: PhaseCWorkflow[] = [];
async function setup() {
  const workflow = await phaseCWorkflow();
  workflows.push(workflow);
  return workflow;
}
afterEach(async () => {
  await Promise.all(workflows.splice(0).map((workflow) => workflow.cleanup()));
});

async function approvedPlan(workflow: PhaseCWorkflow) {
  await workflow.createPlan();
  return workflow.settlePlan();
}

describe("ORCH-018 reconciliation fault boundaries", () => {
  test("State save failure after a reconciled Plan approval cannot publish approval", async () => {
    const workflow = await setup();
    await workflow.createPlan();
    const failingStateStore = {
      saveState: async (
        state: Parameters<typeof workflow.stateStore.saveState>[0],
        revision?: number,
      ) => {
        if (state.phase === "implementing")
          throw Error("reconciliation State failure");
        return workflow.stateStore.saveState(state, revision);
      },
    };

    const result = await workflow.resume({ stateStore: failingStateStore });

    expect(result.status).toBe("blocked");
    expect(result.state.phase).toBe("blocked");
    expect(result.state.block?.reason).toBe("operator-attention-required");
    expect((await workflow.load()).phase).toBe("blocked");
    expect((await workflow.load()).planning.approvedPlanRef).toBeUndefined();
  });

  test("rejects unsafe or mismatched resume workflow identity before reconciliation", async () => {
    const workflow = await setup();
    await expect(
      resumeWorkflow("../victim", {
        runDirectory: workflow.root,
        artifactStore: workflow.artifactStore,
        stateStore: workflow.stateStore,
        subagentExecutor: workflow.subagentExecutor,
      }),
    ).rejects.toThrow(/safe|path/iu);
    await expect(
      resumeWorkflow("different", {
        runDirectory: workflow.artifactStore.rootDirectory,
        artifactStore: workflow.artifactStore,
        stateStore: workflow.stateStore,
        subagentExecutor: workflow.subagentExecutor,
      }),
    ).rejects.toThrow(/identity/iu);
  });

  test("resume returns the State persisted by a failing review in the same locked invocation", async () => {
    const workflow = await phaseCWorkflow({ silentReviewer: true });
    workflows.push(workflow);
    await approvedPlan(workflow);
    await workflow.implement();
    await workflow.validate();

    const result = await workflow.resume({
      stateStore: workflow.stateStore,
      artifactStore: workflow.artifactStore,
    });

    expect(result.status).toBe("blocked");
    expect(result.state.phase).toBe("blocked");
    expect(result.state.block?.reason).toBe("agent-execution-ambiguous");
    expect((await workflow.load()).phase).toBe("blocked");
  });

  test("durable reconciliation diagnostics never persist external secrets", async () => {
    const workflow = await phaseCWorkflow();
    workflows.push(workflow);
    await approvedPlan(workflow);
    await workflow.implement();
    await workflow.validate();
    await workflow.review();
    await workflow.evaluate();
    await workflow.decide();
    const secret = "Bearer super-secret-token";
    const failingGate = {
      openPlanReview: async () => {
        throw new Error("unused");
      },
      getPlanReview: async () => {
        throw new Error("unused");
      },
      openCodeReview: async () => {
        throw new RuntimePortError("reconciliation", secret);
      },
    };

    const result = await workflow.resume({ plannotatorGate: failingGate });

    expect(result.status).toBe("failed");
    const evidenceRef = result.state.failure?.evidenceRef;
    if (!evidenceRef) throw Error("Missing reconciliation evidence");
    const evidence = await workflow.artifactStore.readText(evidenceRef);
    expect(evidence).not.toContain(secret);
  });

  test("Artifact persistence failure before BLOCK_RESOLVED leaves the durable block unchanged", async () => {
    const workflow = await phaseCWorkflow({ jevFailures: 1 });
    workflows.push(workflow);
    await approvedPlan(workflow);
    await expect(workflow.implement()).rejects.toThrow();
    const before = await workflow.load();
    const failingArtifacts: WorkflowArtifactWriter = {
      rootDirectory: workflow.artifactStore.rootDirectory,
      readText: workflow.artifactStore.readText?.bind(workflow.artifactStore),
      writeText: async (kind, fileName, content) => {
        if (kind === "reconciliation")
          throw Error("reconciliation Artifact failure");
        return workflow.artifactStore.writeText(kind, fileName, content);
      },
      writeJson: async (kind, fileName, value, schema) => {
        if (kind === "reconciliation")
          throw Error("reconciliation Artifact failure");
        if (workflow.artifactStore.writeJson)
          return workflow.artifactStore.writeJson(
            kind,
            fileName,
            value,
            schema,
          );
        return workflow.artifactStore.writeText(
          kind,
          fileName,
          JSON.stringify(value),
        );
      },
    };

    await expect(
      workflow.resume({ artifactStore: failingArtifacts }),
    ).rejects.toThrow("reconciliation Artifact failure");
    const after = await workflow.load();
    expect(after.phase).toBe("blocked");
    expect(after.stateRevision).toBe(before.stateRevision);
  });
});
