# Pi Orchestrator Domain Model

Version: 1.2

## 1. Purpose

This document defines the TypeScript domain model used by pi-orchestrator's Initial Scope.

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
  | "jev-request"
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

The phase type remains identical to Basic Design (document revision 1.0).

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

  // Durable runtime scope/accounting; missing legacy values deny Jev dispatch.
  projectRoot?: string;
  jevUsage?: {
    attemptsReserved: number;
    latestRequestRef?: ArtifactRef<"jev-request">;
    latestUsageRef?: ArtifactRef<"jev-request">;
  };

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

  // Resolved once at start and persisted before any child side effect.
  // Optional only so legacy State can be loaded for diagnosis; runners fail closed if missing.
  researchRequired?: boolean;
  clarificationRequired?: boolean;
  architectureRequired?: boolean;

  // Evidence binding for the current Plan, not implementation authority.
  planReview?: PlanReviewBinding;

  currentPlanRef?: ArtifactRef<"plan">;
  currentPlanVersion: number;

  approvedPlanRef?: ArtifactRef<"plan">;
  approvedPlanVersion?: number;

  latestPlanReviewRef?: ArtifactRef<"plan-review">;
}
```

```ts
export interface PlanReviewBinding {
  reviewId: PlannotatorReviewId;
  planRef: ArtifactRef<"plan">;
  planVersion: number;
}
```

```ts
export type ExternalIdentities = Record<string, string>;
```

For Plan review, `external["plannotator.plan-review.vN"]` stores the reviewId for version N. The Orchestrator persists this index and `planning.planReview` together; the external index is not a separate source of approval authority.

`planReview` must match `currentPlanRef` (kind, path, schemaVersion, and sha256), `currentPlanVersion`, and `external["plannotator.plan-review.vN"]`. An external identity string alone is not sufficient to reconstruct the binding. `PLAN_CREATED` clears the current binding; historical external identities and immutable artifacts remain evidence.

The three resolved policy flags are workflow-specific decisions, not a replacement for Configuration or a switch to bypass Human Gates. New workflows persist all three before the first child; context gathering and plan creation require them after restart / `BLOCK_RESOLVED`. Missing legacy flags remain diagnosable but must not be guessed or defaulted to skip.

`latestPlanReviewRef` records the exact settled result artifact for either approval or feedback. Duplicate results compare this ref, including its digest, and return the caller's current State without mutation. It does not grant implementation authority.

`approvedPlanRef` is the only implementation authority.

On `REPLAN_REQUIRED`, approval authority and `latestPlanReviewRef` are cleared but historical artifacts are retained. An old approval delivered after this explicit invalidation is stale, not an ordinary duplicate no-op, and cannot restore implementation authority.

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

  // Lifecycle evidence; not a successful implementation result.
  workerAttemptRef?: ArtifactRef<"implementation">;
  codeReview?: CodeReviewBinding;
  latestCodeReviewRef?: ArtifactRef<"code-review">;
}

export interface CodeReviewBinding {
  reviewId: PlannotatorReviewId;
  implementationRef: ArtifactRef<"implementation">;
  implementationRevision: number;
}
```

`codeReview` and `external["plannotator.code-review.rN"]` are persisted together before a usable review handle is returned. The exact tuple must match the current implementation ref (including digest) and revision; an external identity alone cannot reconstruct it. New implementation completion clears the current Code Review binding/result but retains historical evidence. Missing/mismatched bindings reject both direct result application and reconciliation; they never grant Completion Authority (B5).

`workerAttemptRef` points to the latest immutable lifecycle observation defined in [Worker Attempt Evidence](./persistence-recovery.md#61-worker-attempt-evidence-i2). Pending, failed, or ambiguous records cannot populate `implementationRef` as success. Known external run IDs and request correlation survive failure; they do not themselves authorize another Worker (I2).

Current review evidence is bound to workflow, approved Plan/version, exact implementation ref/revision, and review round. Passed validation requires correctness review, ponytail review, evaluation, and accepted-findings, even when all findings arrays are empty. In the ordinary pass/fail pipeline, only a deterministic failed-validation round can omit review evidence, and it cannot complete (B1). Infrastructure-error is a separate blocked/Human-attention path under I3, never a clean review round.

Decision artifacts carry the [mandatory freshness header](./persistence-recovery.md#7-decision-artifact-header), and durable history retains the previous round decision link across clearing current-round refs (I1/B3). No new Workflow phase, Human authority, or third-party type is introduced.

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
  | { type: "PLAN_APPROVED"; planRef: ArtifactRef<"plan">; version: number; reviewRef: ArtifactRef<"plan-review"> }
  | { type: "PLAN_FEEDBACK"; feedbackRef: ArtifactRef<"plan-review"> }
  | { type: "REPLAN_REQUIRED"; decisionRef: ArtifactRef<"round-decision"> }
  | { type: "EXECUTION_ROUTED"; decisionRef: ArtifactRef<"execution-routing"> }
  | { type: "IMPLEMENTATION_COMPLETE"; resultRef: ArtifactRef<"implementation">; runId?: SubagentRunId }
  | { type: "VALIDATION_PASSED"; resultRef: ArtifactRef<"validation"> }
  | { type: "REVIEW_ARTIFACTS_PERSISTED"; correctnessReviewRef: ArtifactRef<"correctness-review">; ponytailReviewRef: ArtifactRef<"ponytail-review"> }
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

export type NormalizedRoundDecision =
  | { action: Decision<"COMPLETE" | "RETRY"> }
  | {
      action: Decision<"ESCALATE">;
      escalationReason: Decision<EscalationReason>;
    };
```

Action and required escalation reason retain separate confidence through normalization, core policy, and persisted decision evidence. The resulting policy outcome records why it differs from the raw decision; a high action confidence cannot replace reason confidence. [Policy Precedence](./coding-orchestration.md#policy-precedence-b4) applies to RETRY and ESCALATE as well as COMPLETE (B4).

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
