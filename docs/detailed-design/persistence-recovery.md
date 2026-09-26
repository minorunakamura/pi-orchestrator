# Persistence and Recovery Detailed Design

Version: 1.0

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

## 7. Decision Artifact Header

All Jev decision artifacts should include:

```ts
export interface DecisionArtifactHeader {
  schemaVersion: 1;
  decisionSchemaVersion: 1;

  planVersion: number;
  implementationRevision?: number;

  inputRefs: ArtifactRef[];

  policyVersion: string;
  configurationDigest: string;
  inputDigest: string;

  jevModel?: string;
}
```

## 8. Decision Freshness

A persisted Jev decision is reusable only when all relevant fields match current authority and evidence:

- decision schema version
- Plan version
- implementation revision
- input artifact references / hashes
- policy version
- configuration digest

Otherwise the decision is stale and must not be reused.

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

Reconcile the persisted Plannotator review identity.

If an authoritative settled review result is available, persist it and emit the normal Plan event.

Never infer approval from disappearance or UI state.

### awaiting-code-review

Approval is valid only when persisted and bound to the current implementation revision.

If no valid result exists, reopen/reconcile review for the exact current revision.

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

Primary safety assertions:

- no duplicate repository mutation
- no stale Jev decision reuse
- no inferred Human approval
- no implementation without a valid approvedPlanRef
