import type {
  ConditionalStage,
  StageOutcome,
  ClarificationMode,
} from "../../src/core/decisions/planning-routing.ts";
import type {
  ConditionalStageRoutingInput,
  PlanningClassifierInput,
} from "../../src/runtime/ports/jev-decision-client.ts";
import { calculateSha256 } from "../../src/runtime/persistence/artifact-store.ts";
import { fakeLaunchResolver } from "./agent-launch.ts";
import type {
  ClarificationPort,
  ClarificationRequest,
  ClarificationResult,
  CodeReviewHandle,
  CodeReviewRequest,
  CodeReviewStatus,
  ExecutionRoutingInput,
  ExecutionRoutingRawDecision,
  FindingEvaluationInput,
  FindingEvaluationRawDecision,
  JevDecisionClient,
  JevCallAuthorization,
  PlanReviewHandle,
  PlanReviewRequest,
  PlanReviewStatus,
  PlannotatorGate,
  RoundDecisionInput,
  RoundDecisionRawDecision,
  SubagentExecutor,
  AgentRunRequest,
  AgentRunResult,
  AgentRunStatus,
  ValidationExecutor,
} from "../../src/runtime/ports/index.ts";
import {
  RuntimePortError,
  type PortFailureKind,
} from "../../src/runtime/ports/index.ts";
import type { SubagentRunId, PlannotatorReviewId } from "../../src/types.ts";
import type {
  ValidationContract,
  ValidationExecutionResult,
} from "../../src/core/decisions/types.ts";

export type FakeOutcome<T> =
  | { type: "result"; value: T }
  | { type: "error"; error: RuntimePortError };
export type FakeSequence<T> = FakeOutcome<T> | readonly FakeOutcome<T>[];

export function failure(
  kind: PortFailureKind,
  message = `fake ${kind} failure`,
): FakeOutcome<never> {
  return {
    type: "error",
    error: new RuntimePortError(kind, message),
  };
}

function resolve<T>(
  operation: string,
  outcome: FakeSequence<T> | undefined,
  callIndex: number,
): Promise<T> {
  const selected = Array.isArray(outcome) ? outcome[callIndex] : outcome;
  if (!selected) {
    return Promise.reject(
      new RuntimePortError(
        "infrastructure",
        `No fake outcome configured for ${operation} call ${callIndex + 1}`,
      ),
    );
  }
  if (selected.type === "error") return Promise.reject(selected.error);
  return Promise.resolve(selected.value);
}

export interface FakeSubagentExecutorOptions {
  run?: FakeSequence<AgentRunResult>;
  runParallel?: FakeSequence<AgentRunResult[]>;
  status?: FakeSequence<AgentRunStatus>;
  resume?: FakeSequence<AgentRunResult>;
}

export class FakeSubagentExecutor implements SubagentExecutor {
  readonly calls = {
    run: [] as AgentRunRequest[],
    runParallel: [] as AgentRunRequest[][],
    status: [] as SubagentRunId[],
    resume: [] as { runId: SubagentRunId; task: string }[],
  };

  constructor(private readonly outcomes: FakeSubagentExecutorOptions = {}) {}

  preflight(input: AgentRunRequest) {
    return fakeLaunchResolver(input, {
      task: input.task,
      cwd: input.cwd ?? "/repo",
      output: false,
    });
  }

  async run(input: AgentRunRequest): Promise<AgentRunResult> {
    this.calls.run.push(input);
    await input.onPrepared?.(await this.preflight(input));
    const result = await resolve(
      "SubagentExecutor.run",
      this.outcomes.run,
      this.calls.run.length - 1,
    );
    if (result.runId && input.dispatch)
      await input.onStarted?.({
        requestId: input.dispatch.requestId,
        sessionId: "fixture-session",
        runId: result.runId,
        asyncDir: "/fixture/async",
        outputPath: "/fixture/output",
        cwd: input.cwd ?? "/repo",
        agent: input.agent,
        launchContractDigest: (await this.preflight(input))
          .launchContractDigest,
      });
    return result;
  }

  async runParallel(inputs: AgentRunRequest[]): Promise<AgentRunResult[]> {
    this.calls.runParallel.push([...inputs]);
    for (const input of inputs) {
      // oxlint-disable-next-line eslint/no-await-in-loop
      await input.onPrepared?.(await this.preflight(input));
    }
    const results = await resolve(
      "SubagentExecutor.runParallel",
      this.outcomes.runParallel,
      this.calls.runParallel.length - 1,
    );
    for (const [index, input] of inputs.entries()) {
      const result = results[index];
      if (result?.runId && input.dispatch) {
        // oxlint-disable-next-line eslint/no-await-in-loop
        await input.onStarted?.({
          requestId: input.dispatch.requestId,
          sessionId: "fixture-session",
          runId: result.runId,
          asyncDir: "/fixture/async",
          outputPath: "/fixture/output",
          cwd: input.cwd ?? "/repo",
          agent: input.agent,
          // oxlint-disable-next-line eslint/no-await-in-loop
          launchContractDigest: (await this.preflight(input))
            .launchContractDigest,
        });
      }
    }
    return results;
  }

  status(runId: SubagentRunId): Promise<AgentRunStatus> {
    this.calls.status.push(runId);
    return resolve(
      "SubagentExecutor.status",
      this.outcomes.status,
      this.calls.status.length - 1,
    );
  }

  resume(runId: SubagentRunId, task: string): Promise<AgentRunResult> {
    this.calls.resume.push({ runId, task });
    return resolve(
      "SubagentExecutor.resume",
      this.outcomes.resume,
      this.calls.resume.length - 1,
    );
  }
}

export interface FakeJevDecisionClientOptions {
  stages?: Partial<Record<ConditionalStage, StageOutcome>>;
  mode?: ClarificationMode;
  method?: "STANDARD" | "TDD" | "ESCALATE";
  routeExecution?: FakeSequence<ExecutionRoutingRawDecision>;
  evaluateFindings?: FakeSequence<FindingEvaluationRawDecision[]>;
  decideRound?: FakeSequence<RoundDecisionRawDecision>;
}

export class FakeJevDecisionClient implements JevDecisionClient {
  readonly calls = {
    routeStage: [] as ConditionalStageRoutingInput[],
    routeClarification: [] as PlanningClassifierInput[],
    routeDevelopmentMethod: [] as PlanningClassifierInput[],
    routeExecution: [] as ExecutionRoutingInput[],
    evaluateFindings: [] as FindingEvaluationInput[],
    decideRound: [] as RoundDecisionInput[],
  };

  constructor(private readonly outcomes: FakeJevDecisionClientOptions = {}) {}

  async routeStage(
    input: ConditionalStageRoutingInput,
    authorization?: JevCallAuthorization,
  ) {
    await authorization?.authorizeAttempt({
      family: "stage",
      requestDigest: calculateSha256(JSON.stringify(input)),
      configurationDigest: "b".repeat(64),
      decisionSchemaVersion: 1,
      destination: authorization.destination,
      retryIndex: 0,
    });
    this.calls.routeStage.push(input);
    return {
      value: this.outcomes.stages?.[input.stage] ?? "SKIP",
      confidence: 0.99,
    };
  }
  async routeDevelopmentMethod(
    input: PlanningClassifierInput,
    authorization?: JevCallAuthorization,
  ) {
    await authorization?.authorizeAttempt({
      family: "method",
      requestDigest: calculateSha256(JSON.stringify(input)),
      configurationDigest: "b".repeat(64),
      decisionSchemaVersion: 1,
      destination: authorization.destination,
      retryIndex: 0,
    });
    this.calls.routeDevelopmentMethod.push(input);
    return { value: this.outcomes.method ?? "STANDARD", confidence: 0.99 };
  }
  async routeClarification(
    input: PlanningClassifierInput,
    authorization?: JevCallAuthorization,
  ) {
    await authorization?.authorizeAttempt({
      family: "clarification",
      requestDigest: calculateSha256(JSON.stringify(input)),
      configurationDigest: "b".repeat(64),
      decisionSchemaVersion: 1,
      destination: authorization.destination,
      retryIndex: 0,
    });
    this.calls.routeClarification.push(input);
    return { value: this.outcomes.mode ?? "GRILL_ME", confidence: 0.99 };
  }

  async routeExecution(
    input: ExecutionRoutingInput,
    authorization?: JevCallAuthorization,
  ): Promise<ExecutionRoutingRawDecision> {
    await authorization?.authorizeAttempt({
      family: "routing",
      requestDigest: "a".repeat(64),
      configurationDigest: "b".repeat(64),
      decisionSchemaVersion: 1,
      destination: authorization.destination,
      retryIndex: 0,
    });
    this.calls.routeExecution.push(input);
    return resolve(
      "JevDecisionClient.routeExecution",
      this.outcomes.routeExecution,
      this.calls.routeExecution.length - 1,
    );
  }

  async evaluateFindings(
    input: FindingEvaluationInput,
    authorization?: JevCallAuthorization,
  ): Promise<FindingEvaluationRawDecision[]> {
    for (const finding of input.findings) {
      // Mirror production's ordered per-finding authorization in the fake.
      // oxlint-disable-next-line eslint/no-await-in-loop
      await authorization?.authorizeAttempt({
        family: "finding",
        requestDigest: "a".repeat(64),
        configurationDigest: "b".repeat(64),
        decisionSchemaVersion: 1,
        destination: authorization.destination,
        retryIndex: 0,
        findingId: finding.id,
      });
    }
    this.calls.evaluateFindings.push(input);
    return resolve(
      "JevDecisionClient.evaluateFindings",
      this.outcomes.evaluateFindings,
      this.calls.evaluateFindings.length - 1,
    );
  }

  async decideRound(
    input: RoundDecisionInput,
    authorization?: JevCallAuthorization,
  ): Promise<RoundDecisionRawDecision> {
    await authorization?.authorizeAttempt({
      family: "round",
      requestDigest: "a".repeat(64),
      configurationDigest: "b".repeat(64),
      decisionSchemaVersion: 1,
      destination: authorization.destination,
      retryIndex: 0,
    });
    this.calls.decideRound.push(input);
    return resolve(
      "JevDecisionClient.decideRound",
      this.outcomes.decideRound,
      this.calls.decideRound.length - 1,
    );
  }
}

export interface FakePlannotatorGateOptions {
  openPlanReview?: FakeSequence<PlanReviewHandle>;
  getPlanReview?: FakeSequence<PlanReviewStatus>;
  openCodeReview?: FakeSequence<CodeReviewHandle>;
  getCodeReview?: FakeSequence<CodeReviewStatus>;
}

export class FakePlannotatorGate implements PlannotatorGate {
  readonly calls = {
    openPlanReview: [] as PlanReviewRequest[],
    getPlanReview: [] as PlannotatorReviewId[],
    openCodeReview: [] as CodeReviewRequest[],
    getCodeReview: [] as PlannotatorReviewId[],
  };

  constructor(private readonly outcomes: FakePlannotatorGateOptions = {}) {}

  openPlanReview(input: PlanReviewRequest): Promise<PlanReviewHandle> {
    this.calls.openPlanReview.push(input);
    return resolve(
      "PlannotatorGate.openPlanReview",
      this.outcomes.openPlanReview,
      this.calls.openPlanReview.length - 1,
    );
  }

  getPlanReview(
    reviewId: PlannotatorReviewId,
    _persistedBinding?: PlanReviewHandle,
  ): Promise<PlanReviewStatus> {
    this.calls.getPlanReview.push(reviewId);
    return resolve(
      "PlannotatorGate.getPlanReview",
      this.outcomes.getPlanReview,
      this.calls.getPlanReview.length - 1,
    );
  }

  openCodeReview(input: CodeReviewRequest): Promise<CodeReviewHandle> {
    this.calls.openCodeReview.push(input);
    return resolve(
      "PlannotatorGate.openCodeReview",
      this.outcomes.openCodeReview,
      this.calls.openCodeReview.length - 1,
    );
  }

  getCodeReview(reviewId: PlannotatorReviewId): Promise<CodeReviewStatus> {
    this.calls.getCodeReview.push(reviewId);
    return resolve(
      "PlannotatorGate.getCodeReview",
      this.outcomes.getCodeReview,
      this.calls.getCodeReview.length - 1,
    );
  }
}

export interface FakeValidationExecutorOptions {
  execute?: FakeSequence<ValidationExecutionResult>;
}

export class FakeValidationExecutor implements ValidationExecutor {
  readonly calls: ValidationContract[] = [];

  constructor(private readonly outcomes: FakeValidationExecutorOptions = {}) {}

  execute(contract: ValidationContract): Promise<ValidationExecutionResult> {
    this.calls.push(contract);
    return resolve(
      "ValidationExecutor.execute",
      this.outcomes.execute,
      this.calls.length - 1,
    );
  }
}

export interface FakeClarificationPortOptions {
  request?: FakeSequence<ClarificationResult>;
}

export class FakeClarificationPort implements ClarificationPort {
  readonly calls: ClarificationRequest[] = [];

  constructor(private readonly outcomes: FakeClarificationPortOptions = {}) {}

  request(input: ClarificationRequest): Promise<ClarificationResult> {
    this.calls.push(input);
    return resolve(
      "ClarificationPort.request",
      this.outcomes.request,
      this.calls.length - 1,
    );
  }
}
