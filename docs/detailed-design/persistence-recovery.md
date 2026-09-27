# Persistence and Recovery Detailed Design

Version: 1.2

## 1. Purpose

This document defines State / Artifact persistence, resume, reconciliation, blocked handling, and failed handling for pi-orchestrator v1.0.

## 2. Runtime Directory

```text
.pi/
└── orchestrator/
    └── runs/
        └── <workflow-id>/
            ├── state.json
            ├── context/
            ├── plans/
            ├── plan-reviews/
            ├── decisions/
            ├── implementation/
            ├── validation/
            ├── reviews/
            └── code-reviews/
```

Do not create empty future directories eagerly.

`architecture/` is not required in v1 because Architecture / Design remains inside the Plan artifact.

## 3. State vs Artifact

State contains only current progress and authority references.

Artifacts contain durable content, evidence, decisions, validation output, and Human review evidence.

State must not contain long-form Plan, review, or logs.

## 4. Immutable Artifacts

Artifacts are append-only / immutable.

Examples:

```text
plans/plan-v1.md
plans/plan-v2.md

validation/revision-1.json
validation/revision-2.json

reviews/round-decision-1.json
reviews/round-decision-2.json
```

Do not overwrite a historical artifact in place.

## 5. State Persistence

`state.json` is the current workflow projection and may be replaced atomically.

Recommended write sequence:

```text
serialize
→ write temporary file
→ fsync temporary file
→ rename temporary file to state.json
```

The State must contain `stateRevision`, incremented for every successful mutation.

## 6. Artifact Persistence Ordering

Mandatory ordering:

```text
1. validate input artifact(s)
2. perform external execution / Jev decision
3. validate output
4. persist output artifact
5. update State references in memory
6. persist State
7. begin next side effect
```

The next stage must never begin before State persistence succeeds.

### 6.1 Worker Attempt Evidence (I2)

Phase C must leave a durable, append-only attempt history under `implementation/`, using the existing implementation evidence kind with schema-validated lifecycle records. Intent/failure records are not successful implementation results and must never be used as `coding.implementationRef` or emit `IMPLEMENTATION_COMPLETE`. `coding.workerAttemptRef` points to the latest lifecycle record; each later record links its predecessor.

Required contract:

| Evidence | Required data |
|---|---|
| Pre-dispatch intent | workflowId, unique attemptId, input/target implementation revisions, exact approved Plan/version, input implementation ref when present, routing/accepted-findings/Human feedback refs, resolved profile, public request correlation identity, timestamp and deadline |
| Repository baseline | canonical repository/worktree location, HEAD/base identity where applicable, index/worktree diff digest and untracked-file content manifest (or an equivalent content identity); pre-existing changes must remain distinguishable |
| External observation | request/owner/node identities where supported, actual runId when exposed, explicit launch/run status including unknown; never label requestId as runId |
| Terminal or ambiguous observation | succeeded/failed/timed-out/ambiguous status, known run identity, available result/error refs, post-run repository identity and baseline comparison, explicit unavailable observations |

The Orchestrator persists intent Artifact → State ref before dispatch, and later observations Artifact → State ref before subsequent work. Actual runId is saved as soon as the public API exposes it, including on failure; if unavailable until completion, the pre-dispatch correlation identity remains the crash breadcrumb. A pending intent proves only that dispatch was possible, not that a Worker started or did not start.

Failure, timeout, and ambiguous completion retain identity/evidence and block further mutation when execution status is unresolved. A failed write after dispatch cannot authorize relaunch. Worker output text hash is supplemental evidence, never a repository/diff identity. If a safe baseline or correlation cannot be established through existing public contracts/orchestrator-side observation, stop as blocked/unsupported rather than weakening evidence or modifying a third party.

The runtime persists a received-result observation (still `ambiguous` for Workflow completion purposes) as soon as a response exposes its runId, before any post-run repository scan or successful implementation Artifact write. This received record uses `after.status = pending`; a later observation records observed or unavailable repository evidence. It then persists the final success observation linked to that implementation Artifact. If result/State publication fails, the received observation or at least the intent remains a dispatch barrier; reconstructable outcomes are blocked for reconciliation, not declared completed or blindly retried. Observations use distinct immutable filenames and predecessor refs.

Repository observation records canonical cwd/root, HEAD (explicitly null for an unborn repository), index/worktree diff digests, and an untracked content manifest. Runtime Artifact directories are excluded from the observed workload. Two matching observations detect intervening changes but do not claim filesystem atomicity; unavailable/unstable observation fails closed. Tracked gitlinks/submodules are unsupported and rejected before dispatch rather than pretending that a parent-repository dirty marker identifies their content. Observations distinguish `launchStatus` unknown/observed/not-started; only an explicit adapter guarantee that no request was emitted may establish not-started. Public request correlation is fixed before the Worker call, and requestId is never substituted for runId.

Phase C defines and produces this evidence and refuses blind duplicate dispatch. ORCH-018 owns status queries, orphan matching, evidence reconstruction, and normal recovery transitions; this section does not move the full resume controller into Phase C.

## 7. Decision Artifact Header

All Jev decision artifacts must include:

```ts
export interface DecisionArtifactHeader {
  schemaVersion: 1;
  decisionSchemaVersion: 1;

  planVersion: number;
  implementationRevision: number;

  inputRefs: ArtifactRef[];

  policyVersion: string;
  policyDigest: string;
  configurationDigest: string;
  inputDigest: string;

  jevModel?: string;
}
```

## 8. Decision Freshness

A persisted Jev decision is reusable only when all relevant fields match current authority and evidence:

- artifact schema and decision schema version
- approved Plan version and exact Plan ref
- input implementation revision (0 before initial implementation) and exact implementation ref when present
- exact input artifact references / hashes and `inputDigest`
- policy version and `policyDigest`
- relevant non-secret `configurationDigest`

`inputDigest` is computed from a deterministic serialization of the assembled bounded request, including branch, excerpts/provenance, retry counters, previous decision identity, and other relevant State inputs. Policy/configuration digests include the evidence-bounding rules and execution/decision policies; secret values are never included or persisted.

These checks apply to execution-routing as well as finding/round decisions, on normal reuse paths as well as ORCH-018 resume. Missing fields, changed context/counts/profile constraints, or a changed input implementation revision make a decision stale. Do not copy an old outcome under a new header to manufacture freshness. Runtime re-evaluates under current authority or blocks before Worker launch; a new decision Artifact and State must persist first. Re-evaluation cannot downgrade a required stronger retry.

Previous round decision evidence remains linked in durable history when current-round State refs are cleared. Historical decisions may inform a new request but cannot authorize it merely by being referenced. A deterministic stronger-routing record also binds its source round decision and current input identity.

Freshness production and normal-path rejection are Phase C requirements. Full discovery/reuse/re-evaluation control during resume remains ORCH-018.

## 9. Workflow Lock

Only one Orchestrator process may mutate one workflow at a time.

Resume and normal advance both acquire the same workflow lock before reading authoritative State for mutation.

If exclusive locking cannot be guaranteed, stateRevision compare-and-swap behavior must be used to reject stale writers.

In v1, lock acquisition fails closed whenever a lock already exists, including a stale/dead-owner lock. Acquisition never automatically removes a lock based on PID liveness or age: competing reclaimers could delete a replacement owner's lock. A lock left after a crash prevents further mutation until safely resolved outside acquisition; no automatic recovery mechanism is introduced here.

The current StateStore revision check runs inside this exclusive lock. It is not an independent atomic filesystem compare-and-swap and must not be used to bypass locking.

## 10. Resume Philosophy

Resume does not mean blindly rerunning the current phase.

Resume reconstructs the safe next action from:

```text
Persisted State
+
Authoritative Artifacts
+
Decision Artifacts
+
External Identities
+
Current external status
```

## 11. Common Reconciliation Flow

```text
acquire workflow lock
        ↓
load state
        ↓
validate state schema / invariants
        ↓
validate authoritative artifact refs
        ↓
reconcile external identities
        ↓
validate decision freshness
        ↓
derive normal WorkflowEvent
        ↓
transition()
        ↓
persist State
```

## 12. Phase-Specific Reconciliation

### gathering-context / planning / reviewing

These are non-mutating child-agent stages.

Resolved planning policy (`researchRequired`, `clarificationRequired`, `architectureRequired`) is durable State and survives `BLOCK_RESOLVED`. Resume must not recompute it from absent transient hints. Missing legacy policy requires explicit recovery; phase runners fail closed rather than treating it as skip. Persisted scout/research refs are reused.

If the required output artifact is missing, a safe rerun is allowed.

### implementing / fixing

These stages can mutate the repository.

Rules:

1. If a known child `runId` exists, query exact status first.
2. Do not start a duplicate Worker while a prior Worker may still have completed mutation.
3. If repository mutation is visible but child/result identity is ambiguous, transition to `blocked` rather than guessing.

### validating

If a valid validation artifact exists for the exact current implementation revision, reuse it.

Otherwise deterministic validation may be rerun.

### awaiting-plan-review

Reconcile the persisted Plannotator review identity plus its exact `planning.planReview` binding (`reviewId`, `planRef`, `planVersion`). Check both against the current Plan and versioned external identity before polling or applying a result. A legacy identity without the exact binding is insufficient; do not attach its result to the current Plan.

If an authoritative settled review result is available, persist it and emit the normal Plan event. Persist `latestPlanReviewRef` for both approval and feedback. An identical already-applied result returns the current State unchanged after ordinary phase advancement or blocking, while its settled ref remains current; in-memory State snapshots cannot restore authority. Explicit authority invalidation is an exception: `REPLAN_REQUIRED` clears the settled ref, so the old approval is rejected as stale even before the next Plan is created. It must never restore `approvedPlanRef`.

Existing identity/binding prevents unconditional reopen or overwrite, including when external status is unknown. If gate open succeeds but identity persistence fails, stop without returning a usable handle or applying a result. An orphan external review is possible because the two systems are not transactional; it must not become authority through adapter memory or a guessed binding.

Never infer approval from disappearance or UI state.

### awaiting-code-review

Require the persisted `coding.codeReview` tuple (`reviewId`, exact implementationRef, implementationRevision), matching external index and current implementation, before polling or applying a result. Identity-only State is insufficient. Neither fresh adapter memory nor current State may be used to rebind an unbound historical result.

An existing identity/binding must be reconciled without automatic reopen/overwrite, even when status is unknown. Missing/conflicting bindings fail closed for explicit recovery. A new open is allowed only for a current revision without a prior identity/binding or unresolved review ambiguity. Settled-result persistence, duplicate behavior, and invalidation follow [Human Code Gate](./coding-orchestration.md#15-human-code-gate). Full orphan recovery remains ORCH-018.

### blocked

Check whether the original block reason is resolved.

Only after successful reconciliation emit `BLOCK_RESOLVED` and return to `blockedFrom`.

## 13. Blocked State

`blocked` means authority is still reconstructable but execution cannot safely continue now.

Required metadata:

```ts
export interface BlockState {
  blockedFrom: WorkflowPhase;
  reason: BlockedReason;
  evidenceRef?: ArtifactRef;
}
```

Examples:

- Jev unavailable
- Plannotator unavailable
- pi-subagents infrastructure unavailable
- validation infrastructure failure
- retry budget exhausted
- stronger profile unavailable
- ambiguous child execution requiring operator attention

## 14. Failed State

`failed` is terminal for normal `/wf-resume`.

Use only when State / Authority / Artifact consistency cannot be safely reconstructed.

Examples:

- corrupted persisted State
- missing/corrupted authoritative Plan artifact with no reconstruction path
- impossible transition already persisted
- unrecoverable persistence consistency failure
- external identity mismatch that prevents authority reconstruction

Normal test failures, review findings, Plan feedback, and Code feedback are not terminal failures.

## 15. Fault Boundaries to Test

Resume tests must inject crashes at least at these points:

```text
after artifact write / before State write
after State write / before next side effect
during Jev call
during Worker execution
during Validation
during Plan review
during Code review
```

Phase B must already test the planning-specific subset: missing/stale review binding after adapter restart, duplicate settled results after State advancement, durable resolved planning policy after `BLOCK_RESOLVED`, existing-identity reconciliation without reopen, Plan State save failure before gate open, and identity save failure after external open. These tests exercise the ORCH-007–009 contracts without requiring the full ORCH-018 resume controller. See [Phase B acceptance criteria](../implementation/implementation-plan.md#phase-b--planning-orchestration).

Phase C must already test producer-side persistence barriers, normal decision freshness reuse, exact Code Review binding after adapter restart, and timeout/failure evidence retention. Tests must demonstrate that a failed routing/intent/identity State write prevents the next side effect. These are not the full ORCH-018 phase-specific resume/fault suite.

Primary safety assertions:

- no duplicate repository mutation
- no stale Jev decision reuse
- no inferred Human approval
- no implementation without a valid approvedPlanRef
