# Coding Orchestration Detailed Design

Version: 1.1

## 1. Purpose

This document defines Coding Orchestration for pi-orchestrator v1.0.

v1 contains exactly one Coding Orchestration.

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

## 4. Execution Routing Confidence

If confidence is at or above `autoDecisionThreshold`, use the selected logical profile.

If below threshold, v1 default is a safe stronger profile rather than silently accepting the uncertain choice.

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

## 7. Validation

Validation executes the Approved Plan's Validation Contract.

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
    → reads current implementationRevision from Workflow State
    → combines it with ValidationExecutionResult
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

Reviewer fanout may be skipped for a failed Validation round.

## 8. Automated Review

When Validation passes, run in parallel:

```text
Correctness Reviewer
Ponytail Reviewer
```

Both produce structured findings.

Reviewer prose may also be persisted, but Decision Engine input uses structured findings.

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

Human Code Approval is outside Round Decision and remains mandatory.

## 12. Escalation Mapping

v1 uses deterministic mapping:

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
    → clarification / Human attention according to v1 policy
```

Jev does not select an arbitrary target in v1.

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

Recommended v1 defaults:

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

Approval must be bound to the current implementation revision.
