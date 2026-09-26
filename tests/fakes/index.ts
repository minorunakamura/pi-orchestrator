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
  ValidationResult,
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

  run(input: AgentRunRequest): Promise<AgentRunResult> {
    this.calls.run.push(input);
    return resolve(
      "SubagentExecutor.run",
      this.outcomes.run,
      this.calls.run.length - 1,
    );
  }

  runParallel(inputs: AgentRunRequest[]): Promise<AgentRunResult[]> {
    this.calls.runParallel.push([...inputs]);
    return resolve(
      "SubagentExecutor.runParallel",
      this.outcomes.runParallel,
      this.calls.runParallel.length - 1,
    );
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
  routeExecution?: FakeSequence<ExecutionRoutingRawDecision>;
  evaluateFindings?: FakeSequence<FindingEvaluationRawDecision[]>;
  decideRound?: FakeSequence<RoundDecisionRawDecision>;
}

export class FakeJevDecisionClient implements JevDecisionClient {
  readonly calls = {
    routeExecution: [] as ExecutionRoutingInput[],
    evaluateFindings: [] as FindingEvaluationInput[],
    decideRound: [] as RoundDecisionInput[],
  };

  constructor(private readonly outcomes: FakeJevDecisionClientOptions = {}) {}

  routeExecution(
    input: ExecutionRoutingInput,
  ): Promise<ExecutionRoutingRawDecision> {
    this.calls.routeExecution.push(input);
    return resolve(
      "JevDecisionClient.routeExecution",
      this.outcomes.routeExecution,
      this.calls.routeExecution.length - 1,
    );
  }

  evaluateFindings(
    input: FindingEvaluationInput,
  ): Promise<FindingEvaluationRawDecision[]> {
    this.calls.evaluateFindings.push(input);
    return resolve(
      "JevDecisionClient.evaluateFindings",
      this.outcomes.evaluateFindings,
      this.calls.evaluateFindings.length - 1,
    );
  }

  decideRound(input: RoundDecisionInput): Promise<RoundDecisionRawDecision> {
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
  execute?: FakeSequence<ValidationResult>;
}

export class FakeValidationExecutor implements ValidationExecutor {
  readonly calls: ValidationContract[] = [];

  constructor(private readonly outcomes: FakeValidationExecutorOptions = {}) {}

  execute(contract: ValidationContract): Promise<ValidationResult> {
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
