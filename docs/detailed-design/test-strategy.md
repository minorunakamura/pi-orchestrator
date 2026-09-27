# Pi Orchestrator Test Strategy

Version: 1.4

## 1. Purpose

This document defines the v1 test strategy for pi-orchestrator.

## 2. Test Layers

```text
1. Pure Core Tests
2. Persistence Tests
3. Adapter Contract Tests
4. Orchestration Scenario Tests
5. Recovery / Fault Injection Tests
6. Process Integration / Smoke Tests
```

## 3. Pure Core Tests

Highest-priority area.

### Workflow State Machine

Test every valid Transition Table row from `state-machine.md`.

Also test invalid events for every phase.

Critical invariants:

- only Orchestrator transition logic mutates State
- implementation requires a valid approvedPlanRef
- validation failure can never produce REVIEW_COMPLETE
- accepted blocking finding can never produce REVIEW_COMPLETE
- Plan approval is required before implementation
- Code approval is required before completed
- stale decision artifacts are rejected
- retry exhaustion produces BLOCK

### Decision Policy

Test:

- confidence threshold behavior
- execution routing safe-stronger behavior
- finding ACCEPT / REJECT / ESCALATE mapping
- low-confidence finding escalation
- Round Decision hard rules
- escalation reason to deterministic target mapping
- stronger profile calculation
- B4: low-confidence RETRY/ESCALATE and low-confidence escalation reason cannot authorize automated execution; Human-decision and uncertain findings outrank accepted-blocking retry overrides, including mixed sets
- I1: missing/changed decision schema, Plan/revision, exact refs/input digest, policy/configuration digest are stale; runtime reuse tests must exercise the helper, not just test it in isolation

## 4. Persistence Tests

Test:

- atomic State write
- State revision increment
- malformed State JSON
- artifact hash mismatch
- missing authoritative artifact
- corrupted artifact
- stale reference detection
- immutable artifact behavior
- concurrent stale State writer rejection

Use temporary filesystem directories.

## 5. Jev Adapter Contract Tests

Use fixtures / transport mocks.

Cases:

```text
valid Choice response
multiple questions in one response
low confidence
unknown Choice value
missing answer
invalid schema
unsupported response shape
timeout
HTTP failure
authentication failure
```

Assert that TypeSafe-specific response types do not escape the adapter.

B3/B4: capture actual Finding/Round requests to verify bounded runtime-assembled approved constraints, provenance, retry State, and previous decision evidence. The adapter cannot read Artifacts. Preserve action and required reason confidence separately; high action confidence cannot hide uncertain reason.

I5: denied/revoked/mismatched Product Runtime consent, exhausted/unknown finite allowance, and failed durable reservation produce zero outbound calls. Test per-finding requests and transport retries, client recreation without budget reset, conservative timeout accounting, and absence of secrets in durable evidence. `/typesafe enable` and API-key availability do not grant consent.

## 6. pi-subagents Adapter Tests

Cases:

```text
child success
child task failure
infrastructure failure
known run status
unknown run ID
retained resume success
retained resume unavailable
parallel reviewer success
parallel reviewer partial infrastructure failure
```

Strong retry must never accidentally resume a weaker retained Worker.

I2/I4: fake event buses cover absent responder, mismatched response, timeout/response race, and late response. Every request settles within a finite deadline and cleans up listeners/timers. A possible Worker dispatch maps to ambiguous execution, not proven cancellation. Assert pre-dispatch intent/State persistence, retained correlation and actual runId when exposed on success/failure, repository baseline/post-run evidence independent of output text, and no blind redispatch. Failed routing/intent persistence starts no Worker. These producer tests do not implement ORCH-018 reconciliation.

### Product custom Agent definition tests

When each custom Agent is introduced, add agent-definition/contract tests for:

```text
workflow-scout
planner
ponytail-reviewer
```

Assertions should verify the role boundaries defined by the design, including:

- `workflow-scout` is an evidence-gathering product Agent, not State authority.
- `planner` produces Plan/Architecture/Validation Contract content but does not implement source code.
- `ponytail-reviewer` produces structured review findings and has no Fix/State authority.
- development-time builtin scout/reviewer usage is not treated as proof that the corresponding product custom Agent exists.
- a generic reviewer fallback is never labeled as execution of `ponytail-reviewer`.

## 7. Plannotator Adapter Tests

Cases:

```text
Plan approved
Plan feedback
Code approved
Code feedback
integration unavailable
unknown review ID
reconcile settled review
reconcile unresolved review
```

Approval must be persisted as an artifact before the workflow event is emitted.

B5: test persisted reviewId + exact implementationRef + revision against the external index and current State for both direct apply and fresh-adapter reconciliation. Identity-only legacy State, missing binding, different ID/ref/hash, and old revision reject without authority. Open followed by binding-save failure returns no usable handle or result; existing unknown status does not reopen. Identical settled duplicates preserve current State, changed results reject, and a new implementation invalidates the old binding. No new third-party response field is assumed.

## 8. Validation Tests

Cases:

```text
all checks pass
required command fails
optional command fails if optional checks are introduced later
spawn failure
timeout
cwd missing
malformed Validation Contract
```

Assert:

- `ValidationExecutor` result contains execution status/checks only and does not own `implementationRevision`
- `ValidationRunner` attaches the exact current Workflow implementation revision to `ValidationResult`
- no hidden Workflow State access or fabricated revision exists in the executor
- deterministic exit-code mapping
- Jev never decides pass/fail
- ordinary command failure is not terminal workflow failure
- B2: runner derives checks from the current hash-validated Approved Plan Artifact; substituted commands/cwd/required flags/check lists reject before Executor. Missing/corrupt/stale Plan or invalid contract cannot mint validation authority
- result binds exact Plan/implementation refs, versions, and contract digest; missing/extra checks or inconsistent aggregation cannot pass
- I3: infrastructure evidence is not ordinary test failure. With stopOnInfrastructureFailure=true, persist evidence and BLOCK before Jev/review/Worker; false permits only Human/uncertain routing. Raw RETRY/COMPLETE/capability cannot cause automated fixing or completion while infrastructure is unresolved

## 9. Orchestration Scenario Tests

Use fake ports to run complete workflows. Phase C exit requires the real planning/gate/coding/validation/review/evaluation/round/gate runners and core policies connected to temporary durable Artifact/State stores; only external integrations are fake. Happy-path tests must not manually emit transition events or fabricate authority in place of a required stage. Negative tests may deliberately omit/corrupt evidence to prove rejection.

The complete required matrix is in [Phase C exit criteria](../implementation/implementation-plan.md#phase-c-exit-criteria). It is required before Phase D, not deferred to ORCH-020. In addition to the positive flows below, require:

- B1 review stage bypass rejection: Round called immediately after validation pass, each of the four required artifacts absent, wrong Plan/ref/revision/round, incomplete evaluation IDs or accepted subset. No Jev COMPLETE can bypass these guards. Explicit empty complete artifacts do permit a clean round.
- B2 Validation Contract substitution rejection through the real runner/approved Artifact boundary.
- B3 actual Jev request evidence/provenance and previous-decision continuity across a Fix; unavailable or unsafely truncated constraints cannot become accepted authority.
- B4 human-decision / uncertain, low-confidence action/reason, and mixed accepted-blocking findings cannot become automated RETRY/stronger retry.
- B5 stale Code Review binding rejection after adapter restart, including identity-only State and same revision/different implementation digest.
- I1 stale decision reuse rejection at Worker dispatch, changing input revision, context, counters, policy, or configuration while keeping the Plan unchanged.
- I2/I4 integration timeout / infrastructure failure with durable identity/mutation evidence, bounded wait, and no duplicate Worker.
- I3 both validation infrastructure settings plus ordinary validation retry, proving distinct routing.
- I5 consent/budget denial and persistence fault boundaries, with no unauthorized network or downstream side effect.

Assert Artifact persist → State persist → next side effect across all successful/retry paths; inspect failed-path durable evidence. No real Pi/Herdr, live Jev, full resume controller, or third-party modification is required for this matrix.

Required scenarios:

### Happy Path

```text
feature
→ context
→ plan
→ approve
→ route
→ implement
→ validate pass
→ reviews clean
→ persist empty evaluation + accepted-findings
→ round complete
→ code approve
→ completed
```

### Plan Feedback

```text
PLAN_FEEDBACK
→ plan-vN+1
→ approval
```

### Validation Retry

```text
validation fail
→ Round Decision RETRY
→ fixing
→ validation pass
```

### Review Finding Retry

```text
review finding
→ accepted finding
→ REVIEW_RETRY_REQUIRED
→ fixing
```

### Stronger Retry

```text
implementation-capability
→ STRONGER_RETRY_REQUIRED
→ stronger profile
```

### Replan

```text
plan-conflict
→ REPLAN_REQUIRED
→ approvedPlanRef invalidated
→ new Plan
→ Human Plan Gate
```

### Human Decision

```text
human-decision
→ CLARIFICATION_REQUIRED
→ clarification
→ planning
```

### Human Code Feedback

```text
exact revision Code Gate feedback
→ persist feedback
→ fixing (Human counter only)
→ new implementation revision
→ validation / both reviews / evaluation / Round Decision
→ new exact-bound Code Gate
```

### Uncertain / Mixed Escalation

```text
low-confidence action or required reason / uncertain finding
+ optional accepted blocking findings
→ clarification / Human attention, never automated retry
→ planning → new Human Plan Gate before implementation
```

### Integration Block

```text
Jev unavailable
→ BLOCK
→ blocked
```

### Retry Exhaustion

```text
retry budget exhausted
→ BLOCK
→ blocked
```

## 10. Recovery / Fault Injection Tests

ORCH-018 owns the full resume/phase-specific reconciliation suite below. Phase C already tests current-path freshness, exact review binding after adapter restart, lifecycle evidence production, bounded failures, and persistence barriers. These focused tests must not be deferred merely because full orphan recovery is later.

Simulate process death at every persistence boundary.

Required cases:

- artifact written, State not written
- State written, next stage not started
- Jev completed but decision artifact not persisted
- Worker started and process died
- Worker completed repository mutation but result persistence is ambiguous
- Plan review opened before crash
- Code review opened before crash

Assertions:

```text
no duplicate mutation side effect
no stale decision reuse
no guessed approval
no unsafe State reconstruction
no bypass of Human Gate
```

## 11. Process Integration / Smoke Tests

This layer starts a real Pi process and verifies the built extension in a real host process. It is intentionally separate from fake-port orchestration tests.

### Process topology

Real Pi processes must run in a dedicated new Herdr tab. `tmux` must not be used.

The harness requires a current Herdr workspace and uses `HERDR_WORKSPACE_ID`.

Conceptual flow:

```text
herdr tab create
  --workspace <HERDR_WORKSPACE_ID>
  --cwd <repository>
  --label <unique smoke label>
  --no-focus
        ↓
parse .result.root_pane.pane_id
        ↓
herdr agent start <unique-agent-name>
  --kind pi
  --pane <pane-id>
  -- <pi args>
        ↓
agent prompt / wait / read
        ↓
assert smoke result
```

Herdr creates the tab/root pane; the harness must not first start Pi directly and then try to attach it.

### Harness rules

- Herdr is required only for tests that start a real Pi process.
- Pure/unit/adapter/fake-orchestration tests remain independent of Herdr.
- Real Pi smoke tests must not use direct `child_process.spawn("pi")` as their process topology.
- A successful run closes its dedicated Herdr tab.
- On failure, the harness may preserve the tab for diagnosis and must report its tab ID, pane ID, and agent name.
- Herdr is not added to the pi-orchestrator runtime integration layer.
- No third-party package or source modification is allowed to make a smoke test pass.

### Minimum real-Pi smoke coverage

At minimum verify:

```text
Pi loads pi-orchestrator extension
/wf-status is callable
workflow command registration is present
representative workflow can enter its expected first durable phase
invalid/missing external integration is surfaced safely rather than crashing the host
```

The full business-state matrix remains covered primarily by fake-port orchestration tests; smoke tests prove host/integration wiring rather than duplicate every scenario.

## 11. Test Directory Mapping

Recommended:

```text
tests/
  core/
    workflow/
    decisions/
    playbooks/
    coding/
  runtime/
    persistence/
    integrations/
    orchestrator/
  commands/
  events/
  agents/
  fixtures/
  smoke/
    herdr-pi-harness.ts
```
