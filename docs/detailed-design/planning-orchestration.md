# Planning Orchestration Detailed Design

Version: 1.0

## 1. Purpose

This document defines Planning Orchestration for pi-orchestrator v1.0.

## 2. Pipeline

```text
User Task
   ↓
Task Artifact
   ↓
Context Gathering
   ↓
Clarification Policy
   ↓
Planner
   ↓
Plan Artifact Validation
   ↓
Plannotator Plan Gate
   ↓
Approved Plan
```

## 3. Context Gathering

Local repository facts are produced by `workflow-scout`.

External facts are produced by `pi-ketch.researcher` when Playbook policy requires research.

v1 does not use Jev Context Routing.

```ts
export interface ContextGatheringResult {
  scoutRef: ArtifactRef<"scout">;
  researchRef?: ArtifactRef<"research">;
}
```

Playbook Stage Policy remains:

```ts
export type StagePolicy = "required" | "conditional" | "skip";
```

For v1, `conditional` is resolved by explicit Playbook / Orchestrator policy only.

`startWorkflow` resolves research, clarification, and architecture once and persists `researchRequired`, `clarificationRequired`, and `architectureRequired` in the initial State before launching the first child. Context gathering and plan creation consume only these persisted values, including after `BLOCK_RESOLVED`; they do not accept replacement policy hints on resume. Saved scout/research refs are reused rather than rerunning completed children. Missing legacy policy fails closed before child execution; no implicit skip or guessed migration is allowed.

## 4. Clarification

Clarification is owned by the Main Pi Agent using grilling / ask-user-question.

Rule:

```text
Fact gap
    → Agent / Tool research

Product / Architecture / Scope decision
    → Human clarification
```

Jev must not generate Human-facing clarification questions.

Result artifact:

```text
context/clarification.md
```

After durable persistence, the Orchestrator emits:

```text
CLARIFICATION_COMPLETE
```

## 5. Planner Input

```ts
export interface PlannerInput {
  taskRef: ArtifactRef<"task">;

  scoutRef: ArtifactRef<"scout">;
  researchRef?: ArtifactRef<"research">;
  clarificationRef?: ArtifactRef<"clarification">;

  previousPlanRef?: ArtifactRef<"plan">;
  feedbackRef?: ArtifactRef<"plan-review">;

  targetVersion: number;
}
```

The Planner must not begin implementation.

## 6. Plan Structure

The authoritative plan artifact is:

```text
plans/plan-vN.md
```

Required logical sections:

```text
Scope / Requirements
Architecture / Design
Implementation Plan
Validation Contract
```

Architecture / Design remains embedded in the Plan in v1.

## 7. Validation Contract

The Plan must include a machine-readable Validation Contract so deterministic execution does not depend on prose interpretation.

Recommended fenced block:

````markdown
## Validation Contract

```orchestrator-validation
{
  "schemaVersion": 1,
  "checks": [
    {
      "id": "unit-tests",
      "type": "command",
      "command": "pnpm test",
      "cwd": ".",
      "required": true,
      "timeoutMs": 120000
    }
  ]
}
```
````

Domain model:

```ts
export interface ValidationContract {
  schemaVersion: 1;
  checks: ValidationCheck[];
}

export interface ValidationCheck {
  id: string;
  type: "command";
  command: string;
  cwd: string;
  required: boolean;
  timeoutMs?: number;
}
```

v1 Validation Contract contains deterministic executable checks only.

If the block cannot be parsed or validated, `PLAN_CREATED` must not be emitted.

## 8. Plan Creation

After Planner completion:

1. Validate required sections.
2. Parse Validation Contract.
3. Validate Validation Contract schema.
4. Persist the immutable `plan-vN.md` artifact and obtain its ArtifactRef.
5. Call `transition(state, { type: "PLAN_CREATED", planRef, version })` using the current State and the next Plan version.
6. On success, use the returned State: the transition updates `currentPlanRef` / `currentPlanVersion` and moves the phase to `awaiting-plan-review`.
7. Persist that State and use the State returned by persistence, including its updated `stateRevision`.
8. Begin the Human Plan Gate side effect only after State persistence succeeds.

Do not manually update `currentPlanRef` / `currentPlanVersion` before `PLAN_CREATED`. The transition owns these updates and requires `version === currentPlanVersion + 1`. If transition or persistence fails, do not open the Human Plan Gate.

## 9. Human Plan Gate

Plan proposal and implementation authority are separate.

```text
currentPlanRef
approvedPlanRef
```

On feedback:

```text
PLAN_FEEDBACK
→ planning
→ plan-vN+1.md
```

On approval:

```text
PLAN_APPROVED
→ approvedPlanRef = exact currentPlanRef
→ implementing
```

Approval is valid only when Plan version and Artifact identity match the current Plan.

The gate protocol is:

1. Open only after the Plan State has been persisted.
2. Persist the returned `{ reviewId, planRef, planVersion }` as `planning.planReview`, together with the versioned external identity. Only then return a usable review handle.
3. Before polling or applying any result (including direct `applyPlanReview`), require the persisted binding and external identity to agree with the exact current Plan/version. Missing or mismatched binding fails closed before result persistence or event emission.
4. On adapter restart, pass this verified binding, not a synthesized current-Plan request. A raw external result has no Plan authority and cannot be relabelled with the current Plan.
5. Persist the matching settled result artifact before `PLAN_APPROVED` / `PLAN_FEEDBACK`. Both events record its ref as `latestPlanReviewRef`; only approval assigns `approvedPlanRef`.

If the current Plan already has a binding or legacy external identity, `openPlanReview` must reconcile it or fail closed; it must not open a second review or overwrite the identity. An `unknown` status is not permission to reopen or infer approval.

Duplicate settled results matching `latestPlanReviewRef` are no-ops that return the current input State, including newer phase, revision, counters, and block metadata. No cached State snapshot is authoritative. The duplicate path emits no new event, writes no Artifact or State, and does not increment `stateRevision`. Changed results for the same settled identity are rejected. `REPLAN_REQUIRED` explicitly invalidates authority and clears the settled ref: subsequent delivery of the old approval is stale and rejected, even before the next Plan is created. Callers must supply the current persisted State, not a pre-settlement snapshot.

Plan State save failure prevents gate open. Review identity save failure rejects the operation and prevents polling/application through the runtime; an adapter's in-memory handle cannot replace the missing durable binding. External open and local persistence are not atomic: an orphan browser review may remain, but it grants no authority. Full orphan reconciliation belongs to ORCH-018, not an inferred approval or automatic reopen.

## 10. Replan

`REPLAN_REQUIRED` invalidates the current implementation authority.

```text
approvedPlanRef = undefined
approvedPlanVersion = undefined
phase = planning
```

The old Plan and approval artifacts remain durable historical evidence.

A newly generated Plan must pass Human Plan Gate again before implementation resumes.
