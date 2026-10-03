import { readFile, readdir, rm, writeFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { advanceWorkflow } from "../../../src/runtime/orchestrator/advance-workflow.ts";
import { PlanningOrchestrator } from "../../../src/runtime/orchestrator/planning-orchestrator.ts";
import { startWorkflow } from "../../fakes/planning.ts";
import { StateStore } from "../../../src/runtime/persistence/state-store.ts";
import {
  FakeClarificationPort,
  FakeSubagentExecutor,
} from "../../fakes/index.ts";
import type { PlaybookContext } from "../../../src/core/playbooks/policy.ts";
import { subagentRunId } from "../../../src/types.ts";

const roots: string[] = [];
const validPlan = `# Plan

## Scope / Requirements
Implement only the requested behavior.

## Architecture / Design
Preserve the existing parser boundary.

## Implementation Plan
Add regression tests and the smallest change.

## Validation Contract

\`\`\`orchestrator-validation
{"schemaVersion":1,"checks":[{"id":"tests","type":"command","command":"pnpm test","cwd":".","required":true}]}
\`\`\`
`;
const succeeded = (output: string) => ({
  status: "succeeded" as const,
  runId: subagentRunId("run-1"),
  output,
});
const providedPort = (answer: string) =>
  new FakeClarificationPort({
    request: { type: "result", value: { status: "provided", answer } },
  });
async function setup(
  context: PlaybookContext = {},
  outputs = ["facts", validPlan],
) {
  const root = await mkdtemp(join(tmpdir(), "pi-orchestrator-planning-"));
  roots.push(root);
  const executor = new FakeSubagentExecutor({
    run: outputs.map((output) => ({
      type: "result" as const,
      value: succeeded(output),
    })),
  });
  const started = await startWorkflow(
    { task: "Implement the planning change", playbook: "feature", context },
    {
      runsDirectory: root,
      subagentExecutor: executor,
      workflowIdFactory: () => "workflow-1",
    },
  );
  return { ...started, subagentExecutor: executor };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("PlanningOrchestrator clarification persistence", () => {
  test("durable request/source/evidence precedes Human interaction; confirmed answer precedes completion", async () => {
    const h = await setup({ requiresClarification: true });
    const stateStore = new StateStore(h.runDirectory);
    const port = providedPort("Preserve the existing parser boundary.");
    const result = await new PlanningOrchestrator({
      ...h,
      clarificationPort: {
        request: async (request) => {
          const persisted = await stateStore.loadState();
          expect(persisted.planning.clarificationRequestRef).toEqual(
            request.requestRef,
          );
          const content = await h.artifactStore.readText!(request.requestRef!);
          expect(content).toContain(request.prompt);
          expect(request.contextRefs).toEqual(
            expect.arrayContaining([
              h.taskRef,
              h.state.planning.context.scoutRef,
            ]),
          );
          expect(request.evidence?.every((item) => item.content)).toBe(true);
          expect(persisted.planning.approvedPlanRef).toBeUndefined();
          return port.request(request);
        },
      },
    }).requestClarification({ state: h.state });
    expect(result.status).toBe("provided");
    expect(result.state.phase).toBe("planning");
    expect(result.state.planning.context.clarificationRef).toEqual(
      result.state.planning.clarificationProgressRef,
    );
    expect(
      await h.artifactStore.readText!(
        result.state.planning.context.clarificationRef!,
      ),
    ).toContain("Preserve the existing parser boundary.");
    expect(result.state.coding.implementationRef).toBeUndefined();
  });
  test("request State-save failure prevents all Human calls; corrupt request cannot be republished", async () => {
    const h = await setup({ requiresClarification: true });
    const port = providedPort("Choice");
    await expect(
      new PlanningOrchestrator({
        ...h,
        clarificationPort: port,
        stateStore: {
          saveState: async () => {
            throw Error("State interrupted");
          },
        },
      }).requestClarification({ state: h.state }),
    ).rejects.toThrow("State interrupted");
    expect(port.calls).toHaveLength(0);
    const name = (await readdir(join(h.runDirectory, "context"))).find((n) =>
      n.startsWith("human-request-"),
    )!;
    await writeFile(join(h.runDirectory, "context", name), "corruption");
    await expect(
      new PlanningOrchestrator({
        ...h,
        clarificationPort: port,
      }).requestClarification({ state: h.state }),
    ).rejects.toThrow(/hash/iu);
    expect(port.calls).toHaveLength(0);
  });
  test("completed durable answer recovers after transition-save failure without asking again", async () => {
    const h = await setup({ requiresClarification: true });
    const store = new StateStore(h.runDirectory);
    const port = providedPort("Confirmed choice");
    await expect(
      new PlanningOrchestrator({
        ...h,
        clarificationPort: port,
        stateStore: {
          saveState: (state, rev) => {
            if (state.phase === "planning")
              throw Error("Transition interrupted");
            return store.saveState(state, rev);
          },
        },
      }).requestClarification({ state: h.state }),
    ).rejects.toThrow("Transition interrupted");
    const interrupted = await store.loadState();
    expect(interrupted.phase).toBe("clarifying");
    expect(interrupted.planning.clarificationProgressRef).toBeDefined();
    const nextPort = providedPort("Must not replace the answer");
    const result = await new PlanningOrchestrator({
      ...h,
      clarificationPort: nextPort,
    }).requestClarification({ state: interrupted });
    expect(nextPort.calls).toHaveLength(0);
    expect(result.state.phase).toBe("planning");
    expect(
      await h.artifactStore.readText!(
        result.state.planning.context.clarificationRef!,
      ),
    ).toContain("Confirmed choice");
  });
  test("stale State cannot replace a current confirmed answer", async () => {
    const h = await setup({ requiresClarification: true });
    const first = await new PlanningOrchestrator({
      ...h,
      clarificationPort: providedPort("Current choice"),
    }).requestClarification({ state: h.state });
    await expect(
      new PlanningOrchestrator({
        ...h,
        clarificationPort: providedPort("Stale choice"),
      }).requestClarification({ state: h.state }),
    ).rejects.toThrow(/revision/iu);
    expect(await new StateStore(h.runDirectory).loadState()).toEqual(
      first.state,
    );
  });
  test("decline blocks and never creates Plan/implementation authority", async () => {
    const h = await setup({ requiresClarification: true });
    const result = await new PlanningOrchestrator({
      ...h,
      clarificationPort: new FakeClarificationPort({
        request: {
          type: "result",
          value: { status: "declined", reason: "Need product owner" },
        },
      }),
    }).requestClarification({ state: h.state });
    expect(result.status).toBe("declined");
    expect(result.state.phase).toBe("blocked");
    expect(result.state.planning.context.clarificationRef).toBeUndefined();
    expect(h.subagentExecutor.calls.run).toHaveLength(1);
  });
});

describe("PlanningOrchestrator candidate Plan", () => {
  test("does not drop evidence-routed Architecture", async () => {
    const h = await setup({ requiresArchitecture: true }, [
      "facts",
      validPlan.replace(
        "## Architecture / Design\nPreserve the existing parser boundary.\n\n",
        "",
      ),
    ]);
    await expect(
      new PlanningOrchestrator(h).createPlan({ state: h.state }),
    ).rejects.toThrow(/Architecture \/ Design/iu);
    expect((await new StateStore(h.runDirectory).loadState()).phase).toBe(
      "planning",
    );
  });
  test("passes exact refs and validates before publishing plan-v1", async () => {
    const h = await setup();
    const result = await new PlanningOrchestrator(h).createPlan({
      state: h.state,
    });
    expect(result.state.phase).toBe("awaiting-plan-review");
    expect(result.state.planning.currentPlanVersion).toBe(1);
    expect(h.subagentExecutor.calls.run[1]?.inputRefs).toEqual([
      h.taskRef,
      h.state.planning.context.scoutRef,
      ...result.plannerInput.decisionRefs!,
    ]);
    expect(h.subagentExecutor.calls.run[1]?.task).toMatch(
      /target version.*1/iu,
    );
    expect(
      await readFile(join(h.runDirectory, "plans", "plan-v1.md"), "utf8"),
    ).toBe(validPlan);
  });
  test.each([
    validPlan.replace("## Implementation Plan", "## Notes"),
    validPlan.replace('"schemaVersion":1', '"schemaVersion":2'),
  ])("invalid Plan never emits PLAN_CREATED", async (output) => {
    const h = await setup({}, ["facts", output]);
    await expect(
      new PlanningOrchestrator(h).createPlan({ state: h.state }),
    ).rejects.toThrow();
    expect(
      (await new StateStore(h.runDirectory).loadState()).planning
        .currentPlanVersion,
    ).toBe(0);
    await expect(readdir(join(h.runDirectory, "plans"))).rejects.toThrow();
  });
  test("Plan feedback creates immutable v2 and forwards exact feedback", async () => {
    const h = await setup({}, [
      "facts",
      validPlan,
      validPlan.replace("# Plan", "# Plan v2"),
    ]);
    const orchestration = new PlanningOrchestrator(h);
    const first = await orchestration.createPlan({ state: h.state });
    const feedbackRef = await h.artifactStore.writeText(
      "plan-review",
      "review-1.md",
      "Clarify validation",
    );
    const state = await advanceWorkflow(
      first.state,
      { type: "PLAN_FEEDBACK", feedbackRef },
      h.stateStore,
    );
    const second = await orchestration.createPlan({ state });
    expect(second.state.planning.currentPlanVersion).toBe(2);
    expect(second.state.planning.latestPlanReviewRef).toBeUndefined();
    expect(h.subagentExecutor.calls.run[2]?.inputRefs).toEqual([
      h.taskRef,
      h.state.planning.context.scoutRef,
      ...second.plannerInput.decisionRefs!,
      first.planRef,
      feedbackRef,
    ]);
    expect(
      await readFile(join(h.runDirectory, "plans", "plan-v1.md"), "utf8"),
    ).toBe(validPlan);
    expect(
      await readFile(join(h.runDirectory, "plans", "plan-v2.md"), "utf8"),
    ).toContain("# Plan v2");
  });
});
