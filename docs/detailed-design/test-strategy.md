# Pi Orchestrator Test Strategy

Version: 1.1

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

- deterministic exit-code mapping
- Jev never decides pass/fail
- ordinary command failure is not terminal workflow failure
- infrastructure failure follows configured blocked behavior

## 9. Orchestration Scenario Tests

Use fake ports to run complete workflows.

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
