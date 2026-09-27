import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createArtifactRef,
  ArtifactStore,
} from "../../../src/runtime/persistence/artifact-store.ts";
import { StateStore } from "../../../src/runtime/persistence/state-store.ts";
import type {
  ValidationContract,
  ValidationExecutionResult,
} from "../../../src/core/decisions/types.ts";
import type { WorkflowState } from "../../../src/core/workflow/state.ts";
import { advanceWorkflow } from "../../../src/runtime/orchestrator/advance-workflow.ts";
import { ValidationRunner } from "../../../src/runtime/orchestrator/validation-runner.ts";
import { parseValidationResult } from "../../../src/core/decisions/types.ts";
import { FakeValidationExecutor } from "../../fakes/index.ts";

type TestWorkflowId = WorkflowState["workflowId"];

const roots: string[] = [];
const contract: ValidationContract = {
  schemaVersion: 1,
  checks: [
    {
      id: "tests",
      type: "command",
      command: "pnpm test",
      cwd: ".",
      required: true,
    },
  ],
};

function ref<K extends Parameters<typeof createArtifactRef>[0]>(
  kind: K,
  path: string,
  content: string,
) {
  return createArtifactRef(kind, path, content);
}

function validatingState(implementationRevision: number): WorkflowState {
  const planRef = ref("plan", "plans/plan-v1.md", "plan");
  return {
    schemaVersion: 1,
    workflowId: "workflow-1" as TestWorkflowId,
    stateRevision: 0,
    playbook: "feature",
    phase: "validating",
    taskRef: ref("task", "context/task.md", "task"),
    planning: {
      context: {},
      currentPlanRef: planRef,
      currentPlanVersion: 1,
      approvedPlanRef: planRef,
      approvedPlanVersion: 1,
    },
    coding: {
      implementationRevision,
      reviewRound: 0,
      executionRoutingRef: ref(
        "execution-routing",
        "decisions/execution-routing-1.json",
        "routing",
      ),
      implementationRef: ref(
        "implementation",
        "implementation/implementation-1.json",
        "implementation",
      ),
    },
    counters: {
      automatedFixRoundsUsed: 0,
      strongerRetriesUsed: 0,
      humanCodeFeedbackRounds: 0,
    },
    external: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(
    join("/tmp", "pi-orchestrator-validation-runner-"),
  );
  roots.push(root);
  return root;
}

async function makeRunner(
  state: WorkflowState,
  execution: ValidationExecutionResult,
  stopOnInfrastructureFailure = true,
) {
  const root = await makeRoot();
  const artifactStore = new ArtifactStore(root);
  const stateStore = new StateStore(root);
  const planRef = await artifactStore.writeText(
    "plan",
    "plan-v1.md",
    `# Plan\n\n\`\`\`orchestrator-validation\n${JSON.stringify(contract)}\n\`\`\``,
  );
  state.planning.currentPlanRef = planRef;
  state.planning.approvedPlanRef = planRef;
  const persistedState = await stateStore.saveState(state, 0);
  const executor = new FakeValidationExecutor({
    execute: { type: "result", value: execution },
  });
  return {
    root,
    artifactStore,
    stateStore,
    state: persistedState,
    executor,
    runner: new ValidationRunner({
      artifactStore,
      stateStore,
      validationExecutor: executor,
      configuration: { validation: { stopOnInfrastructureFailure } },
    }),
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ValidationRunner ORCH-013", () => {
  test("thrown executor failure persists infrastructure evidence before blocking", async () => {
    const f = await makeRunner(validatingState(1), {
      status: "passed",
      checks: [{ id: "tests", status: "passed", exitCode: 0 }],
    });
    f.executor.execute = async () => {
      throw Error("spawn unavailable");
    };
    const result = await f.runner.execute({ state: f.state });
    expect(result.validation.status).toBe("infrastructure-error");
    expect(result.state.block).toMatchObject({
      reason: "validation-infrastructure-error",
      evidenceRef: result.validationRef,
    });
    expect(
      await f.artifactStore.readJson(
        result.validationRef,
        parseValidationResult,
      ),
    ).toMatchObject({ status: "infrastructure-error" });
  });
  test("rejects caller substitution of Approved Plan checks before execution", async () => {
    const fixture = await makeRunner(validatingState(1), {
      status: "passed",
      checks: [{ id: "tests", status: "passed", exitCode: 0 }],
    });
    await expect(
      fixture.runner.execute({
        state: fixture.state,
        contract: {
          ...contract,
          checks: [{ ...contract.checks[0], command: "true" }],
        },
      }),
    ).rejects.toThrow(/contract/iu);
    expect(fixture.executor.calls).toHaveLength(0);
  });
  test("binds the current implementation revision and persists a passed result before VALIDATION_PASSED", async () => {
    const execution: ValidationExecutionResult = {
      status: "passed",
      checks: [{ id: "tests", status: "passed", exitCode: 0 }],
    };
    const fixture = await makeRunner(validatingState(7), execution);

    const result = await fixture.runner.execute({
      state: fixture.state,
      contract,
    });

    expect(result.validation).toMatchObject({
      schemaVersion: 1,
      implementationRevision: 7,
      status: "passed",
      checks: [{ id: "tests", status: "passed", exitCode: 0 }],
    });
    expect(result.validationRef.path).toBe("validation/validation-7.json");
    expect(
      await fixture.artifactStore.readJson(
        result.validationRef,
        parseValidationResult,
      ),
    ).toEqual(result.validation);
    expect(result.state.phase).toBe("reviewing");
    expect(result.state.coding.validationRef).toEqual(result.validationRef);
    expect(fixture.executor.calls).toEqual([contract]);
  });

  test("keeps a failed validation in validating until a Round Decision event routes it", async () => {
    const execution: ValidationExecutionResult = {
      status: "failed",
      checks: [{ id: "tests", status: "failed", exitCode: 1 }],
    };
    const fixture = await makeRunner(validatingState(3), execution);

    const result = await fixture.runner.execute({
      state: fixture.state,
      contract,
    });

    expect(result.validation).toMatchObject({
      implementationRevision: 3,
      status: "failed",
    });
    expect(result.state.phase).toBe("validating");
    expect(result.state.coding.validationRef).toBeUndefined();
    expect((await fixture.stateStore.loadState()).phase).toBe("validating");

    const decisionRef = ref(
      "round-decision",
      "reviews/round-decision-1.json",
      "decision",
    );
    const next = await advanceWorkflow(
      result.state,
      {
        type: "RETRY_REQUIRED",
        decisionRef,
        validationRef: result.validationRef,
      },
      fixture.stateStore,
    );
    expect(next.phase).toBe("fixing");
    expect(next.coding.validationRef).toEqual(result.validationRef);
  });

  test.each([true, false])(
    "applies infrastructure stop policy %s with durable evidence",
    async (stop) => {
      const execution: ValidationExecutionResult = {
        status: "infrastructure-error",
        checks: [
          {
            id: "tests",
            status: "infrastructure-error",
            evidence: "timed out after 20ms",
          },
        ],
      };
      const fixture = await makeRunner(validatingState(11), execution, stop);

      const result = await fixture.runner.execute({
        state: fixture.state,
        contract,
      });

      expect(result.validation.status).toBe("infrastructure-error");
      expect(result.validation.implementationRevision).toBe(11);
      expect(result.state.phase).toBe(stop ? "blocked" : "validating");
      if (stop)
        expect(result.state.block).toMatchObject({
          reason: "validation-infrastructure-error",
          evidenceRef: result.validationRef,
        });
      expect(
        await fixture.artifactStore.readJson(
          result.validationRef,
          parseValidationResult,
        ),
      ).toMatchObject({
        implementationRevision: 11,
        status: "infrastructure-error",
      });
    },
  );
});
