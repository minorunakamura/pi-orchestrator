# Coding Orchestration Detailed Design

Version: 1.2

## 1. Purpose

This document defines Coding Orchestration for pi-orchestrator's Initial Scope.

The Initial Scope contains exactly one Coding Orchestration.

## 2. Pipeline

```text
Approved Plan
      ↓
Jev Execution Routing
      ↓
Worker
      ↓
Implementation Artifact
      ↓
Deterministic Validation
   ┌──┴───────────────┐
 fail               pass
   │                  ↓
   │           Parallel Review
   │                  ↓
   │          Structured Findings
   │                  ↓
   │          Finding Evaluation
   │                  ↓
   └──────────→ Round Decision
                  │
          ┌───────┼─────────┐
        RETRY  COMPLETE   ESCALATE
```

## 3. Execution Routing

Jev returns logical tiers only.

```ts
export type ModelTier = "ECONOMY" | "STANDARD" | "STRONG";
export type ReasoningTier = "LOW" | "MEDIUM" | "HIGH";
```

One Jev call may evaluate both:

```text
modelTier
reasoningTier
```

Effective confidence:

```ts
const effectiveConfidence = Math.min(
  modelTier.confidence,
  reasoningTier.confidence,
);
```

Concrete provider/model/thinking is resolved by Configuration.

### Execution Routing Input Evidence

The Orchestrator/runtime assembles the Jev input after reading the immutable artifacts through its `ArtifactStore` boundary. The input preserves the authoritative refs and carries bounded evidence without making the adapter responsible for artifact access:

```ts
interface ExecutionRoutingInput {
  approvedPlanRef: ArtifactRef<"plan">;
  planEvidence: {
    summary: string;
    relevantSections: readonly {
      title: PlanSection;
      content: string;
    }[];
  };
  playbook: PlaybookKind;
  changeScope: string;
  contextRefs: readonly ArtifactRef[];
  contextEvidence: readonly {
    ref: ArtifactRef;
    content: string;
  }[];
  priorRetryCount: number;
}
```

`planEvidence` contains the Approved Plan summary and only relevant sections. `contextEvidence` contains bounded repository/context excerpts paired with their source refs. The adapter forwards these values; it does not read, hash, summarize, truncate, or substitute artifacts. Missing or unassembled evidence is an Orchestrator contract failure, not an invitation for Jev to infer from refs.

### Execution Routing Reuse (I1)

Before every reuse, including ordinary Fix and restart, runtime validates the complete [decision freshness header](./persistence-recovery.md#8-decision-freshness): schema / decision schema, Plan version, input implementation revision, exact input refs and input digest, policy digest, and configuration digest. Matching only the approved Plan is insufficient. Missing fields are stale, not legacy defaults.

A changed implementation revision, context, retry count, or relevant configuration requires a new immutable decision for the new input, followed by State persistence before Worker dispatch. Re-evaluation must not downgrade an already-required stronger profile; deterministic stronger-retry authority remains a lower bound. Full resume orchestration remains ORCH-018; this check already applies to Phase C's normal reuse paths.

## 4. Execution Routing Confidence

If confidence is at or above `autoDecisionThreshold`, use the selected logical profile.

If below threshold, the Initial Scope default is a safe stronger profile rather than silently accepting the uncertain choice.

## 5. Worker Input

```ts
export interface WorkerInput {
  approvedPlanRef: ArtifactRef<"plan">;
  contextRefs: ArtifactRef[];
  executionProfile: ExecutionProfile;
  acceptedFindingsRef?: ArtifactRef<"accepted-findings">;
  humanCodeFeedbackRef?: ArtifactRef<"code-review">;
}
```

Worker must not make unapproved Product / Architecture / Scope decisions.

## 6. Implementation Artifact

After Worker completion, persist an immutable implementation evidence artifact before emitting `IMPLEMENTATION_COMPLETE`.

The artifact should include at least:

- implementation revision
- subagent run ID when available
- approved Plan reference
- accepted findings reference when fixing
- resolved concrete execution profile
- repository / diff identity sufficient for reconciliation
- exact input implementationRef / revision, routing ref, Human Code Feedback ref when present, and the durable Worker attempt identity

### Worker Lifecycle Evidence (I2)

Success output alone is insufficient. Before dispatch, persist an immutable attempt intent and its State reference, binding the workflow/attempt, approved Plan, input and target implementation revisions, input refs, resolved profile, repository identity, pre-run mutation baseline, and public request correlation identity. Persist routing Artifact and State first, then attempt intent and State, then dispatch.

Persist the exact external runId as soon as the public integration exposes it. A requestId is not a runId. If runId is only returned at completion, keep the pre-dispatch correlation identity and explicit `unknown` launch/run status; do not invent an early run handle or require a third-party API change.

Persist success, failure, timeout, and ambiguous completion evidence, including known runId and observable repository changes, before the next stage. Worker prose hashes do not identify repository contents. An unresolved attempt prevents another Worker dispatch; ambiguity produces `BLOCK`, not guessed success or automatic relaunch. See [durable attempt contract](./persistence-recovery.md#61-worker-attempt-evidence-i2).

Phase C produces evidence and enforces these barriers. Exact external-status reconciliation, orphan discovery, and recovery decisions remain ORCH-018.

## 7. Validation

Validation executes the Approved Plan's Validation Contract.

### Validation Authority (B2)

`ValidationRunner` accepts current Workflow identity/State, not a caller-selected `ValidationContract`. It verifies the current approved Plan binding, reads that immutable Artifact with hash validation, parses its machine-readable Validation Contract, and passes that contract to `ValidationExecutor`. Missing, corrupt, stale, or invalid Plan evidence prevents command execution and cannot publish a validation pass.

Caller hints or configuration cannot replace commands, cwd, required flags, or task-specific checks. If a compatibility entry point accepts a supplied contract, it must reject any difference from the parsed authoritative contract before execution; the supplied object is never authority.

```ts
export type ValidationCheckStatus =
  | "passed"
  | "failed"
  | "infrastructure-error";

export interface ValidationExecutionResult {
  status: "passed" | "failed" | "infrastructure-error";
  checks: ValidationCheckResult[];
}

export interface ValidationResult {
  schemaVersion: 1;
  implementationRevision: number;
  implementationRef: ArtifactRef<"implementation">;
  approvedPlanRef: ArtifactRef<"plan">;
  planVersion: number;
  validationContractDigest: string;
  status: "passed" | "failed" | "infrastructure-error";
  checks: ValidationCheckResult[];
}
```

Responsibility boundary:

```text
ValidationExecutor
    → executes Validation Contract
    → returns ValidationExecutionResult

ValidationRunner
    → reads/verifies Approved Plan Artifact and parses its Validation Contract
    → invokes ValidationExecutor with that contract
    → validates check coverage and required-check aggregation
    → binds the result to exact Plan / implementation refs, versions, and contract digest
    → persists authoritative ValidationResult artifact
```

`ValidationExecutor` must not read Workflow State or invent an implementation revision.

Rules:

```text
exitCode === 0
    → passed

command ran and exitCode !== 0
    → failed

spawn/runtime failure
    → infrastructure-error
```

Validation pass / fail is never decided by Jev.

### Validation passed

```text
persist validation artifact
→ VALIDATION_PASSED
→ reviewing
```

### Validation failed

Validation failure is not itself a workflow transition event.

```text
persist validation artifact
→ Jev Round Decision
→ deterministic policy
→ RETRY_REQUIRED / STRONGER_RETRY_REQUIRED / REPLAN_REQUIRED / CLARIFICATION_REQUIRED
```

In the ordinary pass/fail pipeline, reviewer fanout may be skipped only for a deterministic failed-validation round. Its durable validation evidence is bound to the current Plan/implementation; missing review artifacts in a passed round must never be interpreted as this exception. Infrastructure-error is a separate branch governed below, not a failed-validation substitute.

### Validation Infrastructure Policy (I3)

Runtime applies `stopOnInfrastructureFailure` to an `infrastructure-error` result after persisting its evidence:

- `true` (default): persist `BLOCK` with reason `validation-infrastructure-error` and the validation evidence ref before any Jev, reviewer, or Worker call.
- `false`: the evidence may reach Round Decision for Human attention, but deterministic policy forces `uncertain` (or an already-required Human decision); no COMPLETE, automated RETRY, or stronger retry is allowed while infrastructure is unresolved.

Neither setting converts infrastructure failure to an ordinary failed check or to passed. A thrown executor infrastructure error follows the same safe boundary, retaining diagnostic evidence. This is deterministic runtime policy, not the Future Scope semantic validation-failure classifier.

## 8. Automated Review

When Validation passes, run in parallel:

```text
Correctness Reviewer
Ponytail Reviewer
```

Both produce structured findings.

Reviewer prose may also be persisted, but Decision Engine input uses structured findings.

### Review Completeness (B1)

For a validation-passed review round, Round Decision requires all four authoritative artifacts: correctness review, ponytail review, finding evaluation, and accepted-findings. Each must be schema/hash valid and bound to the same workflow, approved Plan/version, exact implementationRef/revision, and review round. Evaluation must cover the persisted raw finding IDs exactly once; accepted IDs must equal the ACCEPT subset.

An empty clean review is an explicit persisted empty findings array, not a missing artifact. Both empty reviews still require persisted empty evaluation and accepted-findings artifacts. Missing, partial, stale, mismatched, or caller-substituted evidence stops Round Decision before Jev/event emission; it cannot generate `REVIEW_COMPLETE`. Partial reviewer failure blocks rather than fabricating a clean round.

The validation-failure branch uses current failed validation evidence without claiming review completeness, may omit fanout/evaluation, and can never produce `REVIEW_COMPLETE`.

## 9. Finding Evaluation

For every finding, Jev evaluates bounded boolean dimensions:

```text
evidenceSupported
conflictsWithApprovedPlan
conflictsWithArchitecture
inScope
requiresHumanDecision
```

Use confidence-bearing Yes/No Choice decisions rather than a free-form evaluator result.

Deterministic core policy maps those dimensions to:

```text
ACCEPT
REJECT
ESCALATE
```

Low-confidence required dimensions do not silently become ACCEPT.

They become ESCALATE with `uncertain` semantics.

### Runtime Evidence Assembly (B3)

For Finding Evaluation and Round Decision, runtime reads schema/hash-validated authoritative Artifacts and State; refs alone and reviewer assertions alone are not sufficient context. The Jev adapter only forwards assembled evidence and normalizes responses. It must not resolve, read, summarize, or truncate Artifacts.

| Input | Required evidence assembled by runtime |
|---|---|
| Finding Evaluation | Approved Plan Scope / Requirements and Architecture / Design constraints (explicitly absent when legitimately not required), exact Plan and implementation bindings, raw finding IDs/source refs, relevant implementation/repository excerpts supporting or contradicting each finding |
| Round Decision | The same approved constraints/bindings, current validation result/ref and contract digest, complete accepted/rejected/escalated summaries for passed rounds, an explicit failed-validation or infrastructure-attention branch otherwise, current retry counters/limits and logical profile, previous round decision ref and bounded evidence when one exists |

All excerpts retain source refs and section/location provenance. Assembly uses deterministic size limits recorded in the input/policy identity; the input digest covers the actual submitted bounded evidence, branch, counters, and previous-decision identity. `previousDecision: none` is allowed only when authoritative history establishes that no previous decision exists; lost evidence must not silently become none. Preserve the previous decision link across implementation completion.

Required evidence that is unavailable or cannot fit without dropping decision-critical constraints fails closed for Human attention; truncation must not silently weaken scope or approval constraints. Numeric limits are runtime policy, not new Jev routing features.

## 10. Accepted Findings

Only `accepted-findings-N.json` is Fix Authority.

Raw findings and Jev raw output are not Fix Authority.

Worker Fix input must receive only accepted findings plus the currently approved Plan and implementation context.

## 11. Round Decision

Jev returns bounded choices:

```text
COMPLETE
RETRY
ESCALATE
```

If ESCALATE, it also classifies:

```text
implementation-capability
plan-conflict
human-decision
uncertain
```

Hard deterministic overrides take precedence:

```text
validation failed
    → COMPLETE forbidden

accepted blocking finding exists
    → COMPLETE forbidden

escalated finding exists
    → COMPLETE forbidden
```

### Policy Precedence (B4)

Apply the following order to the whole round, not only to Jev COMPLETE:

1. Reject invalid/stale/incomplete authority and apply the infrastructure stop policy before a decision can authorize execution.
2. Preserve both `action: Decision<RoundAction>` and, for ESCALATE, `escalationReason: Decision<EscalationReason>` through the adapter into core. Missing/invalid required confidence is a schema failure, not a confident default.
3. An evaluated Human-decision finding requires `human-decision` escalation. Otherwise an uncertain/escalated finding, low-confidence action, low-confidence required escalation reason, or unresolved infrastructure evidence requires `uncertain`. These take precedence over accepted blocking findings and any raw RETRY or capability escalation.
4. Only after those gates, map a confident Jev ESCALATE reason deterministically. A confident RETRY, or a COMPLETE overridden by deterministic validation failure / accepted blocking findings, may request a bounded automated retry.
5. COMPLETE is permitted only for passed validation, complete current review evidence, no accepted blocking findings, no unresolved escalation, and sufficiently confident action. It emits `REVIEW_COMPLETE`, never workflow completion.

Confidence thresholds apply to action and required reason independently; high action confidence cannot hide a low reason confidence. An escalation reason returned alongside a non-ESCALATE action does not authorize anything. Retry budgets and strongest-profile checks still apply after policy chooses an automated retry path.

Human Code Approval is outside Round Decision and remains mandatory.

## 12. Escalation Mapping

The Initial Scope uses deterministic mapping:

```text
implementation-capability
    → stronger execution profile + fixing

plan-conflict
    → planning
    → approvedPlanRef invalidated

human-decision
    → clarifying
    → planning
    → Human Plan Gate

uncertain
    → clarification / Human attention according to Initial Scope policy
```

Jev does not select an arbitrary target in the Initial Scope.

## 13. Stronger Retry

Deterministic monotonic escalation:

```text
ModelTier
ECONOMY  → STANDARD
STANDARD → STRONG
STRONG   → STRONG

ReasoningTier
LOW    → MEDIUM
MEDIUM → HIGH
HIGH   → HIGH
```

At least one dimension must become stronger.

If already `STRONG + HIGH` and `implementation-capability` occurs again:

```text
BLOCK
reason = stronger-profile-unavailable
```

## 14. Retry Budget

Recommended Initial Scope defaults:

```text
maxAutomatedFixRounds = 3
maxStrongerRetries = 1
```

Counter rules are defined in `domain-model.md`.

When the next retry would exceed a budget:

```text
BLOCK
reason = retry-budget-exhausted
```

No silent extra loop is allowed.

## 15. Human Code Gate

`COMPLETE` means the automated coding stage is clean, not workflow completion.

```text
REVIEW_COMPLETE
→ awaiting-code-review
→ Plannotator Code Review
```

Human feedback:

```text
CODE_FEEDBACK
→ fixing
```

Human approval:

```text
CODE_APPROVED
→ completed
```

### Durable Code Review Binding (B5)

Code Review identity is `reviewId + exact implementationRef + implementationRevision`. Exact ref equality includes kind, path, schemaVersion, and sha256. Persist `coding.codeReview` and `external["plannotator.code-review.rN"]` together after open and before returning a usable handle or polling/applying a result. Identity persistence failure stops processing; adapter memory is not durable authority.

Both direct apply and reconciliation validate the stored tuple, external index, and current implementation. Missing binding (including identity-only legacy State), mismatched ID/ref/hash/revision, or an externally supplied conflicting binding fails closed. Never attach an old/unbound result to the current implementation, even with a fresh adapter. A public result that omits implementation metadata is usable only through the exact previously persisted binding, not one synthesized from current State.

Existing identity/binding is reconciled, not blindly reopened/overwritten; unknown status does not imply approval or permission to reopen. Persist the settled artifact before `CODE_APPROVED` / `CODE_FEEDBACK`, then State before the next side effect. Identical already-applied results are no-ops against current persisted State; changed results for the same settled identity are rejected. A new implementation revision clears the current binding and settled ref, retains history, and requires a new Human Code Gate.

This is an orchestrator-owned binding, not a change to the third-party Plannotator contract. Full orphan-review recovery remains ORCH-018.
