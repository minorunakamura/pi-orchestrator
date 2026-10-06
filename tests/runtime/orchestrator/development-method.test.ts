import { afterEach, expect, test, vi } from "vitest";
import {
  phaseCWorkflow,
  type PhaseCWorkflow,
} from "../../fakes/phase-c-workflow.ts";
import { parsePlan } from "../../../src/runtime/planning/plan-parser.ts";
import { parseWorkerAttempt } from "../../../src/runtime/worker/attempt-evidence.ts";
import { parsePlanningDecisionArtifact } from "../../../src/core/decisions/planning-routing.ts";
import { validateWorkerStrategy } from "../../../src/runtime/worker/development-strategy.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const fixtures: PhaseCWorkflow[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map((h) => h.cleanup()));
});
async function setup(script: Parameters<typeof phaseCWorkflow>[0] = {}) {
  const h = await phaseCWorkflow(script);
  fixtures.push(h);
  await h.createPlan();
  return h;
}

test.each([false, true])(
  "exact TDD Plan approval binds method/seams and explicit skills (supporting=%s); deterministic Validation is unchanged",
  async (supportingSkills) => {
    const h = await setup({ developmentIntent: "TDD", supportingSkills });
    const waiting = await h.load();
    expect(waiting.phase).toBe("awaiting-plan-review");
    expect(h.children.some((request) => request.agent === "worker")).toBe(
      false,
    );
    const content = await h.artifactStore.readText(
      waiting.planning.currentPlanRef!,
    );
    const plan = parsePlan(content);
    expect(plan.developmentMethod).toBe("TDD");
    expect(plan.testSeams).toContain("public checkout(cart)");
    const approved = await h.settlePlan();
    expect(approved.state.planning.approvedPlanRef).toEqual(
      waiting.planning.currentPlanRef,
    );
    const review = JSON.parse(
      await h.artifactStore.readText(
        approved.state.planning.latestPlanReviewRef!,
      ),
    );
    expect(review.planRef).toEqual(waiting.planning.currentPlanRef);
    const result = await h.implement();
    const attempt = await h.artifactStore.readJson(
      result.state.coding.workerAttemptRef!,
      parseWorkerAttempt,
    );
    expect(attempt.inputRefs).toContainEqual(
      waiting.planning.developmentMethodRef,
    );
    expect(attempt.launch).toMatchObject({
      source: "builtin",
      inheritSkills: false,
      policy: {
        skills: supportingSkills ? ["tdd", "codebase-design"] : ["tdd"],
      },
    });
    const worker = h.children.find((request) => request.agent === "worker")!;
    expect(worker.task).toContain(plan.testSeams);
    expect(worker.task).toMatch(
      /vertical RED -> minimal GREEN -> next vertical slice/u,
    );
    expect(worker.task).toMatch(
      /Never write all tests then all implementation/u,
    );
    expect(worker.task).toMatch(/Report each slice.*observed RED and GREEN/u);
    expect(worker.task).toMatch(/TDD never replaces.*Validation Contract/u);
    expect(result.state.phase).toBe("validating");
    const validation = await h.validate();
    expect(validation.state.phase).toBe("reviewing");
    expect(h.validations).toEqual([plan.validationContract]);
  },
);

test.each(["STANDARD", "TDD"] as const)(
  "Human-selected %s binds the approved Worker strategy and rejects corrupted historical selection",
  async (method) => {
    const h = await phaseCWorkflow({ method, methodConfidence: 0.6 });
    fixtures.push(h);
    const pending = await h.drive({
      humanQuestionPort: {
        projectRoot: h.repositoryCwd,
        rootSessionId: "root-method-worker",
        ask: async (_id, questions) => ({
          status: "answered",
          questions,
          cancelled: false,
          answers: { [questions[0].question]: method },
          selections: [
            {
              question: questions[0].question,
              header: questions[0].header,
              value: method,
              labels: [method],
              selectedIndices: [method === "STANDARD" ? 1 : 2],
            },
          ],
        }),
      },
    });
    expect(pending.state.phase).toBe("awaiting-plan-review");
    expect(h.children.filter((child) => child.agent === "worker")).toHaveLength(
      0,
    );
    await h.settlePlan();
    const implemented = await h.implement();
    const attempt = await h.artifactStore.readJson(
      implemented.state.coding.workerAttemptRef!,
      parseWorkerAttempt,
    );
    expect(attempt.launch?.policy.skills).toEqual(
      method === "TDD" ? ["tdd"] : [],
    );
    await expect(
      validateWorkerStrategy(h.artifactStore, implemented.state, attempt),
    ).resolves.toMatchObject({ developmentMethod: method });
    const selected = JSON.parse(
      await h.artifactStore.readText(
        implemented.state.planning.developmentMethodSelectionRef!,
      ),
    );
    await writeFile(
      join(h.artifactStore.rootDirectory, selected.intentRef.path),
      "corrupted intent",
    );
    await expect(
      validateWorkerStrategy(h.artifactStore, implemented.state, attempt),
    ).rejects.toThrow(/hash|Hash/u);
    expect(h.children.filter((child) => child.agent === "worker")).toHaveLength(
      1,
    );
  },
);

test("STANDARD does not acquire ambient TDD; method resolution continues without manual resume", async () => {
  const h = await setup();
  await h.settlePlan();
  const result = await h.implement();
  const attempt = await h.artifactStore.readJson(
    result.state.coding.workerAttemptRef!,
    parseWorkerAttempt,
  );
  expect(attempt.launch?.policy.skills).toEqual([]);
  expect(attempt.launch?.skills).toEqual([]);
  expect(attempt.launch?.inheritSkills).toBe(false);
});

test("routed TDD can resume approved authority without another method decision or Worker dispatch", async () => {
  const h = await setup({ method: "TDD" });
  await h.settlePlan();
  const implemented = await h.implement();
  const methodRef = implemented.state.planning.developmentMethodRef!;
  const method = await h.artifactStore.readJson(
    methodRef,
    parsePlanningDecisionArtifact,
  );
  expect(method).toMatchObject({ family: "method", outcome: "TDD" });
  const result = await h.resume();
  expect(result.state.phase).toBe("completed");
  expect(result.state.planning.developmentMethodRef).toEqual(methodRef);
  expect(result.state.planning.approvedPlanRef).toEqual(
    implemented.state.planning.approvedPlanRef,
  );
  expect(
    h.children.filter((request) => request.agent === "worker"),
  ).toHaveLength(1);
  expect(h.jevRequests).toHaveLength(2);
});

test.each(["intent", "method-ref", "plan-seams"] as const)(
  "approved TDD %s drift cannot launch a Worker or silently reapprove",
  async (change) => {
    const h = await setup({ developmentIntent: "TDD" });
    await h.settlePlan();
    const state = await h.load();
    if (change === "intent") state.planning.developmentIntent = "BEHAVIOR_FREE";
    if (change === "method-ref") delete state.planning.developmentMethodRef;
    if (change === "plan-seams") {
      const ref = state.planning.approvedPlanRef!;
      const content = await h.artifactStore.readText(ref);
      const replacement = await h.artifactStore.writeText(
        "plan",
        "unapproved-seams.md",
        content.replace("public checkout(cart)", "private helper"),
      );
      state.planning.currentPlanRef = replacement;
      state.planning.approvedPlanRef = replacement;
    }
    if (change === "plan-seams") {
      // Keeping the historical review binding is intentional: the immutable Plan changed, not the Human approval.
      await expect(
        h.stateStore.saveState(state, state.stateRevision),
      ).rejects.toThrow(/planReview/u);
    } else {
      await h.stateStore.saveState(state, state.stateRevision);
      await expect(h.implement()).rejects.toThrow(/operator attention/u);
      expect((await h.load()).phase).toBe("blocked");
    }
    expect(
      h.children.filter((request) => request.agent === "worker"),
    ).toHaveLength(0);
  },
);

test("resume blocks current skill drift without labelling valid historical implementation corrupt or launching another Worker", async () => {
  const h = await setup({
    developmentIntent: "TDD",
    rounds: [{ action: "RETRY" }],
  });
  await h.settlePlan();
  await h.implement();
  await h.validate();
  await h.review();
  await h.evaluate();
  await h.decide();
  const before = await h.load();
  expect(before.phase).toBe("fixing");
  const preflight = h.subagentExecutor.preflight.bind(h.subagentExecutor);
  vi.spyOn(h.subagentExecutor, "preflight").mockImplementation(
    async (input) => {
      const launch = await preflight(input);
      return {
        ...launch,
        skills: launch.skills.map((skill) =>
          Object.assign({}, skill, { contentDigest: "f".repeat(64) }),
        ),
      };
    },
  );
  const result = await h.resume();
  expect(result.status).toBe("blocked");
  expect(result.state.block).toMatchObject({
    reason: "operator-attention-required",
    blockedFrom: "fixing",
  });
  expect(result.state.failure).toBeUndefined();
  expect(result.state.coding.implementationRef).toEqual(
    before.coding.implementationRef,
  );
  expect(
    h.children.filter((request) => request.agent === "worker"),
  ).toHaveLength(1);
});

test("recovery rejects historical skill-byte drift rather than rerunning a possibly mutating Worker", async () => {
  const h = await setup({ developmentIntent: "TDD" });
  await h.settlePlan();
  const implemented = await h.implement();
  const attempt = await h.artifactStore.readJson(
    implemented.state.coding.workerAttemptRef!,
    parseWorkerAttempt,
  );
  const preflight = h.subagentExecutor.preflight.bind(h.subagentExecutor);
  vi.spyOn(h.subagentExecutor, "preflight").mockImplementation(
    async (input) => {
      const launch = await preflight(input);
      return {
        ...launch,
        skills: launch.skills.map((skill) =>
          Object.assign({}, skill, { contentDigest: "f".repeat(64) }),
        ),
      };
    },
  );
  await expect(
    validateWorkerStrategy(
      h.artifactStore,
      implemented.state,
      attempt,
      h.subagentExecutor,
    ),
  ).rejects.toThrow(/stale/u);
  expect(
    h.children.filter((request) => request.agent === "worker"),
  ).toHaveLength(1);
});
