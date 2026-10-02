import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { subagentRunId } from "../../../src/types.ts";
import { parseWorkerAttempt } from "../../../src/runtime/worker/attempt-evidence.ts";
import {
  phaseCWorkflow,
  type PhaseCWorkflow,
} from "../../fakes/phase-c-workflow.ts";

const workflows: PhaseCWorkflow[] = [];
async function fixingWorkflow() {
  const workflow = await phaseCWorkflow({
    validations: ["failed", "passed"],
    rounds: [{ action: "RETRY" }],
  });
  workflows.push(workflow);
  await workflow.createPlan();
  await workflow.settlePlan();
  await workflow.implement();
  await workflow.validate();
  await workflow.decide();
  expect((await workflow.load()).phase).toBe("fixing");
  return workflow;
}
afterEach(async () => {
  await Promise.all(workflows.splice(0).map((workflow) => workflow.cleanup()));
});

describe.each(["execute", "resume"] as const)(
  "completed Worker authority through %s",
  (entry) => {
    test("continues a valid completed attempt through the next validation retry Worker", async () => {
      const workflow = await fixingWorkflow();
      const result =
        entry === "execute"
          ? await workflow.implement()
          : await workflow.resume();
      expect(result.state.phase).toBe(
        entry === "execute" ? "validating" : "awaiting-code-review",
      );
      expect(result.state.coding.implementationRevision).toBe(2);
      expect(
        workflow.children.filter((child) => child.agent === "worker"),
      ).toHaveLength(2);
      await workflow.resume();
      expect(
        workflow.children.filter((child) => child.agent === "worker"),
      ).toHaveLength(2);
    });

    test.each([
      ["owner", "authority-inconsistent"],
      ["workflow", "authority-inconsistent"],
      ["input-revision", "authoritative-artifact-corrupt"],
      ["target-revision", "authority-inconsistent"],
      ["implementation-ref", "authority-inconsistent"],
      ["plan", "authoritative-artifact-corrupt"],
      ["plan-version", "authoritative-artifact-corrupt"],
      ["routing", "authoritative-artifact-corrupt"],
      ["run", "authoritative-artifact-corrupt"],
      ["request", "authoritative-artifact-corrupt"],
      ["node", "authoritative-artifact-corrupt"],
      ["profile", "authoritative-artifact-corrupt"],
      ["completion", "authority-inconsistent"],
      ["launch", "authority-inconsistent"],
      ["repository-root", "authoritative-artifact-corrupt"],
      ["baseline", "authoritative-artifact-corrupt"],
      ["input-implementation", "authoritative-artifact-corrupt"],
      ["implementation-hash", "authoritative-artifact-corrupt"],
      ["predecessor-hash", "authoritative-artifact-corrupt"],
    ] as const)(
      "rejects %s mismatch before any further dispatch",
      async (damage, reason) => {
        const workflow = await fixingWorkflow();
        const state = await workflow.load();
        const attempt = parseWorkerAttempt(
          JSON.parse(
            await workflow.artifactStore.readText(
              state.coding.workerAttemptRef!,
            ),
          ),
        );
        switch (damage) {
          case "owner":
            attempt.dispatch.ownerRunId = "another-workflow";
            break;
          case "workflow":
            attempt.workflowId = "another-workflow";
            break;
          case "input-revision":
            attempt.inputRevision += 1;
            break;
          case "target-revision":
            attempt.inputRevision += 1;
            attempt.targetRevision += 1;
            break;
          case "implementation-ref":
            attempt.implementationRef = {
              ...attempt.implementationRef!,
              sha256: "a".repeat(64),
            };
            break;
          case "plan":
            attempt.approvedPlanRef = {
              ...attempt.approvedPlanRef,
              sha256: "a".repeat(64),
            };
            break;
          case "plan-version":
            attempt.planVersion += 1;
            break;
          case "routing":
            attempt.executionRoutingRef = {
              ...attempt.executionRoutingRef,
              sha256: "a".repeat(64),
            };
            break;
          case "run":
            attempt.runId = subagentRunId("different-run");
            break;
          case "request":
            attempt.dispatch.requestId = "different-request";
            break;
          case "node":
            attempt.dispatch.nodeId = "different-node";
            break;
          case "profile":
            attempt.executionProfile.model = "different-model";
            break;
          case "completion":
            attempt.status = "ambiguous";
            break;
          case "launch":
            attempt.launchStatus = "unknown";
            break;
          case "repository-root":
            if (attempt.after?.status !== "observed")
              throw Error("Missing observation");
            attempt.after.snapshot.root = "/another-repository";
            break;
          case "baseline":
            attempt.before.worktreeDigest = "a".repeat(64);
            break;
          case "input-implementation":
            attempt.inputImplementationRef = state.coding.implementationRef;
            break;
          case "implementation-hash":
          case "predecessor-hash":
            await writeFile(
              join(
                workflow.artifactStore.rootDirectory,
                (damage === "implementation-hash"
                  ? attempt.implementationRef!
                  : attempt.previousRef!
                ).path,
              ),
              "corrupted",
            );
            break;
        }
        const ref = await workflow.artifactStore.writeText(
          "implementation",
          "damaged-completed-attempt.md",
          JSON.stringify(attempt),
        );
        await workflow.stateStore.saveState(
          { ...state, coding: { ...state.coding, workerAttemptRef: ref } },
          state.stateRevision,
        );
        const jevCalls = workflow.jevRequests.length;

        if (entry === "execute")
          await expect(workflow.implement()).rejects.toThrow();
        else expect((await workflow.resume()).status).toBe("failed");

        const rejected = await workflow.load();
        expect(rejected.phase).toBe("failed");
        expect(rejected.failure?.reason).toBe(reason);
        expect(rejected.coding.implementationRevision).toBe(1);
        expect(rejected.coding.workerAttemptRef).toEqual(ref);
        expect(
          workflow.children.filter((child) => child.agent === "worker"),
        ).toHaveLength(1);
        expect(workflow.jevRequests).toHaveLength(jevCalls);
      },
    );
  },
);
