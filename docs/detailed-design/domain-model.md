# Pi Orchestrator Domain Model

Version: 2.0 — v1 target contract (Issue #3)

## 1. Purpose / compatibility

This document is the canonical domain shape for the v1 redesign, not a claim that current v0.1.0 schemas already support it。Core remains independent of Pi / pi-subagents / Plannotator / classifier SDK / filesystem / transport types。Implementation/migration belongs to the child Issues in [Implementation Plan](../implementation/implementation-plan.md)。Missing legacy execution-critical identity must fail closed, not default into permission。

## 2. Identifiers

```ts
type Brand<T, B extends string> = T & { readonly __brand: B };
type WorkflowId = Brand<string, "WorkflowId">;
type SubagentRunId = Brand<string, "SubagentRunId">;
type PlannotatorReviewId = Brand<string, "PlannotatorReviewId">;
type AttemptId = Brand<string, "AttemptId">;
```

Code Review uses local AttemptId, **not** an external PlannotatorReviewId。Request correlation IDs, preflight placeholder IDs and actual run IDs are never interchangeable。

## 3. Artifact Reference

```ts
export type ArtifactKind =
  | "task"
  | "scout"
  | "diagnosis"
  | "research"
  | "conditional-stage"
  | "clarification-mode"
  | "clarification"
  | "domain-document-write"
  | "development-method"
  | "plan"
  | "plan-simplicity-review"
  | "plan-review"
  | "oracle-advisory"
  | "agent-launch"
  | "execution-routing"
  | "jev-request"
  | "workspace-evidence"
  | "implementation"
  | "plan-deviation"
  | "validation"
  | "correctness-review"
  | "ponytail-review"
  | "finding-evaluation"
  | "accepted-findings"
  | "round-decision"
  | "code-review-attempt"
  | "code-review"
  | "reconciliation";

export interface ArtifactRef<K extends ArtifactKind = ArtifactKind> {
  kind: K;
  path: string;
  schemaVersion: number;
  sha256: string;
}
```

The same kind catalog/path/freshness contract lives in [Artifacts](../basic-design/artifacts.md)。Exact identity includes all four fields。Schema migration must be explicit; do not reinterpret legacy kind/shape as new authority。

## 4. Workflow Phase

Identical to [State Machine §2](../basic-design/state-machine.md#2-workflow-phase)。No new mandatory Oracle/TDD/Diagnosis linear phase。

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

Logical contract below; exact persisted schemaVersion/migration is implementation-owned and must distinguish legacy State safely。

```ts
interface WorkflowState {
  schemaVersion: number;
  workflowId: WorkflowId;
  stateRevision: number;
  projectRoot: string;
  playbook: "new-project" | "feature" | "bugfix" | "hotfix" | "chore";
  phase: WorkflowPhase;
  taskRef: ArtifactRef<"task">;
  planning: PlanningState;
  coding: CodingState;
  counters: RetryCounters;
  ownershipRef: ArtifactRef<"reconciliation">;
  jevUsage: {
    authorizationRef?: ArtifactRef<"jev-request">;
    attemptsReserved: number;
    latestRequestRef?: ArtifactRef<"jev-request">;
    latestUsageRef?: ArtifactRef<"jev-request">;
  };
  latestOracleRef?: ArtifactRef<"oracle-advisory">;
  oracleAttemptsUsed: number;
  external: Record<string, string>;
  block?: { blockedFrom: WorkflowPhase; reason: BlockedReason; evidenceRef?: ArtifactRef };
  failure?: { reason: FailureReason; evidenceRef?: ArtifactRef };
  createdAt: string;
  updatedAt: string;
}
```

Ownership projection binds active canonical workspace + root session + workflow identity and narrowly scoped write authority。A reconciliation-kind ownership record is lifecycle evidence, never a Human approval。Classifier authorization captures workflow-scoped grant/consent after workflowId creation; API credentials stay outside domain data。#11 stores the immutable `recordType: authorization` as `jevUsage.authorizationRef` before its first reservation; reservation/usage records bind that ref and grant/consent IDs. Missing legacy binding/accounting does not default into permission or reset spent attempts. See [configuration](../basic-design/configuration.md#6-operatorproject-grant-vs-workflow-consent-11).

## 6. Planning State

```ts
type StagePolicy = "required" | "conditional" | "skip";
type ConditionalStage = "research" | "clarification" | "architecture";
type ClarificationMode = "SKIP" | "GRILL_ME" | "GRILL_WITH_DOCS" | "ESCALATE";
type DevelopmentMethod = "STANDARD" | "TDD";

interface PlanningState {
  context: {
    scoutRef?: ArtifactRef<"scout">;
    diagnosisRef?: ArtifactRef<"diagnosis">;
    researchRef?: ArtifactRef<"research">;
    clarificationRef?: ArtifactRef<"clarification">;
    documentWriteRefs: ArtifactRef<"domain-document-write">[];
  };
  stageDecisionRefs: Partial<Record<ConditionalStage, ArtifactRef<"conditional-stage">>>;
  clarificationModeRef?: ArtifactRef<"clarification-mode">;
  developmentMethodRef?: ArtifactRef<"development-method">;
  agentAttempts: Record<string, AgentAttemptBinding>;
  cycleId: string;
  automaticRefinementsUsed: 0 | 1;
  currentPlanRef?: ArtifactRef<"plan">;
  currentPlanVersion: number;
  simplicityReviewRef?: ArtifactRef<"plan-simplicity-review">;
  planReview?: PlanReviewBinding;
  latestPlanReviewRef?: ArtifactRef<"plan-review">;
  approvedPlanRef?: ArtifactRef<"plan">;
  approvedPlanVersion?: number;
}

interface PlanReviewBinding {
  reviewId: PlannotatorReviewId;
  planRef: ArtifactRef<"plan">;
  planVersion: number;
  simplicityReviewRef: ArtifactRef<"plan-simplicity-review">;
}
```

Stage decisions are resolved sequentially against accumulated refs, not all once at start。Required/skip outcomes are deterministic, conditional is classifier-bound。Persisted old researchRequired/clarificationRequired/architectureRequired booleans cannot substitute for this evidence-driven contract。

PLAN_CREATED updates current Plan version/ref and clears approval/current review/simplicity, but preserves same-cycle refinement consumption。PLAN_REVIEW_READY requires fresh simplicity and valid method/Test Seams; only then await Human。Plan feedback/replan/deviation starts a new cycle; history remains immutable。

Plan external index `plannotator.plan-review.vN` and exact durable binding must agree before result application。Duplicate identical settled result uses current State, never cached snapshot。Changed/stale result fails; explicit approval invalidation cannot be reversed by duplicate delivery。

## 7. Coding / launch / workspace binding

```ts
interface CodingState {
  implementationRevision: number;
  reviewRound: number;
  executionRoutingRef?: ArtifactRef<"execution-routing">;
  workerAttemptRef?: ArtifactRef<"implementation">;
  implementationRef?: ArtifactRef<"implementation">;
  latestDeviationRef?: ArtifactRef<"plan-deviation">;
  validationRef?: ArtifactRef<"validation">;
  correctnessReviewRef?: ArtifactRef<"correctness-review">;
  ponytailReviewRef?: ArtifactRef<"ponytail-review">;
  findingEvaluationRef?: ArtifactRef<"finding-evaluation">;
  acceptedFindingsRef?: ArtifactRef<"accepted-findings">;
  roundDecisionRef?: ArtifactRef<"round-decision">;
  previousRoundDecisionRef?: ArtifactRef<"round-decision">;
  codeReviewAttemptRef?: ArtifactRef<"code-review-attempt">;
  latestCodeReviewRef?: ArtifactRef<"code-review">;
}

interface CodeReviewAttemptBinding {
  workflowId: WorkflowId;
  attemptId: AttemptId;
  implementationRef: ArtifactRef<"implementation">;
  implementationRevision: number;
  reviewSource:
    | { kind: "git"; workspaceRef: ArtifactRef<"workspace-evidence">; sourceDigest: string }
    | { kind: "patch"; path: string; sha256: string;
        beforeRef: ArtifactRef<"workspace-evidence">; afterRef: ArtifactRef<"workspace-evidence"> };
}

interface AgentAttemptBinding {
  attemptId: AttemptId;
  requestId: string;
  inputRefs: ArtifactRef[];
  launchRef: ArtifactRef<"agent-launch">;
  runId?: SubagentRunId;
  receiptRef?: ArtifactRef<"agent-launch">;
  status: "intent" | "running" | "succeeded" | "failed" | "ambiguous";
}
```

Code attempt is saved BEFORE synchronous public request。No code external reviewId/status index。Result binds exact local attempt / current implementation / unchanged review source; new implementation invalidates old attempt/result。Lost result or source drift cannot become approval。

Agent launch projection records physical model/thinking、explicit skills、effective callable tools/extensions、Agent definition digest、inheritance/trust expectation、package/lifecycle version、launchContractDigest/input/output binding。Receipt must match historical launch; model drift cannot silently reuse/relaunch an attempt。

Workspace evidence has explicit git/filesystem variants and durable before/after manifests/content identity under canonical root。Missing baseline bytes needed for non-Git static patch blocks; Worker prose hash is not workspace identity。

Material deviation invalidates approvedPlanRef/version and current coding routing/review/gate authority, retains observed workspace and previous round history, then returns through Planning/simplicity/Human Gate。Local approved-strategy details do not require replan。

## 8. Retry Counters

```ts
interface RetryCounters {
  automatedFixRoundsUsed: number;
  strongerRetriesUsed: number;
  humanCodeFeedbackRounds: number;
}
```

Initial Worker does not charge a fix。RETRY_REQUIRED / REVIEW_RETRY_REQUIRED charge automatedFixRoundsUsed; STRONGER_RETRY_REQUIRED charges both automated + stronger; CODE_FEEDBACK charges Human counter only。

Planning refinement 0/1 and finite Oracle/classifier attempts are separate durable budgets, not reset by candidate version/client recreation。

## 9. Workflow Events

These are the canonical names used by [State Machine §3](../basic-design/state-machine.md#3-event-model)。Payloads use exact ArtifactRef, not untyped path strings。

```ts
export type WorkflowEvent =
  | { type: "SCOUT_PERSISTED"; scoutRef: ArtifactRef<"scout"> }
  | { type: "DIAGNOSIS_PERSISTED"; diagnosisRef: ArtifactRef<"diagnosis"> }
  | { type: "STAGE_RESOLVED"; stage: ConditionalStage; decisionRef: ArtifactRef<"conditional-stage"> }
  | { type: "CLARIFICATION_ROUTED"; modeRef: ArtifactRef<"clarification-mode"> }
  | { type: "CONTEXT_READY" }
  | { type: "CLARIFICATION_REQUIRED"; reasonRef?: ArtifactRef; modeRef: ArtifactRef<"clarification-mode"> }
  | { type: "CLARIFICATION_COMPLETE"; clarificationRef: ArtifactRef<"clarification"> }
  | { type: "DEVELOPMENT_METHOD_RESOLVED"; methodRef: ArtifactRef<"development-method"> }
  | { type: "PLAN_CREATED"; planRef: ArtifactRef<"plan">; version: number }
  | { type: "PLAN_SIMPLICITY_REVIEWED"; reviewRef: ArtifactRef<"plan-simplicity-review"> }
  | { type: "PLAN_REFINEMENT_REQUESTED"; reviewRef: ArtifactRef<"plan-simplicity-review"> }
  | { type: "PLAN_REVIEW_READY"; planRef: ArtifactRef<"plan">; simplicityRef: ArtifactRef<"plan-simplicity-review"> }
  | { type: "PLAN_APPROVED"; planRef: ArtifactRef<"plan">; version: number; reviewRef: ArtifactRef<"plan-review"> }
  | { type: "PLAN_FEEDBACK"; feedbackRef: ArtifactRef<"plan-review"> }
  | { type: "REPLAN_REQUIRED"; decisionRef: ArtifactRef<"round-decision"> | ArtifactRef<"plan-deviation"> }
  | { type: "EXECUTION_ROUTED"; decisionRef: ArtifactRef<"execution-routing"> }
  | { type: "PLAN_DEVIATION_REPORTED"; deviationRef: ArtifactRef<"plan-deviation"> }
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

Event names are not third-party API commands。Evidence-ref updates / reservations / launch receipts are guarded persisted updates, not inferred approval events。

## 10. Pure transition / Plan logical content

```ts
export type TransitionResult =
  | { ok: true; state: WorkflowState }
  | { ok: false; error: TransitionError };
export function transition(state: WorkflowState, event: WorkflowEvent): TransitionResult;
```

No I/O inside transition。Guards validate exact authority and persisted evidence before side effects。

Plan content is Scope / Requirements、Architecture / Design when RUN、Implementation Approach、Expected Change Surface、New Components、New Dependencies、Non-goals、Development Method、Test Seams when TDD、machine-readable Validation Contract。Strategy boundary is not a frozen implementation script。

## 11. Findings / decisions

```ts
interface ReviewFinding {
  id: string;
  source: "correctness" | "ponytail";
  category: string;
  location?: string;
  summary: string;
  evidence: string;
  blocking: boolean;
}
interface Decision<T> { value: T; confidence: number }
type DecisionResult<T> =
  | { status: "decided"; decision: Decision<T> }
  | { status: "uncertain"; reason: string };
type ModelTier = "ECONOMY" | "STANDARD" | "STRONG";
type ReasoningTier = "LOW" | "MEDIUM" | "HIGH";
type RoundAction = "COMPLETE" | "RETRY" | "ESCALATE";
type EscalationReason = "implementation-capability" | "plan-conflict" | "human-decision" | "uncertain";
type NormalizedRoundDecision =
  | { action: Decision<"COMPLETE" | "RETRY"> }
  | { action: Decision<"ESCALATE">; escalationReason: Decision<EscalationReason> };
```

Plan simplicity uses a separate evidence-backed strategy finding contract, exact Plan binding and repository locations; it is not accepted post-code Fix authority。Oracle evidence is also separate。Current passed-round completeness and action/reason precedence remain [Coding B1/B4](./coding-orchestration.md#policy-precedence-b4)。

All classifier families share decision schema/classifier identity/input refs/digest/policy/config/relevant revision freshness。Deterministic required/skip and explicit method requests record no classifier call; this absence is explicit。

## 12. Blocked / Failed Reasons

```ts
type BlockedReason =
  | "integration-unavailable"
  | "agent-infrastructure-unavailable"
  | "agent-execution-ambiguous"
  | "human-gate-unavailable"
  | "validation-infrastructure-error"
  | "retry-budget-exhausted"
  | "stronger-profile-unavailable"
  | "operator-attention-required";
type FailureReason =
  | "state-corrupt"
  | "authoritative-artifact-missing"
  | "authoritative-artifact-corrupt"
  | "invalid-transition"
  | "authority-inconsistent"
  | "persistence-consistency-failure";
```

Missing launch/consent/capability or ambiguous possible mutation fails closed to blocked/explicit recovery。Failed is terminal only when safe authority reconstruction is impossible。No Human Gate inference/migration default。
