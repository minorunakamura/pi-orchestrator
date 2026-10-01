# Workflow State Machine

Version: 2.0 — v1 target contract (Issue #3)

## 1. Ownership and normal progress

Only Orchestrator mutates Workflow State. Evidence → bounded decision → deterministic policy → Workflow Event → pure transition → persisted State → next side effect。

`driveWorkflow()` owns normal progress from `/wf-*` until genuine Human/external wait、block、failure、completion。accepted Human/child results continue through the same driver。`/wf-resume` reconciles persisted authority first, then continues that driver; repeated resume is not a normal phase-stepping mechanism。

## 2. Workflow Phase

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

New product concepts use durable substate/evidence, not mandatory new linear phases:

| Phase | Work |
| --- | --- |
| gathering-context | Scout → required Diagnosis? → Research decision/execution → Clarification routing |
| clarifying | root/Main + Human; GRILL_ME or GRILL_WITH_DOCS; authorized document-write evidence |
| planning | Architecture decision → Development Method → Planner → deterministic validation → Plan Simplicity Review → at most one refinement + fresh review |
| awaiting-plan-review | exact review-ready Plan + fresh simplicity evidence; async Human Plan Gate |
| implementing / fixing | execution routing, launch preflight, approved-strategy Worker; material deviation stops |
| validating | deterministic Approved Plan Validation Contract |
| reviewing | Correctness + Ponytail → evaluation → Round Decision |
| awaiting-code-review | synchronous Human Code Gate with durable local attempt |
| blocked | recoverable suspension, recorded blockedFrom / reason / evidence |
| completed / failed | terminal completion / unreconstructable authority failure |

Oracle is cross-cutting advisory evidence within the current phase, never a mandatory phase or authority event。TDD is a Development Method, not a phase。

## 3. Event Model

The exact typed event payloads are defined once in [Domain Model §9](../detailed-design/domain-model.md#9-workflow-events). Basic and Detailed Design use the following same names and guards。

| Current | Event | Guard / persistence action | Next |
| --- | --- | --- | --- |
| gathering-context | SCOUT_PERSISTED | valid scoutRef, launch/attempt evidence | gathering-context |
| gathering-context | DIAGNOSIS_PERSISTED | required for bugfix/hotfix; valid diagnosisRef | gathering-context |
| gathering-context / planning | STAGE_RESOLVED | Research/Clarification in gathering-context, Architecture in planning; required/skip deterministic, conditional decision fresh; record exact evidence/policy | same |
| gathering-context / implementing / fixing / validating / reviewing | CLARIFICATION_ROUTED | fresh modeRef; initial routing or coding Human escalation; existing Human-required evidence cannot become SKIP | same |
| gathering-context | CONTEXT_READY | Scout/Diagnosis/Research complete, clarification SKIP, no unresolved decision | planning |
| gathering-context / implementing / fixing / validating / reviewing | CLARIFICATION_REQUIRED | Human decision; bind reason/mode; invalidate coding authority when present | clarifying |
| clarifying | CLARIFICATION_COMPLETE | durable Human answer + any authorized before/after document evidence | planning |
| planning | DEVELOPMENT_METHOD_RESOLVED | explicit Human request / deterministic inapplicability / fresh conditional decision | planning |
| planning | PLAN_CREATED | valid sections/Validation Contract; version N+1; clear approval, review binding, old simplicity | planning |
| planning | PLAN_SIMPLICITY_REVIEWED | findings/repository evidence bind exact current Plan version/hash | planning |
| planning | PLAN_REFINEMENT_REQUESTED | current simplicity findings; automatic refinement not yet used in this cycle; persist consumed budget | planning |
| planning | PLAN_REVIEW_READY | fresh simplicity, refinement settled or omitted, method/Test Seams validated; remaining findings surfaced | awaiting-plan-review |
| awaiting-plan-review | PLAN_FEEDBACK | exact current Plan + async external binding; result persisted | planning |
| awaiting-plan-review | PLAN_APPROVED | exact review-ready Plan + fresh simplicity + persisted Human approval | implementing |
| implementing / fixing | EXECUTION_ROUTED | fresh decision for exact approved Plan / inputs; persist routing before Worker | same |
| implementing / fixing | PLAN_DEVIATION_REPORTED | Worker stopped; durable deviation + after-workspace evidence; clear approval/current coding authority | planning |
| implementing / fixing | IMPLEMENTATION_COMPLETE | exact launch/attempt, approval, input/output workspace identities; successful result | validating |
| validating | VALIDATION_PASSED | exact Plan/implementation/contract; required checks pass | reviewing |
| reviewing | REVIEW_ARTIFACTS_PERSISTED | both exact-bound schema-valid raw findings (explicit empty allowed), no Fix Authority | reviewing |
| validating | RETRY_REQUIRED | failed validation + fresh Round policy + budget | fixing |
| reviewing | REVIEW_RETRY_REQUIRED | complete evaluated review + fresh Round policy + budget | fixing |
| validating / reviewing | STRONGER_RETRY_REQUIRED | confident capability route + both budgets + stronger profile | fixing |
| implementing / fixing / validating / reviewing | REPLAN_REQUIRED | durable approved-plan conflict/deviation analysis; clear approval/current coding authority | planning |
| reviewing | REVIEW_COMPLETE | passed validation + all four review/evaluation/accepted artifacts + no blocking/unresolved escalation | awaiting-code-review |
| awaiting-code-review | CODE_FEEDBACK | exact implementation/local attempt/review source + durable Human result | fixing |
| awaiting-code-review | CODE_APPROVED | exact implementation/local attempt/review source still current + durable Human approval | completed |
| active phase | BLOCK | current execution cannot safely continue; save blockedFrom/reason/evidence | blocked |
| blocked | BLOCK_RESOLVED | reconcile cause and exact authority/attempt identity, no guessed success | blockedFrom |
| active phase | FAIL | authority/state/artifact safely unreconstructable | failed |

`STAGE_RESOLVED` stores RUN/SKIP/ESCALATE evidence; ESCALATE stops normal progress for Human attention, not permission to execute/skip。`CLARIFICATION_ROUTED` stores SKIP/GRILL_ME/GRILL_WITH_DOCS/ESCALATE; the driver emits CONTEXT_READY, CLARIFICATION_REQUIRED, or BLOCK only after its persistence。

Stage artifacts, Oracle advice, launch receipts, write intents, request reservations, validation failures and local Code Review attempts can update refs through guarded State persistence without inventing transition authority。They are not Human approvals。

## 4. Pipeline / Plan lifecycle

```text
gathering-context -> clarifying? -> planning
  -> PLAN_CREATED (candidate)
  -> PLAN_SIMPLICITY_REVIEWED
  -> optional PLAN_REFINEMENT_REQUESTED -> PLAN_CREATED -> fresh PLAN_SIMPLICITY_REVIEWED
  -> PLAN_REVIEW_READY -> awaiting-plan-review
  -> PLAN_APPROVED -> implementing -> validating -> reviewing
  -> REVIEW_COMPLETE -> awaiting-code-review -> CODE_APPROVED -> completed
```

Any Plan change invalidates simplicity and approval. A new Human feedback/replan cycle may have one automatic refinement; persisting PLAN_CREATED within the same cycle must not reset the consumed cap。PLAN_FEEDBACK / REPLAN_REQUIRED / PLAN_DEVIATION_REPORTED establish a new cycle, retain history, and require a new simplicity review and Human Gate。

All playbooks require Human Plan and Code Gates. `planning -> implementing` without PLAN_APPROVED and `reviewing -> completed` without CODE_APPROVED are forbidden。

## 5. Validation / review / retry

Validation failure persists evidence but does not itself transition to fixing。Round Decision + deterministic policy chooses RETRY_REQUIRED / STRONGER_RETRY_REQUIRED / REPLAN_REQUIRED / CLARIFICATION_REQUIRED or BLOCK。

Infrastructure failure is distinct: `stopOnInfrastructureFailure=true` blocks before further external work; false may route only Human/uncertain attention, never automatic retry/completion while unresolved。

Passed rounds require exact-bound correctness, ponytail, finding-evaluation and accepted-findings artifacts even if empty。Raw findings and Oracle advice cannot grant Fix Authority。Human/uncertain evidence and low action/reason confidence outrank RETRY/capability escalation. Retry counters are bounded; exhaustion blocks。

## 6. Invariants

| ID | Required invariant |
| --- | --- |
| INV-001 | Only Orchestrator mutates Workflow State |
| INV-002 | implementing/validating/reviewing/fixing/awaiting-code-review require valid approvedPlanRef; replan/deviation invalidates it |
| INV-003 | Jev/Oracle/Agent output is evidence, not a transition |
| INV-004 | bounded decisions pass deterministic policy before events |
| INV-005 | failed validation forbids REVIEW_COMPLETE |
| INV-006 | accepted blocking / unresolved escalation forbids REVIEW_COMPLETE |
| INV-007 | no implementation before exact Human Plan Approval |
| INV-008 | no completed before exact Human Code Approval |
| INV-009 | changed refs/hash/input/policy/config/classifier/launch identity makes applicable evidence stale |
| INV-010 | required intent/authority/reservation and State persist before next external/mutating side effect |
| INV-011 | validation failure alone is not retry routing |
| INV-012 | retry/stronger/refinement/advisory budgets cannot silently reset or loop |
| INV-013 | review-ready Plan has fresh exact-bound simplicity evidence, approved method and Test Seams when TDD |
| INV-014 | Main source mutation is unauthorized; GRILL_WITH_DOCS permits only durable exact-path clarification writes |
| INV-015 | material deviation stops before unauthorized change and requires new Plan + simplicity + Human approval |
| INV-016 | Git/filesystem identity and exact Code Review source are authority evidence; display text/timeout/stop request are not completion proof |

## 7. Recovery / blocked / failed

Resume: lock/ownership → load/validate State → authoritative Artifact hash/schema → exact historical launch/review/decision reconciliation → normal Event / State persistence → `driveWorkflow()` continuation。

Running exact child means wait, not relaunch。Missing output permits rerun only when dispatch ambiguity is excluded and current launch policy is verified。Mutating Worker or synchronous Code Gate with lost result stays blocked for explicit recovery; no guessed completion, approval or polling of an invented external Code Review identity。

Unknown dependencies, consent, execution identity or budgets fail closed to blocked。Corrupt / irrecoverable authority is failed。test failures, findings and Human feedback are not terminal failures。Existing mandatory Human Gates, immutable history, lock / CAS and stale-authority rejection survive the redesign。

## 8. Future Scope

Generic Context Routing、arbitrary escalation target selection、semantic validation-failure classification、multi-Worker DAG、Virtual Models execution authority remain Future Scope。Conditional Stage Routing / Diagnosis / non-Git / TDD / Oracle advisory are v1 substate behavior。
