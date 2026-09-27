import { mkdtemp, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { jevPolicy } from "./jev-policy.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrchestratorConfiguration } from "../../src/core/configuration.ts";
import type { WorkflowState } from "../../src/core/workflow/state.ts";
import type {
  PlannotatorGate,
  JevDecisionClient,
} from "../../src/runtime/ports/index.ts";
import { plannotatorReviewId, subagentRunId } from "../../src/types.ts";
import { startWorkflow } from "../../src/runtime/orchestrator/start-workflow.ts";
import { PlanningOrchestrator } from "../../src/runtime/orchestrator/planning-orchestrator.ts";
import { CodingOrchestrator } from "../../src/runtime/orchestrator/coding-orchestrator.ts";
import { ValidationRunner } from "../../src/runtime/orchestrator/validation-runner.ts";
import { ReviewRunner } from "../../src/runtime/orchestrator/review-runner.ts";
import { FindingEvaluationRunner } from "../../src/runtime/orchestrator/finding-evaluation.ts";
import { FakeSubagentExecutor, FakeValidationExecutor } from "./index.ts";

import type { ArtifactRef } from "../../src/core/artifacts/references.ts";
import { calculateSha256 } from "../../src/runtime/persistence/artifact-store.ts";

export function implementationEvidence(
  approvedPlanRef: ArtifactRef<"plan">,
  executionRoutingRef: ArtifactRef<"execution-routing">,
) {
  return {
    schemaVersion: 1 as const,
    implementationRevision: 1,
    approvedPlanRef,
    executionRoutingRef,
    executionProfile: {
      provider: "fake",
      model: "standard",
      thinking: "medium",
    },
    repository: { outputSha256: calculateSha256("implementation") },
    output: "implementation",
  };
}

export const contract = {
  schemaVersion: 1 as const,
  checks: [
    {
      id: "tests",
      type: "command" as const,
      command: "pnpm test",
      cwd: ".",
      required: true,
    },
  ],
};
export const plan = `# Plan\n## Scope / Requirements\nPreserve the public API.\n## Architecture / Design\nKeep decisions in core.\n## Implementation Plan\nAdd a regression test.\n## Validation Contract\n\`\`\`orchestrator-validation\n${JSON.stringify(contract)}\n\`\`\``;
export const configuration: OrchestratorConfiguration = {
  decision: { autoDecisionThreshold: 0.8, escalationThreshold: 0.5 },
  executionProfiles: {
    ECONOMY: { provider: "fake", model: "economy" },
    STANDARD: { provider: "fake", model: "standard" },
    STRONG: { provider: "fake", model: "strong" },
  },
  reasoningMapping: { LOW: "low", MEDIUM: "medium", HIGH: "high" },
  retries: { maxAutomatedFixRounds: 3, maxStrongerRetries: 1 },
  validation: { stopOnInfrastructureFailure: true },
  jev: {},
};
export const decisionEvidence = {
  plan: {
    ref: {
      kind: "plan" as const,
      path: "plans/plan-v1.md",
      schemaVersion: 1 as const,
      sha256: "a".repeat(64),
    },
    content: plan,
  },
  architecture: "included-in-plan" as const,
  implementation: {
    ref: {
      kind: "implementation" as const,
      path: "implementation/result.md",
      schemaVersion: 1 as const,
      sha256: "b".repeat(64),
    },
    content: "implementation evidence",
  },
  counters: {
    automatedFixRoundsUsed: 0,
    strongerRetriesUsed: 0,
    humanCodeFeedbackRounds: 0,
  },
  previousDecision: null,
};
export const reviewRefs = {
  correctness: {
    kind: "correctness-review" as const,
    path: "reviews/correctness-1.json",
    schemaVersion: 1 as const,
    sha256: "c".repeat(64),
  },
  ponytail: {
    kind: "ponytail-review" as const,
    path: "reviews/ponytail-1.json",
    schemaVersion: 1 as const,
    sha256: "d".repeat(64),
  },
};
export const roundEvidence = {
  findingSummaries: [],
  evidence: decisionEvidence,
  branch: "review-passed" as const,
  retryLimits: configuration.retries,
  currentProfile: {
    modelTier: "STANDARD" as const,
    reasoningTier: "MEDIUM" as const,
  },
  inputRefs: [],
};
export const routing = {
  modelTier: { value: "STANDARD" as const, confidence: 0.99 },
  reasoningTier: { value: "MEDIUM" as const, confidence: 0.99 },
};
export const succeeded = (output: string) => ({
  type: "result" as const,
  value: {
    status: "succeeded" as const,
    runId: subagentRunId("fake-worker"),
    output,
  },
});
export const gate: PlannotatorGate = {
  openPlanReview: async (input) => ({
    ...input,
    reviewId: plannotatorReviewId(`plan-${input.planVersion}`),
  }),
  getPlanReview: async (_id, binding) => {
    if (!binding) throw Error("missing binding");
    return { ...binding, status: "approved" };
  },
  openCodeReview: async (input) => ({
    ...input,
    reviewId: plannotatorReviewId(`code-${input.implementationRevision}`),
  }),
  getCodeReview: async (_id, binding) => {
    if (!binding) throw Error("missing binding");
    return { ...binding, status: "approved" };
  },
};
export async function scenario(jev: JevDecisionClient) {
  const root = await mkdtemp(join(tmpdir(), "phase-c-authority-"));
  const repositoryCwd = join(root, "repo");
  await mkdir(repositoryCwd);
  await promisify(execFile)("git", ["init", "--quiet", repositoryCwd]);
  const planningExecutor = new FakeSubagentExecutor({
    run: [succeeded("repository facts"), succeeded(plan)],
  });
  const started = await startWorkflow(
    { task: "Implement safely", playbook: "feature", cwd: repositoryCwd },
    {
      runsDirectory: root,
      subagentExecutor: planningExecutor,
      workflowIdFactory: () => "scenario",
    },
  );
  const planning = new PlanningOrchestrator({
    ...started,
    subagentExecutor: planningExecutor,
    plannotatorGate: gate,
  });
  const created = await planning.createPlan({ state: started.state });
  const approved = await planning.reconcilePlanReview({
    state: created.state,
    reviewId: created.planReview!.reviewId,
  });
  const deps = {
    ...started,
    configuration: {
      ...configuration,
      jev: jevPolicy(started.state.workflowId, started.state.projectRoot),
    },
    repositoryCwd,
    jevDecisionClient: jev,
    plannotatorGate: gate,
    subagentExecutor: new FakeSubagentExecutor({
      run: succeeded("implementation evidence: preserve public API"),
    }),
  };
  const coding = new CodingOrchestrator(deps);
  const implementation = await coding.execute({ state: approved.state });
  const validate = async (state: WorkflowState, failed = false) =>
    new ValidationRunner({
      ...started,
      validationExecutor: new FakeValidationExecutor({
        execute: {
          type: "result",
          value: {
            status: failed ? "failed" : "passed",
            checks: [
              {
                id: "tests",
                status: failed ? "failed" : "passed",
                exitCode: failed ? 1 : 0,
              },
            ],
          },
        },
      }),
    }).execute({ state });
  const validated = await validate(implementation.state);
  const review = async (state: WorkflowState) =>
    new ReviewRunner({
      ...started,
      subagentExecutor: new FakeSubagentExecutor({
        runParallel: {
          type: "result",
          value: (["correctness", "ponytail"] as const).map(
            (source) =>
              succeeded(
                JSON.stringify({
                  schemaVersion: 1,
                  round: state.coding.reviewRound,
                  source,
                  findings: [],
                }),
              ).value,
          ),
        },
      }),
    }).execute({ state });
  const reviewed = await review(validated.state);
  const evaluate = async (state: WorkflowState) =>
    new FindingEvaluationRunner(deps).execute({ state });
  const evaluated = await evaluate(reviewed.state);
  return {
    root,
    ...deps,
    coding,
    validate,
    review,
    evaluate,
    approved: approved.state,
    implementation,
    validated,
    reviewed,
    evaluated,
  };
}
