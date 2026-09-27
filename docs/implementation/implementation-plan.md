# Pi Orchestrator v1 Implementation Plan

Version: 1.7

## 1. Goal

Implement Basic Design v1.0 and the v1 Detailed Design without introducing v1.1+ runtime functionality.

This plan is organized as dependency-ordered Stories. The default rule is:

```text
1 Story = 1 Pull Request
```

Each PR must leave the repository compileable and testable. A later PR must not be required merely to make an earlier PR safe.

## 2. Implementation Principles

- State authority is implemented before orchestration side effects.
- Persistence safety is implemented before external integrations.
- Core policy remains Pi/API/filesystem independent.
- External integrations are introduced behind runtime ports.
- Fake adapters are available before real adapters.
- Third-party libraries/packages are consumed through published contracts and are treated as read-only dependencies.
- Pi, pi-subagents, Plannotator, pi-ketch, pi-ask-user-question, Jev/TypeSafe clients, and other external dependencies must not be patched, forked, or modified for pi-orchestrator v1.
- Real Pi processes used by Integration / Smoke Tests are launched in a new Herdr tab; tmux is not used.
- Herdr is a development/test harness dependency only and must not become a pi-orchestrator runtime dependency.
- Human Plan Gate and Human Code Gate are never temporarily bypassed.
- Validation failure never directly transitions to `fixing`.
- Raw findings never become Fix Authority.
- Retry loops are bounded from the first PR that introduces a loop.
- v1.1+ placeholders are not added unless required by a v1 abstraction already defined in Basic Design.

## 2.1 Third-Party Modification Policy

Third-party code is outside the modification boundary of pi-orchestrator.

Forbidden:

```text
node_modules edits
pnpm patch / patch-package for required behavior
forked Pi / pi-subagents / Plannotator as a v1 prerequisite
changes to third-party source repositories for orchestrator-specific behavior
private/internal API modifications assumed by pi-orchestrator
```

If a required capability is missing, use this order:

```text
1. public API / Tool / Event / Extension contract
2. pi-orchestrator-side adapter or wrapper
3. safe blocked / unsupported behavior
4. upstream issue / upstream PR / wait for upstream release
```

A local third-party patch must never be required for a v1 release candidate.

This policy has no exception in v1. It applies to every Story / PR, including Integration Tests, Smoke Tests, temporary debugging, and recovery work.

A Story is not complete if its acceptance criteria can only be satisfied by changing Pi, pi-subagents, Plannotator, pi-ketch, or another third-party dependency. In that case the Story must use an orchestrator-side adaptation, be marked blocked/unsupported, or wait for an upstream release.

## 2.2 Real Pi Process Policy for Integration / Smoke Tests

Tests that start a real Pi process must use Herdr as the process/terminal harness.

Required topology:

```text
current Herdr workspace
    ↓
new Herdr tab
    ↓
root pane
    ↓
Pi process
```

The harness uses the current `HERDR_WORKSPACE_ID`, creates a dedicated tab with the repository as `--cwd`, obtains the returned root pane ID, and starts Pi in that pane.

Conceptual command flow:

```text
herdr tab create --workspace <HERDR_WORKSPACE_ID> --cwd <repo> --label <smoke-label> --no-focus
        ↓
root pane id
        ↓
herdr agent start <unique-name> --kind pi --pane <pane-id> -- <pi-args>
        ↓
herdr agent prompt / wait / read
```

Rules:

- tmux is not used.
- Do not directly spawn the real `pi` executable from the test runner when the intent is Integration / Smoke testing.
- Unit tests, fake-adapter tests, and ordinary command-validation tests do not require Herdr.
- Herdr-specific code belongs under the test/development harness, not `src/runtime/`.
- Successful smoke runs should clean up their dedicated tab. On failure, the harness may preserve the tab and print the tab/pane/agent identity for inspection.

## 2.3 Development-time Agent Policy

Each Story may start in a new Pi session. Development-time repository investigation and review may use agents already available from the installed pi-subagents package.

Default development-time helpers:

```text
builtin scout
    → read-only repository investigation

builtin reviewer
    → read-only correctness review
```

The following are **product custom Agent definitions** and must not be assumed to be installed before their implementation Story:

```text
workflow-scout       → introduced by ORCH-007
planner              → introduced by ORCH-008
ponytail-reviewer    → introduced by ORCH-014
```

A generic reviewer is not equivalent to `ponytail-reviewer`. If a Ponytail-style advisory review is performed before `ponytail-reviewer` exists, it must be reported as a fallback/advisory review rather than as execution of the product Agent.

Development-time agent usage does not change the Third-Party Modification Policy and does not count as pi-orchestrator product integration.

## 3. Phase Overview

```text
Phase A — Domain & Safety Foundation
  ORCH-001 .. ORCH-006

Phase B — Planning Orchestration
  ORCH-007 .. ORCH-009

Phase C — Decision & Coding Orchestration
  ORCH-010 .. ORCH-017

Phase D — Recovery & Productization
  ORCH-018 .. ORCH-020
```

Dependency chain:

```text
001 → 002 → 003 → 004 → 005 → 006
                              ↓
                    007 → 008 → 009
                              ↓
                    010 → 011 → 012
                              ↓
                    013 → 014 → 015
                              ↓
                         016 → 017
                              ↓
                         018 → 019 → 020
```

Some implementation work inside a phase may be prepared in parallel, but merge order should follow the dependencies above.

---

# Phase A — Domain & Safety Foundation

## ORCH-001 — Core Domain Types and Runtime Schemas

### Goal

Create the Pi-independent domain model that all later runtime code uses.

### Scope

Implement:

```text
ArtifactRef
ArtifactKind
WorkflowId / branded IDs
WorkflowPhase
WorkflowState
PlanningState
CodingState
RetryCounters
WorkflowEvent
BlockedReason
FailureReason
ReviewFinding
Decision<T>
ExecutionRoutingDecision
FindingEvaluation
RoundDecision
ValidationContract
ValidationResult
```

Add runtime schema validation for persisted JSON/domain contracts.

### Main files

```text
src/core/workflow/state.ts
src/core/workflow/phase.ts
src/core/workflow/errors.ts
src/core/artifacts/references.ts
src/core/coding/finding.ts
src/core/decisions/types.ts
src/core/configuration.ts        # types only if needed
src/types.ts                     # shared public aliases only
```

### Acceptance criteria

- `core/` has no Pi, filesystem, HTTP, Jev SDK, Plannotator, or pi-subagents imports.
- `WorkflowState` contains refs/metadata, not long artifact bodies.
- `approvedPlanRef` and `currentPlanRef` are distinct.
- retry counters distinguish automated retries from Human Code Feedback.
- persisted structures can be schema-validated at runtime.
- TypeScript exhaustiveness checks are possible for phase/event unions.

### Tests

- schema accepts valid v1 state/artifacts.
- schema rejects unknown/invalid required enum values.
- branded/ref helper tests where applicable.

### Out of scope

- transitions
- filesystem persistence
- actual configuration loading
- v1.1 decision types

### Depends on

None.

---

## ORCH-002 — Workflow Transition Engine and Invariants

### Goal

Implement the Basic Design State Machine as pure deterministic logic.

### Scope

Implement:

```text
transition(state, event)
assertStateInvariants(state)
transition guards
transition errors
```

Encode all Basic Design v1 transitions and invariants.

### Main files

```text
src/core/workflow/transition.ts
src/core/workflow/invariants.ts
src/core/workflow/errors.ts
```

### Acceptance criteria

- transition logic has no side effects.
- invalid current-state/event combinations are rejected.
- `PLAN_APPROVED` requires the current plan/version.
- `REPLAN_REQUIRED` invalidates implementation authority.
- `REVIEW_COMPLETE` is impossible with failed validation evidence or accepted blocking findings.
- `CODE_APPROVED` is the only transition to `completed`.
- `BLOCK` records `blockedFrom`.
- `BLOCK_RESOLVED` returns only to a valid recorded phase.
- `FAIL` reaches terminal `failed`.

### Tests

Convert the complete Basic Design transition table into tests.

Add invariant-focused tests for INV-001 through INV-012 where expressible inside core state/policy.

### Out of scope

- saving state
- Jev calls
- agent execution

### Depends on

ORCH-001.

---

## ORCH-003 — Immutable Artifact Store

### Goal

Provide durable immutable artifact persistence with content identity.

### Scope

Implement:

```text
artifact path generation
atomic artifact write
artifact read
SHA-256 calculation
schema validation
artifact ref creation
artifact ref validation
```

Artifacts are append-only. Existing authoritative artifacts are not overwritten.

### Main files

```text
src/runtime/persistence/artifact-store.ts
src/runtime/persistence/artifact-paths.ts
```

### Acceptance criteria

- incomplete temp files never become authoritative refs.
- every persisted artifact ref contains/verifies content hash.
- JSON artifacts are schema validated before becoming authoritative.
- conflicting attempt to overwrite an immutable artifact fails.
- artifact directory is created on demand only.
- `architecture/` is not created eagerly.

### Tests

- atomic write success.
- simulated write interruption leaves no authoritative corrupt artifact.
- hash mismatch rejected.
- malformed JSON rejected.
- immutable overwrite rejected.

### Depends on

ORCH-001.

---

## ORCH-004 — State Store, Revision Check, and Workflow Lock

### Goal

Make `state.json` a crash-safe current projection and prevent stale/concurrent writers.

### Scope

Implement:

```text
loadState
saveState
stateRevision compare-and-save
atomic temp + rename
workflow lock
```

### Main files

```text
src/runtime/persistence/state-store.ts
src/runtime/persistence/workflow-lock.ts
```

### Acceptance criteria

- state is written atomically.
- state revision monotonically increments.
- stale writer cannot overwrite newer state.
- only one local workflow mutation section holds the workflow lock.
- state schema/invariants are validated on load and before save.
- next side effect cannot begin before state persistence succeeds.

### Tests

- stale revision rejection.
- corrupted state load rejection.
- concurrent lock behavior.
- crash boundary around temp/rename.

### Depends on

ORCH-001, ORCH-002, ORCH-003.

---

## ORCH-005 — v1 Configuration and Playbook Policy

### Goal

Implement validated v1 configuration and deterministic Playbook stage policy.

### Scope

Implement:

```text
OrchestratorConfiguration
configuration validation
default retry limits
execution profile mapping
reasoning mapping
validation infrastructure policy
Jev non-secret transport settings
PlaybookKind
StagePolicy
v1 required/conditional/skip rules
```

### Main files

```text
src/core/configuration.ts
src/core/playbooks/new-project.ts
src/core/playbooks/feature.ts
src/core/playbooks/bugfix.ts
src/core/playbooks/hotfix.ts
src/core/playbooks/chore.ts
src/runtime/configuration/load-configuration.ts
```

### Acceptance criteria

- configuration cannot disable safety invariants/Human Gates.
- default retry limits are 3 automated fix rounds / 1 stronger retry unless explicitly configured.
- secrets are not part of durable configuration snapshots.
- concrete provider/model mapping is separated from Jev logical tiers.
- `conditional` is resolved by explicit v1 Playbook/Orchestrator rules, not Jev.
- no v1.1 routing settings are added.

### Tests

- invalid retry values rejected.
- missing required execution profile mapping rejected.
- stage policy matrix tests for all v1 playbooks.

### Depends on

ORCH-001.

---

## ORCH-006 — Runtime Ports and Fake Adapters

### Goal

Create stable runtime boundaries before integrating external systems.

### Scope

Define ports:

```text
SubagentExecutor
JevDecisionClient
PlannotatorGate
ClarificationPort
ValidationExecutor
```

Add deterministic fake adapters for scenario tests.

### Main files

```text
src/runtime/ports/*
tests/fakes/*
```

### Acceptance criteria

- orchestrators can be tested without real Pi extensions or network access.
- external-specific response types do not leak into core.
- fake adapters can inject success, domain failure, infrastructure failure, timeout, and reconciliation states.

### Tests

- fake behavior contract tests.

### Depends on

ORCH-001, ORCH-005.

### Phase A exit criteria

Before Phase B begins:

- domain model compiles independently.
- state machine tests pass.
- persistence fault tests pass.
- runtime ports/fakes exist.
- no real external integration is required to test orchestration logic.
- product custom Agents are not assumed to exist before their assigned Stories.

---

# Phase B — Planning Orchestration

## ORCH-007 — Workflow Start and Context Gathering

### Goal

Start a workflow safely and persist task/context evidence.

### Scope

Implement:

```text
startWorkflow
workflow ID creation
task artifact
initial state
workflow-scout custom Agent definition
workflow-scout execution
pi-ketch.researcher execution according to playbook policy
context artifact persistence
CONTEXT_READY / CLARIFICATION_REQUIRED derivation
```

### Main files

```text
agents/workflow-scout.md
src/runtime/orchestrator/start-workflow.ts
src/runtime/orchestrator/planning-orchestrator.ts
src/runtime/orchestrator/advance-workflow.ts
```

### Acceptance criteria

- `agents/workflow-scout.md` exists as the pi-orchestrator product Scout definition; a development-time builtin scout is not treated as this deliverable.
- initial state is persisted before child-agent side effects, including the resolved `researchRequired`, `clarificationRequired`, and `architectureRequired` planning policy.
- resolved planning policy is durable workflow data: restart / `BLOCK_RESOLVED` preserves both required and skipped stages without recomputing from missing transient hints. Missing legacy policy fails closed before child execution.
- scout/research output becomes artifacts before state references are updated; State persistence must succeed before the next child starts. Previously persisted context evidence is reused on restart.
- v1 Context Routing does not call Jev.
- temporary child infrastructure failure causes `BLOCK`, not `failed`.
- no Planning/Coding authority is inferred from agent output.

### Tests

- scout-only playbook path.
- scout + research path.
- context child failure/block path.
- restart / `BLOCK_RESOLVED` after scout or research failure retains required research / clarification / architecture; saved scout evidence is not regenerated.
- resolved skipped stages remain skipped after restart; missing legacy policy does not silently default to skip.
- crash after artifact write/before state update prevents the next child from starting.

### Depends on

ORCH-001 through ORCH-006.

---

## ORCH-008 — Clarification, Planner, Plan Parser, and Validation Contract Parser

### Goal

Produce a valid plan artifact ready for Human Plan Review.

### Scope

Implement:

```text
clarification invocation
clarification artifact
planner custom Agent definition
planner invocation
plan versioning
plan parser
machine-readable Validation Contract parser
PLAN_CREATED
```

Planner inputs must use explicit artifact refs.

### Main files

```text
agents/planner.md
src/runtime/orchestrator/planning-orchestrator.ts
src/core/planning/policy.ts
src/runtime/planning/plan-parser.ts
src/runtime/validation/contract-parser.ts
```

### Acceptance criteria

- `agents/planner.md` exists as the pi-orchestrator product Planner definition and does not implement source code.
- decisions requiring Human input go through ClarificationPort.
- facts are not converted into Human product decisions.
- plan contains Scope/Requirements, Architecture/Design where needed, Implementation Plan, and Validation Contract.
- invalid/missing machine-readable required Validation Contract prevents `PLAN_CREATED`.
- clarification and Architecture / Design requirements use the persisted resolved planning policy; restart must not weaken required stages.
- new feedback creates `plan-vN+1.md`; existing plan artifacts are immutable. `PLAN_CREATED` clears the prior Plan approval and current review binding; historical identities/artifacts cannot authorize the new version.
- Plan Artifact persist → `PLAN_CREATED` → State persist completes before any Human Plan Gate side effect. A State save failure prevents gate open even if the Plan artifact already exists.
- successful plan creation ends at `awaiting-plan-review` before the ORCH-009 gate runs.

### Tests

- no-clarification path.
- clarification-required path.
- invalid plan structure.
- invalid Validation Contract.
- plan revision after feedback input; old approval/review binding is not reused for the new version.
- restart preserves required clarification and Architecture / Design validation from State.
- Plan Artifact save succeeds but State save fails: no Human Gate is opened and no approval authority is published.

### Depends on

ORCH-007.

---

## ORCH-009 — Plannotator Plan Gate Integration

### Goal

Complete Planning Orchestration with durable Human Plan authority.

### Scope

Implement Plannotator adapter for:

```text
open plan review
receive approve/feedback
review status reconciliation primitive
persist plan review artifact
PLAN_APPROVED
PLAN_FEEDBACK
```

### Main files

```text
src/runtime/integrations/plannotator.ts
src/runtime/orchestrator/planning-orchestrator.ts
```

### Acceptance criteria

- Plan Review identity is the persisted binding `reviewId + exact planRef + exact planVersion`. Exact ArtifactRef equality includes kind, path, schemaVersion, and sha256; a versioned external identity string alone is insufficient.
- the Orchestrator persists `planning.planReview` and `external["plannotator.plan-review.vN"]` together before returning a usable handle. Identity save failure stops processing; adapter memory cannot substitute for durable evidence.
- both reconciliation and direct result application verify that the persisted binding, external identity, and current Plan/version agree. An unbound or mismatched settled result fails closed without rebinding it to the current Plan, including after adapter restart.
- a current persisted identity/binding is reconciled rather than unconditionally reopened or overwritten. Missing exact binding fails closed; `unknown` external status does not authorize reopen or approval.
- approval/feedback is persisted as a review artifact before event emission; the resulting State records `latestPlanReviewRef` for either result before the next side effect.
- an identical already-applied settled result is an idempotent no-op against current persisted State, with no repeated event, artifact/State write, or revision change. Never return a cached State snapshot. Changed results for the same settled identity are rejected.
- `approvedPlanRef` is set only after matching current plan/version Human approval. Neither binding metadata nor duplicate handling grants authority.
- stale approval for an older plan version is rejected. After explicit `REPLAN_REQUIRED` invalidation, old approval is rejected even before the next Plan exists; ordinary phase advancement / `BLOCK` retains duplicate no-op behavior while the settled ref remains current.
- Plannotator unavailable transitions to `blocked`.
- `PLAN_FEEDBACK` returns to planning and creates a new plan version.
- Planning Orchestration can complete end-to-end using fake Plannotator.

### Tests

- approve.
- feedback.
- stale plan review result.
- unavailable gate.
- identity missing (including legacy external identity only) + stale approval + fresh adapter: no current-Plan rebinding, review Artifact write, or approval event; cover both reconcile and direct apply.
- reject mismatched reviewId, exact planRef (including digest), or planVersion; accept an exact persisted binding after adapter restart.
- duplicate approval/feedback after State advancement / `BLOCK` and restart returns current State unchanged, without additional writes; changed settled feedback is rejected.
- explicit `REPLAN_REQUIRED` invalidation rejects old approval without restoring State/authority; a new Plan still requires a new Human approval.
- existing identity with pending / approved / feedback / unknown status is reconciled without another open or identity overwrite; legacy identity without exact binding fails closed.
- review opens but identity save fails: reject without returning a usable handle, polling a result, or applying approval, even if the adapter retains a handle in memory.
- review Artifact save failure emits no Plan event; Artifact save success followed by State save failure allows retry of the identical durable result without overwriting the Artifact.

### Depends on

ORCH-008.

### Phase B exit criteria

- `workflow-scout` and `planner` product Agent definitions exist.
- workflow can reach `implementing` only through Human Plan Approval.
- feedback produces a new plan version with no reusable old approval or current review binding.
- research / clarification / architecture policy survives restart and `BLOCK_RESOLVED`; missing durable policy cannot silently skip required stages.
- review results require a durable exact identity/Plan/version binding. Missing or stale bindings fail closed, and existing identities are reconciled without unconditional reopen/overwrite.
- duplicate settled results preserve current persisted State and cannot resurrect cached authority; explicit replan invalidation remains a stale-result boundary.
- persistence-ordering regressions prove that Plan State save failure prevents gate open and review identity save failure prevents unsafe continuation. Settled review evidence is persisted before approval/feedback events and State before subsequent side effects.
- these Phase B contracts and focused restart/fault tests are required now; the full resume controller and orphan-review recovery remain ORCH-018 responsibilities. No new third-party contract is required.
- no implementation side effect exists yet.

---

# Phase C — Decision & Coding Orchestration

### Cross-Story Contract Remediation

The Phase C read-only review found gaps B1–B5 / I1–I5 despite passing individual Story tests. The requirements below are acceptance criteria for remediation, not a claim that the current implementation satisfies them. Basic Design's Human Gates and State/Artifact authority remain unchanged.

| Finding | Contract owner in Detailed Design | Implementation Stories |
|---|---|---|
| B1 Review completeness | [Coding §8](../detailed-design/coding-orchestration.md#review-completeness-b1) | ORCH-014, ORCH-015, ORCH-016 |
| B2 Validation authority | [Coding §7](../detailed-design/coding-orchestration.md#validation-authority-b2) | ORCH-013 |
| B3 Jev evidence | [Coding §9](../detailed-design/coding-orchestration.md#runtime-evidence-assembly-b3) | ORCH-010, ORCH-015, ORCH-016 |
| B4 Uncertainty / Human escalation | [Coding §11](../detailed-design/coding-orchestration.md#policy-precedence-b4) | ORCH-010, ORCH-011, ORCH-016 |
| B5 Code Review binding | [Coding §15](../detailed-design/coding-orchestration.md#durable-code-review-binding-b5) | ORCH-017 |
| I1 Decision freshness | [Persistence §7–8](../detailed-design/persistence-recovery.md#8-decision-freshness) | ORCH-011, ORCH-012, ORCH-015, ORCH-016 |
| I2 Worker evidence | [Persistence §6.1](../detailed-design/persistence-recovery.md#61-worker-attempt-evidence-i2) | ORCH-012; consumed by ORCH-018 |
| I3 Validation infrastructure failure | [Coding §7](../detailed-design/coding-orchestration.md#validation-infrastructure-policy-i3) | ORCH-013, ORCH-016 |
| I4 pi-subagents timeout | [Runtime §6](../detailed-design/runtime-design.md#durable-dispatch-and-bounded-wait-i2--i4) | ORCH-012, ORCH-014 |
| I5 Jev consent / budget | [Runtime §8](../detailed-design/runtime-design.md#product-runtime-consent-and-budget-i5) | ORCH-010 and all Jev call sites |

Phase C owns current-path guards, durable evidence production, and regression tests. ORCH-018 still owns the full resume controller, phase-specific reconciliation, and orphan recovery. No third-party contract change, v1.1+ feature, Integration Readiness approval, or real Pi smoke is implied by this documentation update.

## ORCH-010 — Jev Transport and Response Normalization

### Goal

Integrate TypeSafe/Jev through the selected `pi-typesafe` public library API behind a runtime adapter, without domain policy in the adapter.

### Selected dependency

```text
DevMortimer/pi-typesafe
package: pi-typesafe
usage: public library API
```

Do not use the `typesafe_evaluate` Pi agent tool as the Product Runtime decision path. `/typesafe enable` is not a runtime prerequisite for pi-orchestrator's library API calls.

### Scope

Implement:

```text
pi-typesafe client creation / invocation
authentication / availability boundary
Choice request construction
response parsing
confidence normalization
budget/auth/schema/transport error normalization
```

Support the three v1 decision request families:

```text
Coding Entry Routing
Finding Evaluation dimensions
Round Decision
```

### Main files

```text
src/runtime/integrations/jev.ts
src/runtime/integrations/jev-contracts.ts   # pi-typesafe/external-only types if needed
```

### Acceptance criteria

- `pi-typesafe` is consumed as an unmodified read-only third-party dependency.
- only its published library API is used; no private/internal API dependency is introduced.
- `typesafe_evaluate` / `/typesafe enable` is not used as the Product Runtime decision path.
- `pi-typesafe` / TypeSafe-specific types stay outside `core/`.
- malformed/unsupported responses do not silently fallback.
- auth / budget / transport / schema failures normalize to the existing integration-failure domain boundary.
- boolean semantic questions use confidence-bearing bounded choices when domain confidence is required.
- pi-orchestrator owns its Product Runtime consent/budget policy rather than treating pi-typesafe agent-tool opt-in as authority.
- adapter does not decide ACCEPT/REJECT/ESCALATE or state transitions.
- B3: Finding/Round requests forward runtime-assembled bounded authoritative evidence; the adapter does not resolve/read/summarize/truncate Artifacts or infer missing Plan constraints from refs.
- B4: normalized Round responses retain action confidence and required escalation-reason confidence separately through core policy and persistence; malformed/missing required confidence fails closed.
- I5: explicit project/workflow/destination/evidence-scoped Product Runtime consent and a finite per-workflow request allowance are checked before network dispatch. Durable reservation covers every per-finding call and transport retry; recreating a client does not reset the allowance. Missing/revoked consent or exhausted/unknown allowance blocks without network access. API keys, Plan approval, and `/typesafe enable` are not consent.
- consent/policy identity, allowance reservations, and available usage evidence are non-secret durable runtime data; reservation persistence failure prevents dispatch. Unknown timed-out usage does not automatically refund the allowance.

### Tests

Fixture/mock tests for:

```text
valid pi-typesafe result
low confidence response
missing question result
unknown choice
schema mismatch
auth unavailable/rejected
budget exhausted
timeout
transport/API failure
```

Tests must not require `/typesafe enable` or the Pi agent tool.

Additional regressions:

- B3: request capture proves Finding/Round inputs include runtime-supplied Plan/Architecture/Scope constraints and provenance; Round includes retry State and previous decision evidence. Adapter has no ArtifactStore dependency.
- B4: high-confidence ESCALATE with low-confidence reason preserves both values; missing required confidence is rejected, never replaced by action confidence.
- I5: missing/revoked/mismatched consent, exhausted/unknown allowance, and reservation save failure make zero network calls. Per-finding calls and transport retries consume reservations; client restart does not reset them. Timeout retains its reservation; no secret is persisted.

### Depends on

ORCH-006.

---

## ORCH-011 — Core Jev Decision Policies

### Goal

Convert normalized probabilistic decisions into v1 domain policy outcomes.

### Scope

Implement:

```text
confidence-policy.ts
execution-routing.ts
finding-evaluation.ts
round-decision.ts
escalation-policy.ts
decision freshness helpers
```

### Acceptance criteria

- low-confidence execution routing uses configured safe stronger behavior.
- finding dimensions deterministically produce ACCEPT/REJECT/ESCALATE.
- low-confidence finding decisions cannot silently ACCEPT.
- validation failure overrides Jev COMPLETE.
- accepted blocking finding overrides Jev COMPLETE.
- `implementation-capability`, `plan-conflict`, `human-decision`, `uncertain` map deterministically to v1 routing.
- decision freshness checks schema, plan version, implementation revision, input refs/digest, policy/config digest.
- B4: [Round policy precedence](../detailed-design/coding-orchestration.md#policy-precedence-b4) applies to every action, not only COMPLETE. No automated RETRY/stronger retry bypasses low-confidence action/reason, Human-decision evidence, or uncertainty.
- I1: all three decision families produce the mandatory freshness header; missing fields cannot be defaulted into reuse eligibility.

### Tests

Dense table-driven tests covering all policy combinations and confidence boundaries.

B4 regressions must cover low-confidence RETRY and ESCALATE, high-confidence action with low-confidence reason, Human/uncertain findings mixed with accepted blocking findings, and raw RETRY/capability escalation trying to bypass Human attention. Human-decision evidence takes precedence, then uncertainty; only afterwards may deterministic retry overrides and budgets run. Test threshold equality and below-threshold values for both action and required reason.

I1 freshness tests vary each field independently, including missing legacy fields, input implementation revision, exact ref digest, bounded input digest, retry State, policy digest, and configuration digest. A valid helper alone is insufficient: ORCH-012 must exercise it at the actual reuse boundary.

### Depends on

ORCH-001, ORCH-005, ORCH-010.

---

## ORCH-012 — Coding Entry Routing and Worker Execution

### Goal

Start implementation only from approved authority and persist implementation evidence.

### Scope

Implement:

```text
CodingOrchestrator entry
execution-routing decision artifact
EXECUTION_ROUTED
logical → concrete ExecutionProfile resolution
worker launch
implementation evidence
IMPLEMENTATION_COMPLETE
```

### Main files

```text
src/runtime/orchestrator/coding-orchestrator.ts
src/runtime/integrations/subagents.ts
```

### Acceptance criteria

- Worker cannot launch without a valid `approvedPlanRef`.
- execution-routing artifact is persisted before Worker launch.
- resolved provider/model/thinking is runtime configuration, not Jev contract authority.
- Worker receives approved plan refs, required context refs, execution profile, and accepted findings only when fixing.
- Worker does not receive raw rejected findings as Fix Authority.
- temporary subagent infrastructure failure blocks.
- implementation result artifact is persisted before `IMPLEMENTATION_COMPLETE`.
- I1: every execution-routing reuse validates the full freshness contract, including current input implementation revision, exact refs/input digest, retry State, and policy/configuration digests. Stale routing is re-evaluated or blocked before Worker; re-evaluation cannot downgrade a required stronger profile.
- I2: routing Artifact → routing State → immutable Worker attempt intent → intent State → dispatch. Persist request correlation, repository baseline, exact authority/profile inputs, and actual runId when exposed; do not require an early third-party run handle or relabel requestId as runId.
- I2: success/failure/timeout/ambiguous evidence retains known run identity, pre/post repository content identity and unavailable observations. Output prose hash is not repository identity. An unresolved attempt cannot be blindly relaunched. Lifecycle evidence is not a successful implementation result.
- I4: adapter wait is finite even without a responder; expiry settles once and releases resources. A proven pre-dispatch failure blocks as infrastructure-unavailable; possible dispatch with unknown outcome blocks as agent-execution-ambiguous, without automatic Worker retry.

### Tests

- approved happy path.
- missing/stale approval rejected.
- Jev unavailable blocks before Worker launch.
- Worker infra failure.
- crash after decision persistence/before Worker launch.
- I1: same Plan but changed revision/context/retry count/input/policy/configuration rejects old routing. Missing freshness header fails closed. New decision and State persist before dispatch; stronger-profile lower bound survives re-evaluation.
- I2: routing/intent Artifact or State save failure starts zero Workers. Failure with runId retains that exact ID; runId unavailable until completion retains correlation and explicit unknown status. Repository changes are identified independently of output text. Persistence failure after possible dispatch never authorizes a duplicate Worker.
- I4: no responder, mismatched/late result, response at timeout, and child timeout all settle safely with bounded wait and no duplicate launch. Fake adapter tests require no real Pi process.

### Depends on

ORCH-009, ORCH-011.

---

## ORCH-013 — Deterministic Validation Engine

### Goal

Execute the Approved Plan Validation Contract and persist deterministic evidence.

### Scope

Implement:

```text
ValidationExecutor port/fake contract update
command execution
cwd/timeout handling
required check aggregation
passed/failed/infrastructure-error classification
ValidationExecutionResult
ValidationRunner attaches current implementationRevision
validation artifact
VALIDATION_PASSED
failed-validation → Round Decision input
```

### Main files

```text
src/runtime/ports/validation-executor.ts
src/runtime/orchestrator/validation-runner.ts
src/runtime/validation/command-executor.ts
tests/fakes/*                         # update ValidationExecutor fake contract as needed
```

### Acceptance criteria

- commands come from the approved plan's parsed Validation Contract.
- configuration cannot silently add/remove task-specific checks.
- `ValidationExecutor` returns execution status/checks only and has no hidden Workflow State dependency.
- `ValidationRunner` attaches the exact current `implementationRevision` when constructing `ValidationResult`.
- existing ORCH-006 port/fakes are updated to the finalized contract; no revision is fabricated inside the executor.
- exit code determines command pass/fail deterministically.
- infrastructure error is distinct from test/build/lint failure.
- validation failure never directly emits `RETRY_REQUIRED` without Round Decision policy.
- reviewer fanout may be skipped for failed validation rounds.
- B2: ValidationRunner reads/hash-validates the current Approved Plan Artifact and parses its contract; it does not accept caller-selected commands/checks. Invalid authority prevents execution. Result coverage/aggregation and exact Plan/implementation refs, versions, and contract digest are validated/persisted.
- I3: persist infrastructure evidence and apply `stopOnInfrastructureFailure`: true blocks with validation-infrastructure-error before Jev/review/Worker; false can feed Round Decision only for Human/uncertain escalation, never automated retry or completion while unresolved. Executor infrastructure exceptions follow the same safe boundary.

### Tests

- executor result contains no implementation revision.
- runner binds the current implementation revision to the persisted ValidationResult.
- all checks pass.
- required check fails.
- optional/non-required semantics if supported by contract.
- timeout/spawn infrastructure error.
- failed validation cannot emit `REVIEW_COMPLETE`.
- B2: substitute/remove required checks, commands, cwd, or required flags and assert rejection before executor invocation. Missing/corrupt/stale approved Plan and invalid contract cannot produce pass; successful execution receives exactly the parsed approved contract.
- I3: spawn/timeout and thrown infrastructure errors remain distinct from exit-code failure. Test both stopOnInfrastructureFailure values, raw RETRY/COMPLETE/capability responses, retained evidence, and no unsafe Worker/reviewer launch.

### Depends on

ORCH-012.

---

## ORCH-014 — Parallel Automated Review and Structured Finding Contracts

### Goal

Run the fixed v1 reviewer set and persist structured review evidence.

### Scope

Implement:

```text
ponytail-reviewer custom Agent definition
parallel reviewer execution:
  reviewer
  ponytail-reviewer
```

Normalize and validate ReviewFinding artifacts.

### Main files

```text
agents/ponytail-reviewer.md
src/core/workflow/state.ts
src/core/workflow/transition.ts
src/runtime/orchestrator/review-runner.ts
src/runtime/integrations/subagents.ts
```

### Acceptance criteria

- `agents/ponytail-reviewer.md` exists as the pi-orchestrator product simplicity reviewer definition; a generic development-time reviewer is not treated as this deliverable.
- Ponytail Reviewer produces structured findings only and has no Fix/State authority.
- review runs only after validation pass.
- both reviewers receive fresh review context.
- reviewer set is fixed in v1; no dynamic selection.
- each result is schema validated and persisted separately.
- reviewer `blocking` flag is evidence only, not Fix Authority.
- partial reviewer infrastructure failure does not fabricate a clean round.
- B1: both raw review artifacts bind the current workflow, approved Plan/version, exact implementationRef/revision, and round. Clean findings are explicitly persisted, not represented by absent refs.
- I4: bounded adapter timeout applies to each reviewer; partial timeout retains evidence and blocks, never substitutes a clean result.

### Tests

- both reviewers clean.
- one/both produce findings.
- invalid finding schema.
- one reviewer infrastructure failure.
- parallel execution behavior via fake adapter.
- B1: missing one/both reviewers, stale round/revision/Plan/digest, duplicate IDs, or caller-substituted evidence cannot advance the downstream Round Decision. Empty reviews are still durable artifacts.
- I4: one reviewer never responds or responds late; fanout ends boundedly and no clean-round authority is fabricated.

### Depends on

ORCH-013.

---

## ORCH-015 — Finding Evaluation and Accepted Findings Authority

### Goal

Evaluate raw findings and create the only authoritative Fix Finding set.

### Scope

Implement:

```text
Jev finding-evaluation request builder
per-finding bounded decisions
deterministic evaluation policy
finding-evaluation artifact
accepted-findings artifact
acceptedFindingsRef update
```

### Acceptance criteria

- raw findings never go directly to Worker Fix input.
- low-confidence semantic evaluation escalates rather than silently accepts.
- approved-plan conflict cannot become accepted Fix Authority automatically.
- Human-decision findings escalate.
- accepted/rejected/escalated results remain traceable to original finding IDs.
- accepted findings artifact is persisted before state ref update.
- B1: evaluation covers every persisted current-round raw finding exactly once; accepted-findings equals the ACCEPT subset. Even an empty raw set produces both empty evaluation and accepted artifacts before State publication.
- B3: runtime assembles bounded approved Scope/Architecture/Plan constraints and implementation evidence with source refs/provenance. Missing or insufficient evidence fails closed; refs and reviewer assertions alone are not enough.
- I1: persist input/freshness identity with evaluation; previous decisions remain traceable without becoming new authority.

### Tests

- ACCEPT case.
- REJECT plan-conflict case.
- ESCALATE human-decision case.
- uncertain case.
- mixed reviewer findings.
- B1: missing/stale raw artifacts, missing/extra evaluation IDs, and incorrect accepted subset are rejected; empty reviews persist both downstream artifacts.
- B3: capture the actual Jev request and verify approved constraints plus relevant implementation evidence/provenance. Missing required evidence or unsafe truncation yields no accepted authority. Changing constraints changes input identity.
- Artifact save or State save failure publishes no new Fix Authority and starts no Worker.

### Depends on

ORCH-014, ORCH-011.

---

## ORCH-016 — Round Decision, Retry Budgets, and Escalation Routing

### Goal

Complete the automated Coding loop with bounded deterministic routing.

### Scope

Implement:

```text
Round Decision request
Round Decision artifact
REVIEW_COMPLETE
RETRY_REQUIRED / REVIEW_RETRY_REQUIRED
STRONGER_RETRY_REQUIRED
REPLAN_REQUIRED
CLARIFICATION_REQUIRED
retry counter accounting
stronger profile calculation
budget exhaustion → BLOCK
```

Deterministic stronger profile rule:

```text
ECONOMY  → STANDARD → STRONG
LOW      → MEDIUM   → HIGH
```

No change beyond `STRONG + HIGH`.

### Acceptance criteria

- automated fix round increments only for automated retry paths.
- Human Code Feedback does not consume automated retry budget.
- stronger retry consumes both automated-fix and stronger-retry budgets.
- exhausted next retry transitions to `blocked` instead of launching Worker.
- stronger requirement at `STRONG + HIGH` blocks for Human attention.
- `plan-conflict` invalidates approved plan and returns to planning.
- `human-decision` goes to clarification, then new planning/Human Plan Gate.
- uncertain decisions do not silently continue.
- no infinite loop is possible through automatic events.
- B1: passed-validation rounds require all four current review/evaluation/accepted artifacts with exact bindings and consistent IDs before Round Jev call or event. Missing artifacts cannot default to supplied findings or an empty array. Failed-validation rounds are explicit and cannot produce REVIEW_COMPLETE.
- B3: runtime assembles approved constraints, validation/evaluation evidence, retry counters/limits/profile, and previous decision evidence from durable authority. Lost previous evidence is not silently treated as no history.
- B4: Human/uncertain evidence and low action/required-reason confidence outrank raw RETRY, capability escalation, and accepted-blocking retry overrides.
- I1/I3: decision artifacts carry full freshness identity; unresolved infrastructure cannot lead to automated retry or completion under either validation policy setting.

### Tests

Boundary tests at exactly:

```text
max-1 → allowed
max   → next retry blocked
```

for both retry counters, plus every escalation reason route.

Additional cross-contract regressions:

- B1: invoke Round Decision immediately after validation pass, with each required review/evaluation/accepted ref missing, and with same-round stale implementation/Plan evidence; reject before Jev and REVIEW_COMPLETE. Explicit empty complete artifacts are accepted. A failed-validation round may skip fanout but never complete.
- B3: capture retry counters, previous-decision evidence and approved constraints in actual Jev input, including across a Fix. Changed evidence changes the persisted input digest.
- B4: low-confidence RETRY/ESCALATE and mixed Human/uncertain + accepted-blocking findings cannot launch automated Fix; confident capability escalation still obeys both budgets and strongest-profile limit.
- I3: infrastructure-error plus raw RETRY/COMPLETE/capability never authorizes Worker. Ordinary failed validation routes only via persisted Round policy evidence.
- Round/stronger-routing Artifact or State save failure prevents the next Worker; previous decision evidence survives current-round clearing.

### Depends on

ORCH-013 for validation-failure rounds; ORCH-015 for review-passed rounds.

---

## ORCH-017 — Plannotator Code Gate

### Goal

Require Human Code Approval for completion and route Human feedback back into fixing.

### Scope

Implement:

```text
REVIEW_COMPLETE → awaiting-code-review
open code review
persist code-review result
CODE_FEEDBACK
CODE_APPROVED
revision binding
```

### Main files

```text
src/runtime/integrations/plannotator.ts
src/runtime/orchestrator/coding-orchestrator.ts
```

### Acceptance criteria

- code review opens only for the exact current implementation revision.
- approval for an older revision is rejected.
- approval artifact is persisted before `CODE_APPROVED`.
- `CODE_APPROVED` is the only successful path to `completed`.
- feedback returns to `fixing` without consuming automated retry budget.
- Plannotator unavailable causes `blocked`.
- B5: persist `coding.codeReview` = reviewId + exact implementationRef + implementationRevision together with the external index before returning a usable handle or polling. Both direct apply and reconciliation validate it against current State.
- missing binding (including legacy identity-only State) or mismatch cannot be rebound to current implementation after adapter restart. External results need not add new fields: only a previously persisted exact tuple may supply omitted binding metadata.
- existing identity is reconciled without unconditional reopen/overwrite; unknown status is not approval. Identical settled duplicates preserve current persisted State; changed results are rejected. New implementation revision clears current binding/result and requires a new gate.

### Tests

- approve.
- feedback.
- stale revision result.
- unavailable gate.
- repeated/duplicate settled result.
- B5: identity-only/missing binding, mismatched reviewId, same revision with changed implementation ref/hash, and old revision all reject with zero approval/feedback authority; cover direct apply and fresh-adapter reconciliation.
- open succeeds but binding State save fails: no usable handle, polling, or result apply. Artifact save failure emits no event; Artifact success/State failure permits only identical durable-result retry.
- existing pending/settled/unknown identity is not reopened; duplicate after phase advancement returns current State unchanged. New revision invalidates old binding, and feedback does not consume automated retry budget.

### Depends on

ORCH-016.

### Phase C exit criteria

Using fake integrations, `/wf-feature` domain flow can demonstrate:

```text
Planning
→ Human Plan Approval
→ Coding
→ Validation
→ Review
→ Decision/Fix loop
→ Human Code Approval
→ completed
```

All retry/escalation branches are bounded.

`ponytail-reviewer` product Agent definition exists and participates in the fixed v1 reviewer set.

Phase C cannot exit on isolated Story test success alone. B1–B5 / I1–I5 remediation and regression evidence are required before Phase D:

- Complete current-round authority is mandatory after validation pass; deterministic validation-failure rounds are distinct.
- Approved Plan owns validation checks and semantic constraints; runtime assembles Jev evidence, never the adapter.
- Human/uncertain evidence and confidence gates cannot be bypassed by automated retry.
- Routing freshness, durable exact Code Review binding, consent/budget reservation, and all Artifact → State → next-side-effect barriers are exercised at runtime boundaries.
- Worker request/run identity and repository mutation evidence survive failure/ambiguity; adapter waits are bounded and unresolved mutation cannot relaunch blindly.
- Full fake end-to-end tests connect the real planning/gate/coding/validation/review/evaluation/round/gate runners and real core policies with temporary durable stores and fake external ports. No manual transition or fabricated authority may replace a required stage in a successful scenario. Negative tests may corrupt/omit evidence deliberately to prove rejection.

Required full fake scenarios (not deferred to ORCH-020):

| Scenario | Required cross-stage assertion |
|---|---|
| happy path | Planning → actual fake Human Plan Gate → Worker → validation pass → both reviews → evaluation/accepted artifacts → Round COMPLETE → actual fake Human Code Gate → completed |
| validation retry | Failed validation stays out of fixing until persisted Round policy; next Worker is followed by all required validation/review/gate stages |
| finding retry | Only evaluated ACCEPT findings reach Fix Worker; raw/rejected findings do not |
| stronger retry | Both budgets charged; stronger fresh Worker and monotonic profile; strongest/exhausted paths block |
| plan-conflict | Approval invalidated → new Plan → new Human Plan Approval before another Worker |
| human-decision / uncertain | Mixed blocking findings, low action confidence, and low reason confidence cannot bypass clarification/Human attention; continuation requires planning and Human Plan Gate |
| Human Code Feedback | Exact feedback evidence reaches Fix Worker without automated budget charge; new revision needs new validation/review and Code Gate |
| review stage bypass rejection | Each missing/stale review/evaluation/accepted artifact prevents REVIEW_COMPLETE; clean means persisted empty artifacts |
| Validation Contract substitution rejection | Altered caller checks cannot reach Executor or mint validation pass |
| stale decision reuse rejection | Same Plan with changed revision/input/retry/policy/configuration cannot reuse routing to launch Worker |
| stale Code Review binding rejection | Identity-only, changed ref/hash at same revision, old revision, and restarted adapter cannot rebind approval |
| integration timeout / infrastructure failure | No responder, ambiguous Worker, partial reviewer failure, validation infrastructure failure, and unavailable Jev/Plannotator remain bounded and block/escalate safely |

Also verify consent denial/exhaustion and persistence fault barriers with zero unauthorized network/Worker/gate continuation, and inspect the durable identities/evidence left for ORCH-018. [Test Strategy](../detailed-design/test-strategy.md#9-orchestration-scenario-tests) defines the harness boundary.

These are fake-domain exit criteria, not slash-command wiring (ORCH-019), Integration Readiness approval, full resume/reconciliation (ORCH-018), or real Pi/Herdr smoke (ORCH-020). Third-party modification is never a prerequisite.

---

# Phase D — Recovery & Productization

## ORCH-018 — Resume and Phase-Specific Reconciliation

### Goal

Resume safely from persisted authority without duplicating unsafe side effects.

Phase C must already produce the freshness headers, exact Code Review binding, Worker lifecycle/repository evidence, and durable consent/budget reservations described above. ORCH-018 consumes those contracts; it is not the first place normal-path authority checks are added. Full resume control, phase-specific status reconciliation, orphan matching, and safe recovery remain in this Story.

### Scope

Implement:

```text
resumeWorkflow
reconciler
artifact reconciliation
decision freshness reuse/re-evaluation
subagent run status reconciliation
Plannotator plan review reconciliation
Plannotator code review reconciliation
blocked reason reconciliation
BLOCK_RESOLVED
```

### Reconciliation rules

```text
context/planning/review generation
  → safe rerun only when no authoritative output exists

implementing/fixing
  → reconcile exact child run / repo mutation evidence
  → never blindly launch duplicate Worker

validating
  → reuse matching current-revision validation artifact
     or deterministically rerun

awaiting-plan-review
  → reconcile review identity/result

awaiting-code-review
  → reconcile exact revision review identity/result

Jev decision
  → reuse only when freshness contract matches
```

### Acceptance criteria

- valid existing Jev decision is not called again unnecessarily.
- stale decision is never reused.
- Human approval is never inferred from missing external state.
- Worker mutation ambiguity causes `blocked`, not duplicate mutation.
- blocked recovery returns through `BLOCK_RESOLVED` and normal transition flow.
- unreconstructable authority/state becomes `failed` only where Basic Design allows.

### Fault-injection tests

At minimum simulate process death:

```text
after external output / before artifact persist
after artifact persist / before state persist
after state persist / before next side effect
during Jev call
during Worker run
during Plan review
during Code review
```

### Depends on

ORCH-003, ORCH-004, ORCH-009, ORCH-010, ORCH-012, ORCH-017.

---

## ORCH-019 — Slash Commands and Workflow Status UI

### Goal

Expose stable thin user entry points after runtime behavior is complete.

### Scope

Implement:

```text
/wf-new
/wf-feature
/wf-bugfix
/wf-hotfix
/wf-chore
/wf-resume
/wf-status
```

Add minimal status rendering for:

```text
workflow id
playbook
phase
current/approved plan version
implementation revision
review round
retry counters
blocked/failed reason
relevant authoritative refs
```

### Main files

```text
src/commands/*
src/ui/workflow-status.ts
src/index.ts
```

### Acceptance criteria

- commands contain no orchestration business logic.
- command input is normalized and delegated to runtime controller.
- `/wf-status` is read-only.
- `/wf-resume` goes through reconciliation, never direct phase mutation.

### Tests

- command wiring tests.
- status rendering fixtures.
- invalid workflow ID handling.

### Depends on

ORCH-018.

---

## ORCH-020 — End-to-End Hardening and v1 Release Candidate

### Goal

Demonstrate the complete v1 contract and prevent accidental v1.1 scope creep.

### Scope

Add full scenario suite and release evidence.

Required scenario coverage:

```text
feature happy path
plan feedback
code feedback
validation failure → retry
review finding → fix
capability escalation → stronger retry
plan conflict → planning + new Human Plan Gate
human decision → clarification + planning
Jev unavailable → blocked
subagent infrastructure unavailable → blocked
Plannotator unavailable → blocked
retry exhaustion → blocked
resume from representative crash boundaries
unrecoverable authority corruption → failed
real Pi process smoke test in a dedicated Herdr tab
```

### v1 completion assertions

- Human Plan Gate cannot be bypassed.
- Human Code Gate cannot be bypassed.
- Validation failure cannot directly move to `fixing`.
- Raw findings cannot become Worker Fix Authority.
- Jev unavailable never silently falls back to an LLM evaluator.
- Retry budgets stop automated loops.
- State/Artifact persistence survives the defined fault-injection scenarios.
- Resume does not duplicate unsafe Worker mutation.
- stale Jev decisions are rejected.
- secrets are absent from state/artifacts.
- no third-party library/package modification is required.
- real Pi Integration / Smoke Tests launch Pi in a new Herdr tab and do not use tmux.
- Herdr remains outside the product runtime dependency graph.
- v1.1+ runtime features are absent.

### Deliverables

```text
all tests green
Herdr-managed real-Pi smoke harness
v1 release evidence / checklist
updated README usage
final architecture consistency check against Basic Design v1.0
```

### Depends on

ORCH-019 and all previous Stories.

---

# 4. Suggested Milestones

## Milestone M1 — Core Safe

Stories:

```text
ORCH-001 .. ORCH-006
```

Exit condition:

Core State/Authority/Persistence can be tested without any real integration.

## Milestone M2 — Planning Complete

Stories:

```text
ORCH-007 .. ORCH-009
```

Exit condition:

A workflow can safely obtain Human-approved implementation authority.

## Milestone M3 — Coding Complete

Stories:

```text
ORCH-010 .. ORCH-017
```

Exit condition:

Fake-adapter end-to-end workflow reaches `completed` only through all required gates.

## Milestone M4 — v1 Release Candidate

Stories:

```text
ORCH-018 .. ORCH-020
```

Exit condition:

Recovery, public commands, fault injection, and scope checks pass.

---

# 5. PR Review Rule

Every implementation PR should contain:

```text
1. Story scope
2. Files changed
3. Domain behavior added
4. Tests added
5. Basic/Detailed Design references
6. Explicit out-of-scope list
7. Follow-up dependency
8. Third-party source/package modifications: none
```

A PR should not silently introduce behavior assigned to a later Story.

Examples:

- ORCH-010 may normalize Jev output, but must not decide state routing.
- ORCH-012 may run Worker, but must not add validation/review loop behavior.
- ORCH-014 may produce raw findings, but must not make them Fix Authority.
- ORCH-017 may handle Human Code Gate, but must not implement resume heuristics assigned to ORCH-018.

# 6. Recommended First Implementation Sequence

Start with exactly:

```text
ORCH-001
→ ORCH-002
→ ORCH-003
→ ORCH-004
```

Do not begin real pi-subagents, Jev, or Plannotator integration before these four are merged.

The first external-facing implementation should only begin after ORCH-006 provides ports/fakes.
