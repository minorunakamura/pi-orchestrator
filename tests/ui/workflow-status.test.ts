import { describe, expect, test } from "vitest";
import type { ArtifactRef } from "../../src/core/artifacts/references.ts";
import type { WorkflowState } from "../../src/core/workflow/state.ts";
import {
  projectWorkflowStatus,
  renderWorkflowStatus,
} from "../../src/ui/workflow-status.ts";
import type { WorkflowId } from "../../src/types.ts";

function ref<K extends ArtifactRef["kind"]>(
  kind: K,
  path: string,
): ArtifactRef<K> {
  return {
    kind,
    path,
    schemaVersion: 1,
    sha256: "a".repeat(64),
  } as ArtifactRef<K>;
}

function state(phase: WorkflowState["phase"]): WorkflowState {
  const plan = ref("plan", "plans/plan-v2.md");
  const implementation = ref(
    "implementation",
    "implementation/implementation-3.json",
  );
  return {
    schemaVersion: 1,
    workflowId: "workflow-1" as WorkflowId,
    stateRevision: 7,
    playbook: "feature",
    phase,
    taskRef: ref("task", "context/task.md"),
    planning: {
      context: {},
      currentPlanRef: plan,
      currentPlanVersion: 2,
      approvedPlanRef: plan,
      approvedPlanVersion: 2,
      latestPlanReviewRef: ref("plan-review", "plan-reviews/plan-2.json"),
      ...(phase === "awaiting-plan-review"
        ? {
            planReview: {
              reviewId: "plan-review-2" as never,
              planRef: plan,
              planVersion: 2,
            },
          }
        : {}),
    },
    coding: {
      workerAttemptRef: ref(
        "implementation",
        "implementation/attempt-3-intent.json",
      ),
      implementationRevision: 3,
      reviewRound: 2,
      implementationRef: implementation,
      validationRef: ref("validation", "validation/validation-3.json"),
      correctnessReviewRef: ref(
        "correctness-review",
        "reviews/correctness-2.json",
      ),
      ponytailReviewRef: ref("ponytail-review", "reviews/ponytail-2.json"),
      findingEvaluationRef: ref(
        "finding-evaluation",
        "reviews/finding-evaluation-2.json",
      ),
      acceptedFindingsRef: ref(
        "accepted-findings",
        "reviews/accepted-findings-2.json",
      ),
      roundDecisionRef: ref("round-decision", "reviews/round-decision-2.json"),
      latestCodeReviewRef: ref("code-review", "code-reviews/code-3.json"),
      ...(phase === "awaiting-code-review"
        ? {
            codeReview: {
              reviewId: "code-review-3" as never,
              implementationRef: implementation,
              implementationRevision: 3,
            },
          }
        : {}),
    },
    counters: {
      automatedFixRoundsUsed: 2,
      strongerRetriesUsed: 1,
      humanCodeFeedbackRounds: 1,
    },
    external: {
      workerRunId: "worker-run-3",
      requestId: "request-3",
      apiToken: "super-secret-token",
    },
    ...(phase === "blocked"
      ? {
          block: {
            blockedFrom: "implementing",
            reason: "agent-execution-ambiguous" as const,
            evidenceRef: ref(
              "reconciliation",
              "reconciliation/reconciliation-1.json",
            ),
          },
        }
      : {}),
    ...(phase === "failed"
      ? {
          failure: {
            reason: "authoritative-artifact-corrupt" as const,
            evidenceRef: ref(
              "reconciliation",
              "reconciliation/reconciliation-2.json",
            ),
          },
        }
      : {}),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("workflow status projection", () => {
  test("projects the authoritative progress fields without mutating State", () => {
    const source = state("awaiting-plan-review");
    const before = structuredClone(source);

    const projection = projectWorkflowStatus(source);
    const rendered = renderWorkflowStatus(projection);

    expect(projection.workflowId).toBe("workflow-1");
    expect(projection.phase).toBe("awaiting-plan-review");
    expect(projection.currentPlanVersion).toBe(2);
    expect(projection.approvedPlanVersion).toBe(2);
    expect(projection.implementationRevision).toBe(3);
    expect(projection.reviewRound).toBe(2);
    expect(projection.retryCounters).toEqual({
      automatedFixRoundsUsed: 2,
      strongerRetriesUsed: 1,
      humanCodeFeedbackRounds: 1,
    });
    expect(projection.humanGate.status).toBe("pending");
    expect(projection.worker.attemptRef?.path).toContain("attempt-3");
    expect(projection.externalIdentities).toEqual({
      workerRunId: "worker-run-3",
      requestId: "request-3",
    });
    expect(rendered).toContain("workflow-1");
    expect(rendered).toContain("awaiting-plan-review");
    expect(rendered).toContain("worker-run-3");
    expect(rendered).not.toContain("super-secret-token");
    expect(source).toEqual(before);
  });

  test("keeps a blocked Human Gate visible through blockedFrom", () => {
    const source = state("blocked");
    source.block!.blockedFrom = "awaiting-code-review";
    source.coding.codeReview = {
      reviewId: "code-review-3" as never,
      implementationRef: source.coding.implementationRef!,
      implementationRevision: 3,
    };
    source.external["plannotator.code-review.r3"] = "code-review-3";

    const projection = projectWorkflowStatus(source);

    expect(projection.status).toBe("blocked");
    expect(projection.humanGate).toMatchObject({
      kind: "code",
      status: "pending",
      reviewId: "code-review-3",
    });
  });

  test("projects Worker and reconciliation identities without exposing secret-like values", () => {
    const projection = projectWorkflowStatus(state("implementing"), {
      worker: {
        requestId: "request-3",
        ownerRunId: "workflow-1",
        nodeId: "worker-node-3",
        runId: "secret-token",
        launchStatus: "observed",
      },
      reconciliationRef: ref(
        "reconciliation",
        "reconciliation/reconciliation-3.json",
      ),
    });

    expect(projection.worker.identity).toEqual({
      requestId: "request-3",
      ownerRunId: "workflow-1",
      nodeId: "worker-node-3",
      launchStatus: "observed",
    });
    expect(projection.reconciliationRef?.path).toContain("reconciliation-3");
    const rendered = renderWorkflowStatus(projection);
    expect(rendered).toContain("worker-node-3");
    expect(rendered).toContain("reconciliation-3");
    expect(rendered).not.toContain("secret-token");
  });

  test.each([
    ["blocked", "blocked", "agent-execution-ambiguous"],
    ["failed", "failed", "authoritative-artifact-corrupt"],
    ["completed", "completed", undefined],
  ] as const)("projects %s lifecycle state", (phase, status, reason) => {
    const projection = projectWorkflowStatus(state(phase));
    const rendered = renderWorkflowStatus(projection);
    expect(projection.status).toBe(status);
    expect(projection.blocked?.reason ?? projection.failed?.reason).toBe(
      reason,
    );
    if (reason) {
      expect(rendered).toContain(`${status} reason: ${reason}`);
      expect(rendered).toContain("reconciliation/reconciliation-");
    }
  });
});
