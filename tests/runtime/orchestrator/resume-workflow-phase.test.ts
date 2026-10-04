import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseWorkerAttempt } from "../../../src/runtime/worker/attempt-evidence.ts";
import { FakeSubagentExecutor } from "../../fakes/index.ts";
import {
  phaseCWorkflow,
  type PhaseCWorkflow,
} from "../../fakes/phase-c-workflow.ts";

const workflows: PhaseCWorkflow[] = [];
async function setup(script = {}) {
  const workflow = await phaseCWorkflow(script);
  workflows.push(workflow);
  return workflow;
}
afterEach(async () => {
  await Promise.all(workflows.splice(0).map((workflow) => workflow.cleanup()));
});

async function approvePlan(workflow: PhaseCWorkflow) {
  const created = await workflow.createPlan();
  const approved = await workflow.settlePlan();
  expect(created.state.phase).toBe("awaiting-plan-review");
  expect(approved.state.phase).toBe("implementing");
}

async function reachReview(workflow: PhaseCWorkflow) {
  await approvePlan(workflow);
  await workflow.implement();
  await workflow.validate();
  await workflow.review();
}

describe("ORCH-018 phase-specific reconciliation", () => {
  test("resumes matching approval against a valid Plan Artifact", async () => {
    const workflow = await setup();
    const created = await workflow.createPlan();
    const resumed = await workflow.resume();
    expect(resumed.status).toBe("advanced");
    expect(resumed.state.phase).toBe("completed");
    expect(resumed.state.planning.approvedPlanRef).toEqual(created.planRef);
    expect(
      workflow.children.filter((child) => child.agent === "worker"),
    ).toHaveLength(1);
  });

  test.each(["corrupt", "missing"] as const)(
    "rejects %s Plan authority on resume despite matching approval",
    async (damage) => {
      const workflow = await setup();
      const created = await workflow.createPlan();
      const path = join(
        workflow.artifactStore.rootDirectory,
        created.planRef.path,
      );
      if (damage === "missing") await rm(path);
      else await writeFile(path, "corrupted plan");

      const resumed = await workflow.resume();

      expect(["blocked", "failed"]).toContain(resumed.status);
      expect(resumed.state.planning.approvedPlanRef).toBeUndefined();
      expect(resumed.state.planning.latestPlanReviewRef).toBeUndefined();
      expect(
        workflow.children.filter((child) => child.agent === "worker"),
      ).toHaveLength(0);
    },
  );

  test.each(["corrupt", "missing"] as const)(
    "rejects %s implementation authority on resume despite matching approval",
    async (damage) => {
      const workflow = await setup();
      await reachReview(workflow);
      await workflow.evaluate();
      const opened = await workflow.decide();
      const path = join(
        workflow.artifactStore.rootDirectory,
        opened.state.coding.implementationRef!.path,
      );
      if (damage === "missing") await rm(path);
      else await writeFile(path, "corrupted implementation");

      const resumed = await workflow.resume();

      expect(["blocked", "failed"]).toContain(resumed.status);
      expect(resumed.state.phase).not.toBe("completed");
      expect(resumed.state.coding.latestCodeReviewRef).toBeUndefined();
    },
  );

  test("opens the normal first Code Gate entry exactly once, then approves it", async () => {
    const workflow = await setup();
    await reachReview(workflow);
    await workflow.evaluate();
    const round = await workflow.decide();
    expect(round.state.phase).toBe("awaiting-code-review");

    const opened = await workflow.resume();

    expect(opened.status).toBe("advanced");
    expect(opened.state.phase).toBe("completed");
    expect(
      workflow.gates.filter((gate) => gate.action === "code-review"),
    ).toHaveLength(1);

    const approved = await workflow.resume();
    expect(approved.status).toBe("advanced");
    expect(approved.state.phase).toBe("completed");

    const duplicate = await workflow.resume();
    expect(duplicate.state.phase).toBe("completed");
    expect(
      workflow.gates.filter((gate) => gate.action === "code-review"),
    ).toHaveLength(1);
  });

  test("reconciles a persisted Code Gate identity without opening a second review", async () => {
    const workflow = await setup();
    await reachReview(workflow);
    await workflow.evaluate();
    const round = await workflow.decide();
    expect(round.state.phase).toBe("awaiting-code-review");
    const opened = await workflow.openCode();
    expect(opened.status).toBe("approved");
    const before = workflow.gates.filter(
      (gate) => gate.action === "code-review",
    ).length;

    const resumed = await workflow.resume();

    expect(resumed.status).toBe("advanced");
    expect(resumed.state.phase).toBe("completed");
    expect(
      workflow.gates.filter((gate) => gate.action === "code-review"),
    ).toHaveLength(before);
  });

  test("does not rerun deterministic validation when the exact result is durable", async () => {
    const workflow = await setup();
    await approvePlan(workflow);
    await workflow.implement();
    const validation = await workflow.validate();
    const state = await workflow.load();
    const interrupted = {
      ...state,
      phase: "validating" as const,
      coding: { ...state.coding, reviewRound: 0 },
    };
    await workflow.stateStore.saveState(interrupted, state.stateRevision);
    const calls = workflow.validations.length;

    const resumed = await workflow.resume();

    expect(resumed.status).toBe("advanced");
    expect(resumed.state.phase).toBe("completed");
    expect(resumed.state.coding.validationRef).toEqual(
      validation.validationRef,
    );
    expect(workflow.validations).toHaveLength(calls);
  });

  test("reuses complete automated review artifacts and does not fan out reviewers again", async () => {
    const workflow = await setup();
    await reachReview(workflow);
    const reviewerRuns = workflow.children.filter(
      (child) =>
        child.agent === "reviewer" || child.agent === "ponytail-reviewer",
    ).length;

    const resumed = await workflow.resume();

    expect(resumed.status).toBe("advanced");
    expect(resumed.state.phase).toBe("completed");
    expect(
      workflow.children.filter(
        (child) =>
          child.agent === "reviewer" || child.agent === "ponytail-reviewer",
      ),
    ).toHaveLength(reviewerRuns);
    expect(resumed.state.coding.findingEvaluationRef).toBeDefined();
  });

  test("reuses accepted-findings and a fresh round decision without another Jev call", async () => {
    const workflow = await setup();
    await reachReview(workflow);
    await workflow.evaluate();
    const round = await workflow.decide();
    const calls = workflow.roundCalls();
    const interrupted = { ...round.state, phase: "reviewing" as const };
    await workflow.stateStore.saveState(interrupted, round.state.stateRevision);

    const resumed = await workflow.resume();

    expect(resumed.status).toBe("advanced");
    expect(resumed.state.phase).toBe("completed");
    expect(workflow.roundCalls()).toBe(calls);
  });

  test("restores orphan finding-evaluation refs and continues to Round Decision in one resume", async () => {
    const workflow = await setup();
    await reachReview(workflow);
    await workflow.evaluate();
    const state = await workflow.load();
    const withoutRefs = {
      ...state,
      coding: { ...state.coding },
    };
    delete withoutRefs.coding.findingEvaluationRef;
    delete withoutRefs.coding.acceptedFindingsRef;
    await workflow.stateStore.saveState(withoutRefs, state.stateRevision);
    const roundCalls = workflow.jevRequests.filter(
      (request) => "decision" in request.questions,
    ).length;

    const resumed = await workflow.resume();

    expect(resumed.status).toBe("advanced");
    expect(resumed.state.phase).toBe("completed");
    expect(resumed.state.coding.findingEvaluationRef).toBeDefined();
    expect(resumed.state.coding.acceptedFindingsRef).toBeDefined();
    expect(
      workflow.jevRequests.filter((request) => "decision" in request.questions),
    ).toHaveLength(roundCalls + 1);
  });

  test("re-evaluates stale routing during resume instead of reusing it", async () => {
    const workflow = await setup();
    await approvePlan(workflow);
    workflow.faults.intentState = true;
    await expect(workflow.implement()).rejects.toThrow();
    const before = workflow.jevRequests.filter(
      (request) => "modelTier" in request.questions,
    ).length;

    const resumed = await workflow.resume({ changeScope: "changed scope" });

    expect(resumed.status).toBe("advanced");
    expect(resumed.state.phase).toBe("completed");
    expect(
      workflow.jevRequests.filter(
        (request) => "modelTier" in request.questions,
      ),
    ).toHaveLength(before + 1);
    expect(
      workflow.children.filter((child) => child.agent === "worker"),
    ).toHaveLength(1);
  });

  test("resumes fixing after a completed Worker and validation retry without duplicating work", async () => {
    const workflow = await setup({
      validations: ["failed", "passed"],
      rounds: [{ action: "RETRY" }],
    });
    await approvePlan(workflow);
    await workflow.implement();
    await workflow.validate();
    const retry = await workflow.decide();
    expect(retry.state.phase).toBe("fixing");
    expect(retry.state.coding.implementationRevision).toBe(1);
    const completedAttemptRef = retry.state.coding.workerAttemptRef;

    const resumed = await workflow.resume();

    expect(resumed.status).toBe("advanced");
    expect(resumed.state.phase).toBe("completed");
    expect(resumed.state.coding.implementationRevision).toBe(2);
    expect(resumed.state.coding.workerAttemptRef).not.toEqual(
      completedAttemptRef,
    );
    expect(
      workflow.children.filter((child) => child.agent === "worker"),
    ).toHaveLength(2);
    await workflow.resume();
    expect(
      workflow.children.filter((child) => child.agent === "worker"),
    ).toHaveLength(2);
  });

  test.each([
    "attempt-hash",
    "workflow",
    "implementation-ref",
    "implementation-hash",
  ] as const)(
    "does not bypass inconsistent completed Worker evidence: %s",
    async (damage) => {
      const workflow = await setup({
        validations: ["failed"],
        rounds: [{ action: "RETRY" }],
      });
      await approvePlan(workflow);
      await workflow.implement();
      await workflow.validate();
      const { state } = await workflow.decide();
      const store = workflow.artifactStore;
      const ref = state.coding.workerAttemptRef!;
      if (damage === "attempt-hash")
        await writeFile(join(store.rootDirectory, ref.path), "corrupt");
      else if (damage === "implementation-hash")
        await writeFile(
          join(store.rootDirectory, state.coding.implementationRef!.path),
          "corrupt",
        );
      else {
        const attempt = parseWorkerAttempt(
          JSON.parse(await store.readText(ref)),
        );
        if (damage === "workflow") attempt.workflowId = "another-workflow";
        else
          attempt.implementationRef = {
            ...attempt.implementationRef!,
            sha256: "a".repeat(64),
          };
        const damagedRef = await store.writeJson(
          "implementation",
          "damaged-attempt.json",
          attempt,
          parseWorkerAttempt,
        );
        await workflow.stateStore.saveState(
          {
            ...state,
            coding: { ...state.coding, workerAttemptRef: damagedRef },
          },
          state.stateRevision,
        );
      }

      const resumed = await workflow.resume();

      expect(resumed.status).toBe("failed");
      expect(resumed.state.coding.implementationRevision).toBe(1);
      expect(
        workflow.children.filter((child) => child.agent === "worker"),
      ).toHaveLength(1);
    },
  );

  test.each(["running", "unknown", "ambiguous"] as const)(
    "keeps an unresolved %s Worker blocked and never dispatches a duplicate",
    async (status) => {
      const workflow = await setup({ workers: ["ambiguous"] });
      await approvePlan(workflow);
      await expect(workflow.implement()).rejects.toThrow();
      const before = workflow.children.filter(
        (child) => child.agent === "worker",
      ).length;

      const state = await workflow.load();
      const attempt = parseWorkerAttempt(
        JSON.parse(
          await workflow.artifactStore.readText(state.coding.workerAttemptRef!),
        ),
      );
      expect(attempt.runId).toBeDefined();
      const executor = new FakeSubagentExecutor({
        status: { type: "result", value: { runId: attempt.runId!, status } },
      });
      const resumed = await workflow.resume({ subagentExecutor: executor });

      expect(resumed.status).toBe("blocked");
      expect(resumed.state.phase).toBe("blocked");
      expect(resumed.state.coding.workerAttemptRef).toEqual(
        state.coding.workerAttemptRef,
      );
      expect(executor.calls.status).toEqual([attempt.runId]);
      expect(executor.calls.run).toHaveLength(0);
      expect(
        workflow.children.filter((child) => child.agent === "worker"),
      ).toHaveLength(before);
    },
  );

  test("continues a blocked Jev workflow only after BLOCK_RESOLVED", async () => {
    const workflow = await setup({ jevFailures: 1 });
    await approvePlan(workflow);
    await expect(workflow.implement()).rejects.toThrow();
    expect((await workflow.load()).phase).toBe("blocked");

    const resumed = await workflow.resume();

    expect(resumed.status).toBe("advanced");
    expect(resumed.state.phase).toBe("completed");
    expect(resumed.state.block).toBeUndefined();
    expect(
      workflow.children.filter((child) => child.agent === "worker"),
    ).toHaveLength(1);
  });

  test("possible orphan Code Gate is blocked without reopening", async () => {
    const workflow = await setup();
    await reachReview(workflow);
    await workflow.evaluate();
    const round = await workflow.decide();
    workflow.faults.codeIdentityState = true;
    // Local attempt State fails before the external request; the orphan remains a barrier.
    await expect(workflow.openCode()).rejects.toThrow();
    const before = workflow.gates.filter(
      (gate) => gate.action === "code-review",
    ).length;
    const resumed = await workflow.resume();

    expect(resumed.status).toBe("blocked");
    expect(resumed.state.phase).toBe("blocked");
    expect(
      workflow.gates.filter((gate) => gate.action === "code-review"),
    ).toHaveLength(before);
    const blockedRevision = resumed.state.stateRevision;
    const duplicate = await workflow.resume();
    expect(duplicate.status).toBe("blocked");
    expect(duplicate.state.stateRevision).toBe(blockedRevision);
    expect(
      workflow.gates.filter((gate) => gate.action === "code-review"),
    ).toHaveLength(before);
    expect(round.state.phase).toBe("awaiting-code-review");
  });
});
