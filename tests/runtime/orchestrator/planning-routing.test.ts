import { diagnosisReport } from "../../fakes/diagnosis.ts";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ClassifierContext } from "@earendil-works/pi-ai";
import { isRecord, isOneOf } from "../../../src/core/schema.ts";
import type { ArtifactRef } from "../../../src/core/artifacts/references.ts";
import type { PlaybookKind } from "../../../src/types.ts";
import type {
  ConditionalStage,
  StageOutcome,
  ClarificationMode,
  DevelopmentIntent,
} from "../../../src/core/decisions/planning-routing.ts";
import {
  conditionalStages,
  parsePlanningDecisionArtifact,
} from "../../../src/core/decisions/planning-routing.ts";
import { createWorkflow } from "../../../src/runtime/orchestrator/start-workflow.ts";
import {
  driveWorkflow,
  type WorkflowDriverDependencies,
} from "../../../src/runtime/orchestrator/drive-workflow.ts";
import { resumeWorkflow } from "../../../src/runtime/orchestrator/resume-workflow.ts";
import { PlanningOrchestrator } from "../../../src/runtime/orchestrator/planning-orchestrator.ts";
import {
  PlanningRouting,
  PlanningRoutingStoppedError,
} from "../../../src/runtime/orchestrator/planning-routing.ts";
import { StateStore } from "../../../src/runtime/persistence/state-store.ts";
import { ArtifactStore } from "../../../src/runtime/persistence/artifact-store.ts";
import { PiClassifierDecisionClient } from "../../../src/runtime/integrations/jev.ts";
import { classification, nativeRuntime } from "../../fakes/classifier.ts";
import {
  configuration as defaults,
  plan,
  succeeded,
} from "../../fakes/coding-scenario.ts";
import { jevPolicy } from "../../fakes/jev-policy.ts";
import {
  FakeSubagentExecutor,
  FakeClarificationPort,
} from "../../fakes/index.ts";
import { plannotatorReviewId } from "../../../src/types.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
interface Script {
  intent?: DevelopmentIntent;
  task?: string;
  method?: "STANDARD" | "TDD" | "ESCALATE";
  methodConfidence?: number;
  plannerOutput?: string;
  playbook?: PlaybookKind;
  stages?: Partial<Record<ConditionalStage, StageOutcome>>;
  mode?: ClarificationMode;
  confidence?: number;
  modeConfidence?: number;
  diagnosis?: boolean;
  diagnosisOutput?: string;
  invalid?: boolean;
}
async function setup(script: Script = {}) {
  const root = await mkdtemp(join(tmpdir(), "stage-routing-"));
  roots.push(root);
  const runDirectory = join(root, "routing");
  const artifactStore = new ArtifactStore(runDirectory);
  const stateStore = new StateStore(runDirectory);
  const configuration = structuredClone(defaults);
  configuration.jev = jevPolicy(root);
  const trace: string[] = [];
  const inputs: ClassifierContext[] = [];
  const client = new PiClassifierDecisionClient({
    ...configuration.jev,
    modelRegistry: nativeRuntime(async (_model, input) => {
      const state = await stateStore.loadState();
      expect(state.planning.context.scoutRef).toBeDefined();
      const reservation = JSON.parse(
        await artifactStore.readText(state.jevUsage!.latestRequestRef!),
      );
      const family = reservation.family;
      if (!isRecord(input.state) || !isRecord(input.state.evidence))
        throw Error("Missing planning evidence");
      const stage = input.state.stage ?? input.state.evidence.stage;
      if (!isOneOf([...conditionalStages, "development-method"], stage))
        throw Error("Invalid planning stage");
      trace.push(
        family === "stage"
          ? `decide:${stage}`
          : family === "method"
            ? "decide:method"
            : "decide:mode",
      );
      inputs.push(structuredClone(input));
      const value =
        family === "stage" && stage !== "development-method"
          ? (script.stages?.[stage] ?? "SKIP")
          : family === "method"
            ? (script.method ?? "STANDARD")
            : (script.mode ?? "GRILL_ME");
      const confidence =
        (family === "clarification"
          ? script.modeConfidence
          : family === "method"
            ? script.methodConfidence
            : script.confidence) ?? 0.99;
      const choices = Object.keys(input.questions.decision.criteria);
      return classification({
        decision: {
          type: "choice",
          choice: script.invalid ? "WRITE_DOCS" : value,
          confidence,
          probabilities: Object.fromEntries(
            choices.map((choice) => [
              choice,
              choice === value
                ? confidence
                : (1 - confidence) / (choices.length - 1),
            ]),
          ),
        },
      });
    }),
  });
  const executor = new FakeSubagentExecutor({
    run: [
      succeeded("Scout: local implementation and unknowns"),
      ...(["bugfix", "hotfix"].includes(script.playbook ?? "feature")
        ? [
            succeeded(
              script.diagnosisOutput ??
                (script.diagnosis === false
                  ? "invalid diagnosis"
                  : JSON.stringify(diagnosisReport)),
            ),
          ]
        : []),
      ...(script.stages?.research === "RUN"
        ? [succeeded("Research: released API source and uncertainty")]
        : []),
      succeeded(
        script.plannerOutput ??
          (script.intent === "TDD" ||
          (script.intent !== "BEHAVIOR_FREE" && script.method === "TDD") ||
          script.task?.includes("Development Method: TDD")
            ? plan.replace(
                "## Development Method\nSTANDARD",
                "## Development Method\nTDD\n## Test Seams\n- public route(input): observable method, missing-seam rejection and regression assertions; dependencies injected through public ports.\n## Do not test\n- private helpers/internal collaborator calls",
              )
            : plan),
      ),
    ],
  });
  const run = executor.run.bind(executor);
  vi.spyOn(executor, "run").mockImplementation(async (input) => {
    const state = await stateStore.loadState();
    trace.push(`child:${input.agent}`);
    if (input.agent === "workflow-scout") {
      expect(state.planning.stageDecisionRefs).toEqual({});
      if (input.dispatch?.nodeId === "diagnosis") {
        expect(state.planning.context.scoutRef).toBeDefined();
        expect(state.planning.context.diagnosisRef).toBeUndefined();
      }
    }
    if (input.agent === "pi-ketch.researcher")
      expect(state.planning.stageDecisionRefs?.research).toBeDefined();
    if (input.agent === "planner") {
      expect(state.planning.stageDecisionRefs?.architecture).toBeDefined();
      expect(state.planning.clarificationModeRef).toBeDefined();
      expect(state.planning.developmentMethodRef).toBeDefined();
      expect(state.planning.approvedPlanRef).toBeUndefined();
    }
    return run(input);
  });
  await createWorkflow(
    {
      task: script.task ?? "Implement the bounded routing change",
      developmentIntent: script.intent,
      playbook: script.playbook ?? "feature",
      cwd: root,
      context: {
        requiresResearch: false,
        requiresClarification: false,
        requiresArchitecture: false,
      },
    },
    {
      runsDirectory: root,
      workflowIdFactory: () => "routing",
      artifactStore,
      stateStore,
      subagentExecutor: executor,
    },
  );
  const deps = {
    artifactStore,
    stateStore,
    subagentExecutor: executor,
    configuration,
    jevDecisionClient: client,
    cwd: root,
    loadState: () => stateStore.loadState(),
    plannotatorGate: {
      openPlanReview: async (input: {
        planRef: ArtifactRef<"plan">;
        planVersion: number;
        simplicityReviewRef?: ArtifactRef<"plan-simplicity-review">;
      }) => {
        trace.push("human:plan");
        return {
          planRef: input.planRef,
          planVersion: input.planVersion,
          simplicityReviewRef: input.simplicityReviewRef,
          reviewId: plannotatorReviewId("plan"),
        };
      },
      getPlanReview: async () => {
        throw Error("not used");
      },
      openCodeReview: async () => {
        throw Error("No implementation authority");
      },
      getCodeReview: async () => {
        throw Error("not used");
      },
    },
  };
  return {
    root,
    runDirectory,
    deps,
    trace,
    inputs,
    executor,
    load: deps.loadState,
    drive: () => driveWorkflow("routing", deps),
    gather: async () =>
      new PlanningOrchestrator(deps).gatherContext({
        state: await deps.loadState(),
        cwd: root,
      }),
    decision: async (ref: ArtifactRef) =>
      parsePlanningDecisionArtifact(
        JSON.parse(await artifactStore.readText(ref)),
      ),
  };
}

test("normal driver sequences durable Research, clarification and Architecture without manual resume; both gates remain authority", async () => {
  const h = await setup({ stages: { research: "RUN", architecture: "RUN" } });
  const result = await h.drive();
  expect(result.status).toBe("pending");
  expect(result.state.phase).toBe("awaiting-plan-review");
  expect(h.trace).toEqual([
    "child:workflow-scout",
    "decide:research",
    "child:pi-ketch.researcher",
    "decide:clarification",
    "decide:architecture",
    "decide:method",
    "child:planner",
    "child:plan-simplicity-reviewer",
    "human:plan",
  ]);
  const refs = result.state.planning.stageDecisionRefs!;
  expect(
    (await h.decision(refs.research!)).inputRefs.map((ref) => ref.kind),
  ).toEqual(["task", "scout"]);
  expect(
    (await h.decision(refs.clarification!)).inputRefs.map((ref) => ref.kind),
  ).toEqual(["task", "scout", "conditional-stage", "research"]);
  const architecture = await h.decision(refs.architecture!);
  expect(architecture).toMatchObject({
    approvedPlanRef: null,
    planVersion: null,
    classifier: { provider: "typesafe", model: "jev-latest" },
    outcome: "RUN",
  });
  expect(architecture.requestRef).toBeDefined();
  expect(architecture.usageRef).toBeDefined();
  const usage = JSON.parse(
    await h.deps.artifactStore.readText(architecture.usageRef!),
  );
  expect(usage.answers.decision.probabilities.RUN).toBe(0.99);
  expect(result.state.planning.approvedPlanRef).toBeUndefined();
  expect(result.state.coding.implementationRef).toBeUndefined();
});

test.each(["new-project", "chore", "hotfix"] as const)(
  "%s Architecture required/skip never calls Jev",
  async (playbook) => {
    const h = await setup({
      playbook,
      diagnosis: playbook === "hotfix",
      stages: { architecture: "ESCALATE" },
    });
    const result = await h.drive();
    expect(result.state.phase).toBe("awaiting-plan-review");
    expect(h.trace).not.toContain("decide:architecture");
    expect(
      await h.decision(result.state.planning.stageDecisionRefs!.architecture!),
    ).toMatchObject({
      outcome: playbook === "new-project" ? "RUN" : "SKIP",
      classifier: null,
      rawDecision: null,
    });
  },
);

test.each(["GRILL_ME", "GRILL_WITH_DOCS"] as const)(
  "%s mode is durable before the genuine Human wait and grants no write/implementation authority",
  async (mode) => {
    const h = await setup({ stages: { clarification: "RUN" }, mode });
    const waiting = await h.drive();
    expect(waiting.state.phase).toBe("clarifying");
    expect(h.trace).toEqual([
      "child:workflow-scout",
      "decide:research",
      "decide:clarification",
      "decide:mode",
    ]);
    expect(
      await h.decision(waiting.state.planning.clarificationModeRef!),
    ).toMatchObject({ family: "clarification", outcome: mode });
    expect(waiting.state.planning.context.clarificationRef).toBeUndefined();
    expect(await readdir(h.root)).toEqual(["routing"]);
    const port = new FakeClarificationPort({
      request: {
        type: "result",
        value: { status: "provided", answer: "Human-confirmed scope" },
      },
    });
    const result = await driveWorkflow("routing", {
      ...h.deps,
      clarificationPort: port,
      clarificationPrompt: "Root-generated question, not classifier text",
    });
    expect(result.state.phase).toBe("awaiting-plan-review");
    expect(port.calls[0]).toMatchObject({
      mode,
      modeRef: waiting.state.planning.clarificationModeRef,
    });
    expect(
      (await h.decision(result.state.planning.stageDecisionRefs!.architecture!))
        .inputRefs,
    ).toContainEqual(result.state.planning.context.clarificationRef);
    for (const request of h.inputs) {
      const questions = request.questions;
      expect(Object.keys(questions)).toEqual(["decision"]);
      expect(JSON.stringify(questions)).not.toContain(
        "Root-generated question",
      );
    }
  },
);

test.each(["bugfix", "hotfix"] as const)(
  "%s consumes durable Diagnosis at every routing frontier",
  async (playbook) => {
    const h = await setup({ playbook, diagnosis: true });
    const result = await h.drive();
    const diagnosisRef = result.state.planning.context.diagnosisRef!;
    for (const ref of Object.values(result.state.planning.stageDecisionRefs!)) {
      // oxlint-disable-next-line eslint/no-await-in-loop
      expect((await h.decision(ref)).inputRefs).toContainEqual(diagnosisRef);
    }
    expect(
      h.executor.calls.run.find((input) => input.agent === "planner")
        ?.inputRefs,
    ).toContainEqual(diagnosisRef);
  },
);

test.each(["bugfix", "hotfix"] as const)(
  "%s blocks on invalid Diagnosis instead of silently skipping evidence",
  async (playbook) => {
    const h = await setup({ playbook, diagnosis: false });
    const result = await h.drive();
    expect(result.state.block?.reason).toBe("operator-attention-required");
    expect(h.trace).toEqual(["child:workflow-scout", "child:workflow-scout"]);
  },
);

test.each([
  { confidence: 0.79 },
  { stages: { research: "ESCALATE" as const } },
  { invalid: true },
])(
  "uncertain/invalid routing never skips or starts a later side effect: %j",
  async (script) => {
    const h = await setup(script);
    const result = await h.drive();
    expect(result.status).toBe("blocked");
    expect(h.trace).toEqual(["child:workflow-scout", "decide:research"]);
    if (!script.invalid)
      expect(
        (await h.decision(result.state.planning.stageDecisionRefs!.research!))
          .outcome,
      ).toBe("ESCALATE");
  },
);

test.each(["SKIP", "ESCALATE"] as const)(
  "mode %s cannot reverse a stage RUN",
  async (mode) => {
    const h = await setup({ stages: { clarification: "RUN" }, mode });
    const result = await h.drive();
    expect(result.status).toBe("blocked");
    expect(
      (await h.decision(result.state.planning.clarificationModeRef!)).outcome,
    ).toBe("ESCALATE");
    expect(result.state.planning.context.clarificationRef).toBeUndefined();
  },
);

test("resume reuses fresh decisions without classifier calls and rejects configuration drift before Planner", async () => {
  const h = await setup();
  await h.gather();
  const before = await h.load();
  await h.deps.stateStore.saveState(
    { ...before, phase: "gathering-context" },
    before.stateRevision,
  );
  const recovered = await resumeWorkflow("routing", {
    ...h.deps,
    runDirectory: h.runDirectory,
  });
  expect(recovered.state.phase).toBe("awaiting-plan-review");
  expect(h.trace.filter((item) => item === "decide:research")).toHaveLength(1);
  expect(
    h.trace.filter((item) => item === "decide:clarification"),
  ).toHaveLength(1);
  const h2 = await setup();
  await h2.gather();
  h2.deps.configuration.decision.autoDecisionThreshold = 0.9;
  const stale = await h2.drive();
  expect(stale.state.block?.reason).toBe("operator-attention-required");
  expect(h2.trace).not.toContain("child:planner");
});

test.each([
  "scout",
  "diagnosis",
  "task",
  "classifier",
  "corrupt-decision",
] as const)(
  "rejects stale/corrupt %s without reclassifying or launching",
  async (change) => {
    const h = await setup({ playbook: "bugfix", diagnosis: true });
    await h.gather();
    const state = await h.load();
    if (change === "classifier")
      h.deps.configuration.jev.classifier = {
        provider: "typesafe",
        model: "other",
      };
    else if (change === "corrupt-decision")
      await writeFile(
        join(h.runDirectory, state.planning.stageDecisionRefs!.research!.path),
        "{}",
      );
    else {
      const ref = await h.deps.artifactStore.writeText(
        change,
        `${change}-changed.md`,
        "Changed durable evidence",
      );
      if (change === "task") state.taskRef = { ...ref, kind: "task" };
      else if (change === "scout")
        state.planning.context.scoutRef = { ...ref, kind: "scout" };
      else state.planning.context.diagnosisRef = { ...ref, kind: "diagnosis" };
      await h.deps.stateStore.saveState(state, state.stateRevision);
    }
    const count = h.inputs.length;
    expect((await h.drive()).status).toBe("blocked");
    expect(h.inputs).toHaveLength(count);
    expect(h.executor.calls.run).toHaveLength(2);
  },
);

test("decision State save failure stops before Research and never grants write authority", async () => {
  const h = await setup({ stages: { research: "RUN" } });
  await expect(
    driveWorkflow("routing", {
      ...h.deps,
      stateStore: {
        saveState: (state, revision) => {
          if (state.planning.stageDecisionRefs?.research)
            throw Error("decision State failure");
          return h.deps.stateStore.saveState(state, revision);
        },
      },
    }),
  ).rejects.toThrow("decision State failure");
  expect(h.trace).toEqual(["child:workflow-scout", "decide:research"]);
  expect((await h.load()).planning.stageDecisionRefs).toEqual({});
  expect(
    (await readdir(join(h.runDirectory, "decisions"))).some((file) =>
      file.startsWith("conditional-stage-"),
    ),
  ).toBe(true);
});

test("over-bound evidence, missing consent and exhausted budget all prevent classifier dispatch", async () => {
  for (const fault of ["bound", "consent", "budget"] as const) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    const h = await setup();
    if (fault === "consent")
      h.deps.configuration.jev.runtimePolicy!.grant.active = false;
    if (fault === "budget")
      h.deps.configuration.jev.runtimePolicy!.maxRequests = 0;
    if (fault === "bound") {
      // oxlint-disable-next-line eslint/no-await-in-loop
      const state = await h.load();
      // oxlint-disable-next-line eslint/no-await-in-loop
      const taskRef = await h.deps.artifactStore.writeText(
        "task",
        "large.md",
        "constraint ".repeat(2000),
      );
      // oxlint-disable-next-line eslint/no-await-in-loop
      await h.deps.stateStore.saveState(
        { ...state, taskRef },
        state.stateRevision,
      );
    }
    // oxlint-disable-next-line eslint/no-await-in-loop
    expect((await h.drive()).status).toBe("blocked");
    expect(h.inputs).toEqual([]);
  }
});

test("low-confidence clarification mode escalates without invoking a Human port or writing docs", async () => {
  const h = await setup({
    stages: { clarification: "RUN" },
    mode: "GRILL_WITH_DOCS",
    modeConfidence: 0.4,
  });
  const port = new FakeClarificationPort();
  const result = await driveWorkflow("routing", {
    ...h.deps,
    clarificationPort: port,
    clarificationPrompt: "Unused root question",
  });
  expect(result.status).toBe("blocked");
  expect(port.calls).toEqual([]);
  expect(
    await h.decision(result.state.planning.clarificationModeRef!),
  ).toMatchObject({
    outcome: "ESCALATE",
    rawDecision: { value: "GRILL_WITH_DOCS", confidence: 0.4 },
  });
  const count = h.inputs.length;
  expect(
    (
      await resumeWorkflow("routing", {
        ...h.deps,
        runDirectory: h.runDirectory,
      })
    ).status,
  ).toBe("blocked");
  expect(h.inputs).toHaveLength(count);
});

test.each(["revoked", "provider", "model", "categories", "grant"])(
  "cached planning decisions cannot bypass %s consent drift",
  async (change) => {
    const h = await setup();
    await h.gather();
    const count = h.inputs.length;
    const grant = h.deps.configuration.jev.runtimePolicy!.grant;
    if (change === "revoked") grant.active = false;
    if (change === "provider") {
      h.deps.configuration.jev.classifier = {
        provider: "openrouter",
        model: "jev-latest",
      };
      grant.destination = "openrouter/jev-latest";
    }
    if (change === "model") {
      h.deps.configuration.jev.classifier = {
        provider: "typesafe",
        model: "other",
      };
      grant.destination = "typesafe/other";
    }
    if (change === "categories") grant.evidenceCategories = [];
    if (change === "grant") grant.id = "replacement";
    expect((await h.drive()).status).toBe("blocked");
    expect(h.inputs).toHaveLength(count);
    expect(h.executor.calls.run).toHaveLength(1);
  },
);

test("fresh decisions survive client recreation without any classifier capability", async () => {
  const h = await setup();
  await h.gather();
  await new PlanningRouting(h.deps).stage(await h.load(), "architecture");
  await new PlanningRouting(h.deps).method(await h.load());
  const count = h.inputs.length;
  const result = await driveWorkflow("routing", {
    ...h.deps,
    jevDecisionClient: undefined,
  });
  expect(result.state.phase).toBe("awaiting-plan-review");
  expect(h.inputs).toHaveLength(count);
});

test("changed confirmed Human evidence invalidates Architecture before Plan Gate reuse", async () => {
  const h = await setup({ stages: { clarification: "RUN" } });
  await h.drive();
  await driveWorkflow("routing", {
    ...h.deps,
    clarificationPort: new FakeClarificationPort({
      request: {
        type: "result",
        value: { status: "provided", answer: "First choice" },
      },
    }),
    clarificationPrompt: "Root question",
  });
  const state = await h.load();
  const changed = await h.deps.artifactStore.writeText(
    "clarification",
    "changed.md",
    "Different Human choice",
  );
  state.planning.context.clarificationRef = changed;
  await h.deps.stateStore.saveState(state, state.stateRevision);
  const count = h.inputs.length;
  const result = await resumeWorkflow("routing", {
    ...h.deps,
    runDirectory: h.runDirectory,
  });
  expect(result.status).toBe("blocked");
  expect(result.state.planning.approvedPlanRef).toBeUndefined();
  expect(h.inputs).toHaveLength(count);
});

test("decision Artifact write failure stops before its State ref and next effect", async () => {
  const h = await setup({ stages: { research: "RUN" } });
  await expect(
    driveWorkflow("routing", {
      ...h.deps,
      artifactStore: {
        readText: h.deps.artifactStore.readText.bind(h.deps.artifactStore),
        writeText: h.deps.artifactStore.writeText.bind(h.deps.artifactStore),
        writeJson: (kind, name, value, schema) => {
          if (kind === "conditional-stage")
            throw Error("decision Artifact failure");
          return h.deps.artifactStore.writeJson(kind, name, value, schema);
        },
      },
    }),
  ).rejects.toThrow("decision Artifact failure");
  expect(h.trace).toEqual(["child:workflow-scout", "decide:research"]);
  expect((await h.load()).planning.stageDecisionRefs).toEqual({});
});

test("legacy flags are not accepted as conditional authority", async () => {
  const h = await setup();
  const state = await h.load();
  delete state.planning.stageDecisionRefs;
  state.planning.researchRequired = false;
  state.planning.clarificationRequired = false;
  state.planning.architectureRequired = false;
  await h.deps.stateStore.saveState(state, state.stateRevision);
  await expect(
    new PlanningRouting(h.deps).stage(await h.load(), "research"),
  ).rejects.toBeInstanceOf(PlanningRoutingStoppedError);
  expect(h.inputs).toEqual([]);
});

test.each(["bugfix", "hotfix"] as const)(
  "%s cannot directly launch Planner with missing Diagnosis",
  async (playbook) => {
    const h = await setup({ playbook });
    const state = await h.load();
    const scoutRef = await h.deps.artifactStore.writeText(
      "scout",
      "scout.md",
      "Existing Scout evidence",
    );
    await h.deps.stateStore.saveState(
      {
        ...state,
        phase: "planning",
        planning: { ...state.planning, context: { scoutRef } },
      },
      state.stateRevision,
    );
    expect((await h.drive()).status).toBe("blocked");
    expect(h.executor.calls.run).toEqual([]);
    expect(h.inputs).toEqual([]);
  },
);

test.each(["not-reproduced", "unavailable"] as const)(
  "Diagnosis preserves %s and factual gaps without guessing a cause",
  async (status) => {
    const report = structuredClone(diagnosisReport);
    report.expectedBehavior = null;
    report.reproduction = {
      status,
      steps: [],
      evidence: "No runtime/logs available under the read-only tool ceiling",
    };
    report.rootCause = {
      status: "unknown",
      explanation: "Insufficient facts",
      evidenceStrength: "none",
      supportingEvidence: [],
      contradictingEvidence: [],
    };
    report.unresolvedFactualGaps = ["Need the affected deployment version"];
    const h = await setup({
      playbook: "bugfix",
      diagnosisOutput: JSON.stringify(report),
      stages: { clarification: "RUN" },
    });
    const result = await h.drive();
    expect(result.state.phase).toBe("clarifying");
    const body = JSON.parse(
      await h.deps.artifactStore.readText(
        result.state.planning.context.diagnosisRef!,
      ),
    );
    expect(body.report).toEqual(report);
    expect(h.trace.slice(0, 3)).toEqual([
      "child:workflow-scout",
      "child:workflow-scout",
      "decide:research",
    ]);
  },
);

test("external dependency Diagnosis flows into Research, later routing and Planner", async () => {
  const report = {
    ...diagnosisReport,
    externalDependencySignals: [
      "Released cache-client version changed missing-key behavior",
    ],
  };
  const h = await setup({
    playbook: "bugfix",
    diagnosisOutput: JSON.stringify(report),
    stages: { research: "RUN" },
  });
  const result = await h.drive();
  expect(result.state.phase).toBe("awaiting-plan-review");
  const ref = result.state.planning.context.diagnosisRef!;
  expect(
    h.executor.calls.run.find((input) => input.agent === "pi-ketch.researcher")
      ?.inputRefs,
  ).toContainEqual(ref);
  expect(JSON.stringify(h.inputs)).toContain(
    report.externalDependencySignals[0],
  );
  expect(
    h.executor.calls.run.find((input) => input.agent === "planner")?.inputRefs,
  ).toContainEqual(ref);
});

test.each(["scope-exceeded", "unknown"] as const)(
  "hotfix %s is durable and stops before classifier/Architecture/Planner, including resume",
  async (scope) => {
    const report = {
      ...diagnosisReport,
      hotfix: {
        scope,
        reason:
          "Requires architecture/scope redesign or a Human boundary decision",
        riskNotes: ["Cross-service contract change"],
      },
    };
    const h = await setup({
      playbook: "hotfix",
      diagnosisOutput: JSON.stringify(report),
    });
    const result = await h.drive();
    expect(result.status).toBe("blocked");
    expect(result.state.block?.evidenceRef).toEqual(
      result.state.planning.context.diagnosisRef,
    );
    expect(result.state.planning.stageDecisionRefs).toEqual({});
    expect(h.inputs).toEqual([]);
    const resumed = await resumeWorkflow("routing", {
      ...h.deps,
      runDirectory: h.runDirectory,
    });
    expect(resumed.status).toBe("blocked");
    expect(h.executor.calls.run).toHaveLength(2);
    // Even a manually moved phase cannot make the Diagnosis a scope/implementation grant.
    const state = await h.load();
    delete state.block;
    state.phase = "planning";
    await h.deps.stateStore.saveState(state, state.stateRevision);
    expect((await h.drive()).status).toBe("blocked");
    expect(h.inputs).toEqual([]);
    expect(h.executor.calls.run).toHaveLength(2);
  },
);

test("completed Diagnosis is reused after runtime recreation without status calls or redispatch; launch drift blocks", async () => {
  const h = await setup({ playbook: "bugfix" });
  await h.gather();
  const state = await h.load();
  await h.deps.stateStore.saveState(
    { ...state, phase: "gathering-context" },
    state.stateRevision,
  );
  const result = await resumeWorkflow("routing", {
    ...h.deps,
    runDirectory: h.runDirectory,
  });
  expect(result.state.phase).toBe("awaiting-plan-review");
  expect(
    h.executor.calls.run.filter(
      (input) => input.dispatch?.nodeId === "diagnosis",
    ),
  ).toHaveLength(1);
  expect(h.executor.calls.status).toHaveLength(0);
  const preflight = h.executor.preflight.bind(h.executor);
  vi.spyOn(h.executor, "preflight").mockImplementation(async (input) => ({
    ...(await preflight(input)),
    thinking: "changed",
  }));
  const stale = await h.drive();
  expect(stale.status).toBe("blocked");
  expect(h.executor.calls.run).toHaveLength(4);
});

test.each(["artifact", "state"] as const)(
  "Diagnosis %s failure stops before routing; exact output recovery never redispatches",
  async (fault) => {
    const h = await setup({ playbook: "bugfix" });
    const deps = {
      ...h.deps,
      artifactStore: {
        readText: h.deps.artifactStore.readText.bind(h.deps.artifactStore),
        writeText: <K extends ArtifactRef["kind"]>(
          kind: K,
          name: string,
          content: string,
        ) => {
          if (fault === "artifact" && kind === "diagnosis")
            throw Error("Diagnosis persistence fault");
          return h.deps.artifactStore.writeText(kind, name, content);
        },
      },
      stateStore: {
        saveState: (
          state: Awaited<ReturnType<typeof h.load>>,
          revision?: number,
        ) => {
          if (fault === "state" && state.planning.context.diagnosisRef)
            throw Error("Diagnosis persistence fault");
          return h.deps.stateStore.saveState(state, revision);
        },
      },
    };
    await expect(driveWorkflow("routing", deps)).rejects.toThrow(
      "Diagnosis persistence fault",
    );
    expect(h.inputs).toEqual([]);
    const state = await h.load();
    expect(state.planning.context.diagnosisRef).toBeUndefined();
    const receipt = state.planning.agentAttempts!.diagnosis.receipt!;
    vi.spyOn(h.executor, "status").mockResolvedValue({
      runId: succeeded("").value.runId,
      status: "succeeded",
      result: succeeded(JSON.stringify(diagnosisReport)).value,
    });
    expect(receipt.runId).toBe(succeeded("").value.runId);
    const result = await resumeWorkflow("routing", {
      ...h.deps,
      runDirectory: h.runDirectory,
    });
    expect(result.state.phase).toBe("awaiting-plan-review");
    expect(
      h.executor.calls.run.filter(
        (input) => input.dispatch?.nodeId === "diagnosis",
      ),
    ).toHaveLength(1);
  },
);

test.each([
  { intent: "TDD" as const, method: "STANDARD" as const, expected: "TDD" },
  {
    intent: "BEHAVIOR_FREE" as const,
    method: "TDD" as const,
    expected: "STANDARD",
  },
  {
    intent: "BEHAVIOR_FREE" as const,
    task: "Task\nDevelopment Method: TDD",
    expected: "TDD",
  },
])(
  "captured Human intent $intent deterministically resolves $expected before Planner",
  async (script) => {
    const h = await setup(script);
    const result = await h.drive();
    expect(result.state.phase).toBe("awaiting-plan-review");
    const ref = result.state.planning.developmentMethodRef!;
    expect(await h.decision(ref)).toMatchObject({
      family: "method",
      outcome: script.expected,
      classifier: null,
      rawDecision: null,
      approvedPlanRef: null,
    });
    expect(h.trace).not.toContain("decide:method");
    expect(h.executor.calls.run.at(-1)!.inputRefs).toContainEqual(ref);
    expect(result.state.planning.approvedPlanRef).toBeUndefined();
  },
);

test.each(["STANDARD", "TDD"] as const)(
  "ambiguous eligible method %s is bounded, reserved and durable before automatic Planner continuation",
  async (method) => {
    const h = await setup({ method });
    const result = await h.drive();
    expect(result.state.phase).toBe("awaiting-plan-review");
    const decision = await h.decision(
      result.state.planning.developmentMethodRef!,
    );
    expect(decision).toMatchObject({
      family: "method",
      outcome: method,
      classifier: { provider: "typesafe", model: "jev-latest" },
    });
    expect(decision.inputRefs).toContainEqual(
      result.state.planning.stageDecisionRefs!.architecture,
    );
    expect(decision.requestRef).toBeDefined();
    const reservation = JSON.parse(
      await h.deps.artifactStore.readText(decision.requestRef!),
    );
    expect(reservation.family).toBe("method");
    const usage = JSON.parse(
      await h.deps.artifactStore.readText(decision.usageRef!),
    );
    expect(usage.answers.decision.probabilities[method]).toBe(0.99);
    expect(h.trace.indexOf("decide:method")).toBeLessThan(
      h.trace.indexOf("child:planner"),
    );
    const calls = h.inputs.length;
    expect(
      (
        await new PlanningRouting({
          ...h.deps,
          jevDecisionClient: undefined,
        }).method(await h.load(), true)
      ).method,
    ).toBe(method);
    expect(h.inputs).toHaveLength(calls);
  },
);

test.each([
  { method: "TDD" as const, methodConfidence: 0.2 },
  { method: "ESCALATE" as const },
])(
  "unresolved method persists ESCALATE and never invents Human consent",
  async (script) => {
    const h = await setup(script);
    const result = await h.drive();
    expect(result.state.phase).toBe("blocked");
    expect(result.state.block?.reason).toBe("operator-attention-required");
    expect(
      await h.decision(result.state.planning.developmentMethodRef!),
    ).toMatchObject({ family: "method", outcome: "ESCALATE" });
    expect(h.trace).not.toContain("child:planner");
    expect(h.trace).not.toContain("human:plan");
  },
);

test.each([
  plan.replace("## Development Method\nSTANDARD", "## Development Method\nTDD"),
  plan.replace(
    "## Development Method\nSTANDARD",
    "## Development Method\nTDD\n## Test Seams\nnone",
  ),
  plan,
])(
  "TDD Plan without explicit seams or with a reversed method never reaches Human Gate",
  async (plannerOutput) => {
    const h = await setup({ intent: "TDD", plannerOutput });
    await expect(h.drive()).rejects.toThrow(/Test Seams|Development Method/u);
    expect(h.trace).not.toContain("human:plan");
    expect((await h.load()).planning.currentPlanRef).toBeUndefined();
  },
);

test.each(["intent", "decision", "configuration"] as const)(
  "resume rejects changed method %s without rerouting or Worker authority",
  async (change) => {
    const h = await setup({ method: "TDD" });
    await h.drive();
    const state = await h.load();
    const count = h.inputs.length;
    if (change === "intent") {
      state.planning.developmentIntent = "BEHAVIOR_FREE";
      await h.deps.stateStore.saveState(state, state.stateRevision);
    } else if (change === "decision") {
      await writeFile(
        join(h.runDirectory, state.planning.developmentMethodRef!.path),
        "corrupt method",
      );
    } else h.deps.configuration.decision.autoDecisionThreshold = 0.9;
    const result = await resumeWorkflow("routing", {
      ...h.deps,
      runDirectory: h.runDirectory,
    });
    expect(["blocked", "failed"]).toContain(result.status);
    expect(h.inputs).toHaveLength(count);
    expect(h.executor.calls.run.some((input) => input.agent === "worker")).toBe(
      false,
    );
  },
);

test.each(["artifact", "state"] as const)(
  "method %s persistence failure prevents Planner and Human Gate",
  async (fault) => {
    const h = await setup({ intent: "TDD" });
    const deps: WorkflowDriverDependencies = {
      ...h.deps,
      artifactStore: {
        rootDirectory: h.deps.artifactStore.rootDirectory,
        readText: h.deps.artifactStore.readText.bind(h.deps.artifactStore),
        writeText: h.deps.artifactStore.writeText.bind(h.deps.artifactStore),
        writeJson: async (kind, file, value, schema) => {
          if (fault === "artifact" && kind === "development-method")
            throw Error("method persistence fault");
          return h.deps.artifactStore.writeJson(kind, file, value, schema);
        },
      },
      stateStore: {
        saveState: (
          state: Awaited<ReturnType<typeof h.load>>,
          revision?: number,
        ) => {
          if (fault === "state" && state.planning.developmentMethodRef)
            throw Error("method persistence fault");
          return h.deps.stateStore.saveState(state, revision);
        },
      },
    };
    await expect(driveWorkflow("routing", deps)).rejects.toThrow(
      "method persistence fault",
    );
    expect(h.trace).not.toContain("child:planner");
    expect(h.trace).not.toContain("human:plan");
  },
);
