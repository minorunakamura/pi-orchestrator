# Pi Orchestrator Domain Model

Version: 1.0

## 1. Purpose

This document defines the TypeScript domain model used by pi-orchestrator v1.0.

`core/` must remain independent of Pi, pi-subagents, Plannotator, TypeSafe/Jev SDKs, filesystem APIs, and transport-specific types.

## 2. Branded Identifiers

```ts
type Brand<T, B extends string> = T & {
  readonly __brand: B;
};

export type WorkflowId = Brand<string, "WorkflowId">;
export type SubagentRunId = Brand<string, "SubagentRunId">;
export type PlannotatorReviewId = Brand<string, "PlannotatorReviewId">;
```

## 3. Artifact Reference

State stores references, not long-form artifact bodies.

```ts
export type ArtifactKind =
  | "task"
  | "scout"
  | "research"
  | "clarification"
  | "plan"
  | "plan-review"
  | "execution-routing"
  | "implementation"
  | "validation"
  | "correctness-review"
  | "ponytail-review"
  | "finding-evaluation"
  | "accepted-findings"
  | "round-decision"
  | "code-review"
  | "reconciliation";

export interface ArtifactRef<K extends ArtifactKind = ArtifactKind> {
  kind: K;
  path: string;
  schemaVersion: number;
  sha256: string;
}
```

`sha256` is part of the reference so that freshness is based on content identity rather than only a path.

## 4. Workflow Phase

The phase type remains identical to Basic Design v1.0.

```ts
export type WorkflowPhase =
  | "gathering-context"
  | "clarifying"
  | "planning"
  | "awaiting-plan-review"
  | "implementing"
  | "validating"
  | "reviewing"
  | "fixing"
  | "awaiting-code-review"
  | "blocked"
  | "completed"
  | "failed";
```

## 5. Workflow State

```ts
export interface WorkflowState {
  schemaVersion: 1;

  workflowId: WorkflowId;
  stateRevision: number;

  playbook: PlaybookKind;
  phase: WorkflowPhase;

  taskRef: ArtifactRef<"task">;

  planning: PlanningState;
  coding: CodingState;

  counters: RetryCounters;
  external: ExternalIdentities;

  block?: BlockState;
  failure?: FailureState;

  createdAt: string;
  updatedAt: string;
}
```

## 6. Planning State

```ts
export interface PlanningState {
  context: {
    scoutRef?: ArtifactRef<"scout">;
    researchRef?: ArtifactRef<"research">;
    clarificationRef?: ArtifactRef<"clarification">;
  };

  currentPlanRef?: ArtifactRef<"plan">;
  currentPlanVersion: number;

  approvedPlanRef?: ArtifactRef<"plan">;
  approvedPlanVersion?: number;

  latestPlanReviewRef?: ArtifactRef<"plan-review">;
}
```

`approvedPlanRef` is the only implementation authority.

On `REPLAN_REQUIRED`, approval authority is invalidated but historical artifacts are retained.

## 7. Coding State

```ts
export interface CodingState {
  implementationRevision: number;
  reviewRound: number;

  executionRoutingRef?: ArtifactRef<"execution-routing">;
  implementationRef?: ArtifactRef<"implementation">;
  validationRef?: ArtifactRef<"validation">;

  correctnessReviewRef?: ArtifactRef<"correctness-review">;
  ponytailReviewRef?: ArtifactRef<"ponytail-review">;

  findingEvaluationRef?: ArtifactRef<"finding-evaluation">;
  acceptedFindingsRef?: ArtifactRef<"accepted-findings">;
  roundDecisionRef?: ArtifactRef<"round-decision">;

  latestCodeReviewRef?: ArtifactRef<"code-review">;
}
```

## 8. Retry Counters

```ts
export interface RetryCounters {
  automatedFixRoundsUsed: number;
  strongerRetriesUsed: number;
  humanCodeFeedbackRounds: number;
}
```

Rules:

- Initial implementation does not increment `automatedFixRoundsUsed`.
- `RETRY_REQUIRED` increments `automatedFixRoundsUsed`.
- `REVIEW_RETRY_REQUIRED` increments `automatedFixRoundsUsed`.
- `STRONGER_RETRY_REQUIRED` increments both `automatedFixRoundsUsed` and `strongerRetriesUsed`.
- `CODE_FEEDBACK` increments only `humanCodeFeedbackRounds`.

## 9. Workflow Events

Basic Design event names are preserved.

```ts
export type WorkflowEvent =
  | { type: "CONTEXT_READY" }
  | { type: "CLARIFICATION_REQUIRED"; reasonRef?: ArtifactRef }
  | { type: "CLARIFICATION_COMPLETE"; clarificationRef: ArtifactRef<"clarification"> }
  | { type: "PLAN_CREATED"; planRef: ArtifactRef<"plan">; version: number }
  | { type: "PLAN_APPROVED"; planRef: ArtifactRef<"plan">; version: number }
  | { type: "PLAN_FEEDBACK"; feedbackRef: ArtifactRef<"plan-review"> }
  | { type: "REPLAN_REQUIRED"; decisionRef: ArtifactRef<"round-decision"> }
  | { type: "EXECUTION_ROUTED"; decisionRef: ArtifactRef<"execution-routing"> }
  | { type: "IMPLEMENTATION_COMPLETE"; resultRef: ArtifactRef<"implementation">; runId?: SubagentRunId }
  | { type: "VALIDATION_PASSED"; resultRef: ArtifactRef<"validation"> }
  | { type: "RETRY_REQUIRED"; decisionRef: ArtifactRef<"round-decision">; findingsRef?: ArtifactRef<"accepted-findings">; validationRef?: ArtifactRef<"validation"> }
  | { type: "REVIEW_RETRY_REQUIRED"; decisionRef: ArtifactRef<"round-decision">; findingsRef?: ArtifactRef<"accepted-findings"> }
  | { type: "STRONGER_RETRY_REQUIRED"; decisionRef: ArtifactRef<"round-decision">; findingsRef?: ArtifactRef<"accepted-findings"> }
  | { type: "REVIEW_COMPLETE"; decisionRef: ArtifactRef<"round-decision"> }
  | { type: "CODE_APPROVED"; reviewRef: ArtifactRef<"code-review"> }
  | { type: "CODE_FEEDBACK"; feedbackRef: ArtifactRef<"code-review"> }
  | { type: "BLOCK"; reason: BlockedReason; evidenceRef?: ArtifactRef }
  | { type: "BLOCK_RESOLVED"; evidenceRef?: ArtifactRef<"reconciliation"> }
  | { type: "FAIL"; reason: FailureReason; evidenceRef?: ArtifactRef };
```

## 10. Transition Contract

State transition is a pure function.

```ts
export type TransitionResult =
  | { ok: true; state: WorkflowState }
  | { ok: false; error: TransitionError };

export function transition(
  state: WorkflowState,
  event: WorkflowEvent,
): TransitionResult;
```

`transition()` must not access filesystem, network, Pi, shell, Jev, pi-subagents, or Plannotator.

## 11. Review Finding

```ts
export interface ReviewFinding {
  id: string;
  source: "correctness" | "ponytail";
  category: string;
  location?: string;
  summary: string;
  evidence: string;
  blocking: boolean;
}
```

`blocking` is reviewer evidence only; it does not grant fix authority.

## 12. Decision Contract

```ts
export interface Decision<T> {
  value: T;
  confidence: number;
}

export type DecisionResult<T> =
  | { status: "decided"; decision: Decision<T> }
  | { status: "uncertain"; reason: string };
```

### Execution Routing

```ts
export type ModelTier = "ECONOMY" | "STANDARD" | "STRONG";
export type ReasoningTier = "LOW" | "MEDIUM" | "HIGH";

export interface ExecutionRoutingDecision {
  modelTier: Decision<ModelTier>;
  reasoningTier: Decision<ReasoningTier>;
  effectiveConfidence: number;
}
```

### Finding Evaluation

```ts
export interface FindingEvaluation {
  findingId: string;
  evidenceSupported: Decision<boolean>;
  conflictsWithApprovedPlan: Decision<boolean>;
  conflictsWithArchitecture: Decision<boolean>;
  inScope: Decision<boolean>;
  requiresHumanDecision: Decision<boolean>;
  decision: "ACCEPT" | "REJECT" | "ESCALATE";
  reasonCode: FindingDecisionReason;
}
```

### Round Decision

```ts
export type RoundAction = "COMPLETE" | "RETRY" | "ESCALATE";

export type EscalationReason =
  | "implementation-capability"
  | "plan-conflict"
  | "human-decision"
  | "uncertain";
```

## 13. Blocked / Failed Reasons

```ts
export type BlockedReason =
  | "integration-unavailable"
  | "agent-infrastructure-unavailable"
  | "agent-execution-ambiguous"
  | "human-gate-unavailable"
  | "validation-infrastructure-error"
  | "retry-budget-exhausted"
  | "stronger-profile-unavailable"
  | "operator-attention-required";

export type FailureReason =
  | "state-corrupt"
  | "authoritative-artifact-missing"
  | "authoritative-artifact-corrupt"
  | "invalid-transition"
  | "authority-inconsistent"
  | "persistence-consistency-failure";
```
