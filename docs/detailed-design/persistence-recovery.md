# Persistence and Recovery Detailed Design

Version: 2.0 — v1 target contract (Issue #3)

## 1. Purpose

This document defines v1 target persistence/recovery. Pi >=0.99.1 / pi-subagents >=0.74.0 public contracts apply; #19 uses native typesafe/jev-latest and removes transitional pi-typesafe after live smoke. Current v0.1.0 schemas/receipts are not automatically compatible authority.

Normal driveWorkflow() and recovery are separate: /wf-* and accepted Human/child results use the normal driver until genuine wait/block/failure/completion. /wf-resume reconciles first, then continues that same driver; it is not normal phase-stepping.

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
            ├── agent-runs/
            ├── advisory/
            ├── workspace/
            ├── implementation/
            ├── validation/
            ├── reviews/
            └── code-reviews/
```

Do not create empty future directories eagerly.

`architecture/` is not required in the Initial Scope because Architecture / Design remains inside the Plan artifact.

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
1. validate current ownership / authority / input artifacts / launch or request policy
2. persist required intent / launch projection / baseline / consent reservation / local gate attempt
3. persist State references and counters under lock + revision check
4. perform external or mutating side effect
5. validate exact output / receipt / current source identity
6. persist immutable output Artifact
7. apply normal Event / guarded reference update and persist State
8. begin next side effect / normal driver continuation
```

This pre-side-effect barrier applies to child/Oracle/Worker dispatch, each classifier request, GRILL_WITH_DOCS write and synchronous Code Review. Plan open intent precedes public open, returned exact external binding precedes handle/result use. Output-before-State alone is insufficient for possibly mutating/external work.

The next stage must never begin before State persistence succeeds.

#11 classifier ordering is `operator/project grant → generated workflow → immutable authorization → CAS authorizationRef → immutable reservation → CAS counter/ref → native classify → immutable usage → CAS usageRef`. `jevUsage.authorizationRef` binds the captured workflow scope; each reservation/usage records that ref and grant/consent identity. Counters and prior reservation hashes must agree on request and reuse paths. Orphan authority/accounting and legacy consumed requests without the binding block explicit recovery; do not overwrite/rebind/refund or infer a fresh budget. See [authorization record and validation](../implementation/classifier-authorization.md).

### 6.1 Worker Attempt Evidence (I2)

The normal runtime must leave a durable append-only attempt history under implementation/, with verified agent-launch projection and schema-valid lifecycle records. All attempts bind public preflight policy/actual receipt (physical model/thinking/skills/effective tools/Agent definition/inheritance/package/lifecycle/launch digest). Intent/failure records are not successful implementation results and must never be used as `coding.implementationRef` or emit `IMPLEMENTATION_COMPLETE`. `coding.workerAttemptRef` points to the latest lifecycle record; each later record links its predecessor.

Required contract:

| Evidence | Required data |
|---|---|
| Pre-dispatch intent | workflowId, unique attemptId, input/target implementation revisions, exact approved Plan/version, input implementation ref when present, routing/accepted-findings/Human feedback refs, resolved profile, public request correlation identity, timestamp and deadline |
| Workspace baseline | explicit git/filesystem provider identity, canonical root/cwd, observation policy/exclusions, manifest/content identity and baseline contents; HEAD/base/index/worktree/untracked data when Git; pre-existing changes remain distinguishable; baseline bytes needed for non-Git static patch are retained |
| External observation | request/owner/node identities where supported, actual runId when exposed, explicit launch/run status including unknown; never label requestId as runId |
| Terminal or ambiguous observation | succeeded/failed/timed-out/ambiguous status, known run identity, available result/error refs, post-run repository identity and baseline comparison, explicit unavailable observations |

The Orchestrator persists intent Artifact → State ref before dispatch, and later observations Artifact → State ref before subsequent work. Actual runId is saved as soon as the public API exposes it, including on failure; if unavailable until completion, the pre-dispatch correlation identity remains the crash breadcrumb. A pending intent proves only that dispatch was possible, not that a Worker started or did not start.

Failure, timeout, and ambiguous completion retain identity/evidence and block further mutation when execution status is unresolved. A failed write after dispatch cannot authorize relaunch. Worker output text hash is supplemental evidence, never a repository/diff identity. If a safe baseline or correlation cannot be established through existing public contracts/orchestrator-side observation, stop as blocked/unsupported rather than weakening evidence or modifying a third party.

The runtime persists a received-result observation (still `ambiguous` for Workflow completion purposes) as soon as a response exposes its runId, before any post-run repository scan or successful implementation Artifact write. This received record uses `after.status = pending`; a later observation records observed or unavailable repository evidence. It then persists the final success observation linked to that implementation Artifact. If result/State publication fails, the received observation or at least the intent remains a dispatch barrier; reconstructable outcomes are blocked for reconciliation, not declared completed or blindly retried. Observations use distinct immutable filenames and predecessor refs.

Git observation records canonical cwd/root, HEAD (explicitly null for an unborn repository), index/worktree diff digests and an untracked content manifest. Filesystem observation binds normalized relative paths/types/modes/content hashes or symlink targets without escaping root, retained baseline bytes and added/modified/deleted-file evidence. Non-Git is first-class, not absence of authority. Runtime Artifact directories are excluded from the observed workload. Two matching observations detect intervening changes but do not claim filesystem atomicity; unavailable/unstable observation fails closed. Tracked gitlinks/submodules are unsupported and rejected before dispatch rather than pretending that a parent-repository dirty marker identifies their content. Observations distinguish `launchStatus` unknown/observed/not-started; only an explicit adapter guarantee that no request was emitted may establish not-started. Public request correlation is fixed before the Worker call, and requestId is never substituted for runId.

Normal runtime produces this evidence and refuses blind duplicate dispatch. Separate recovery owns exact status/receipt/output reconciliation and orphan matching before normal continuation. Public lifecycle v3 identities and full output are validated; truncated/display text, issued stop and timeout are not terminal proof. Upstream background survival/revival grants no recovery authority; failureKind is used only in public modes that expose it.

## 7. Decision Artifact Header

Coding decision artifacts carry the following header; all families share the same schema/input/policy/configuration/classifier identity principles:

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

  classifier?: { provider: string; modelId: string };
}
```

This is the coding decision header. Pre-plan conditional-stage/clarification-mode/development-method evidence additionally binds family/stage/policy/accumulated input identity and explicitly absent Plan authority; it must not fabricate an approved Plan version. Native classifier identity is mandatory when called, while deterministic required/skip/explicit method decisions record no call.

## 8. Decision Freshness

A persisted Jev decision is reusable only when all relevant fields match current authority and evidence:

- artifact schema and decision schema version
- approved Plan version and exact Plan ref
- input implementation revision (0 before initial implementation) and exact implementation ref when present
- exact input artifact references / hashes and `inputDigest`
- policy version and `policyDigest`
- relevant non-secret configurationDigest and classifier provider/model identity
- accumulated stage/clarification/document/method evidence and execution-relevant launch identity where applicable

`inputDigest` is computed from a deterministic serialization of the assembled bounded request, including branch, excerpts/provenance, retry counters, previous decision identity, and other relevant State inputs. Policy/configuration digests include the evidence-bounding rules and execution/decision policies; secret values are never included or persisted.

These checks apply to execution-routing as well as finding/round decisions, on normal reuse paths as well as recovery reconciliation. Missing fields, changed context/counts/profile constraints, or a changed input implementation revision make a decision stale. Do not copy an old outcome under a new header to manufacture freshness. Runtime re-evaluates under current authority or blocks before Worker launch; a new decision Artifact and State must persist first. Re-evaluation cannot downgrade a required stronger retry.

Previous round decision evidence remains linked in durable history when current-round State refs are cleared. Historical decisions may inform a new request but cannot authorize it merely by being referenced. A deterministic stronger-routing record also binds its source round decision and current input identity.

Normal runners produce and reject stale evidence; separate recovery discovers/reconciles historical evidence before normal driver continuation.

## 9. Workflow Lock

Only one Orchestrator process may mutate one workflow at a time.

Resume and normal advance both acquire the same workflow lock before reading authoritative State for mutation.

If exclusive locking cannot be guaranteed, stateRevision compare-and-swap behavior must be used to reject stale writers.

In the Initial Scope, lock acquisition fails closed whenever a lock already exists, including a stale/dead-owner lock. Acquisition never automatically removes a lock based on PID liveness or age: competing reclaimers could delete a replacement owner's lock. A lock left after a crash prevents further mutation until safely resolved outside acquisition; no automatic recovery mechanism is introduced here.

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

Read-only child output is reconciled against exact historical request/run/launch/receipt identity. All conditional decisions are sequential accumulated-evidence artifacts; missing legacy flags/identity cannot default to skip. Reuse Scout/Diagnosis/Research/simplicity output only when provenance/hash/policy inputs remain valid.

Missing output alone is not permission to relaunch. Reconcile public status first: running means wait, completed means recover exact full output, ambiguous means block. A safe new read-only attempt is allowed only when prior dispatch is resolved/excluded, current launch policy verified and new intent persisted. Changed model/skills/tools/Agent definition must not silently replace historical identity.

Planning preserves same-cycle one-shot refinement consumption, requires exact fresh simplicity review after any Plan change and method/Test Seam readiness before Human Gate.

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

Reconcile the persisted Plannotator review identity plus its exact `planning.planReview` binding (reviewId, exact planRef, planVersion, simplicityReviewRef). Require the current Plan's exact fresh simplicity and review readiness as well as Human identity. Check both against the current Plan and versioned external identity before polling or applying a result. A legacy identity without the exact binding is insufficient; do not attach its result to the current Plan.

If an authoritative settled review result is available, persist it and emit the normal Plan event. Persist `latestPlanReviewRef` for both approval and feedback. An identical already-applied result returns the current State unchanged after ordinary phase advancement or blocking, while its settled ref remains current; in-memory State snapshots cannot restore authority. Explicit authority invalidation is an exception: `REPLAN_REQUIRED` clears the settled ref, so the old approval is rejected as stale even before the next Plan is created. It must never restore `approvedPlanRef`.

Existing identity/binding prevents unconditional reopen or overwrite, including when external status is unknown. If gate open succeeds but identity persistence fails, stop without returning a usable handle or applying a result. An orphan external review is possible because the two systems are not transactional; it must not become authority through adapter memory or a guessed binding.

Never infer approval from disappearance or UI state.

### awaiting-code-review

Code Review is synchronous and has no external reviewId/status polling. Require the pre-persisted local code-review-attempt binding (workflowId/local attemptId/exact implementationRef/revision/review source) before applying any settled result. Verify unchanged current source/patch; legacy external code identities cannot be translated into local authority.

A valid durable settled result can resume normal CODE_APPROVED/CODE_FEEDBACK application with idempotency. Pending local intent after a lost response stays blocked for explicit recovery, never inferred approval or automatic reopen/fake review-status. A new Gate is allowed only after prior ambiguity is safely resolved and current source verified. Human review duration is not a five-second timeout. See [Plannotator](./plannotator.md).

### clarifying / document writes / advisory / deviation

Root clarification requests and confirmed Human answers bind exact mode/source State/input refs. GRILL_WITH_DOCS before/intent/after records are mutation evidence: incomplete outcome blocks blind repeat, path grant remains narrow, source mutation never permitted. Missing answer/document refs cannot be reconstructed from file existence.

Research Human selection (#47) stays within gathering-context: `researchSelectionRef` records question intent / exact confirmed answer, and resolved Research `humanResearchSelectionRef` verifies answer → intent → original ESCALATE decision. Intent/State precedes UI; answer/State and resolved decision/State precede Research dispatch or Clarification routing. Revalidate current consent, policy/configuration/input and root/workspace identity after answering. Existing original ESCALATE blocks without an intent may open the selection once on explicit resume; pending/lost/cancelled/HOLD results never auto-reopen. State-bound answered evidence may complete interrupted resolved-decision publication with exact immutable bytes, without re-asking or rerunning classifier/Scout. Other stage ESCALATE and both mandatory Human Gates are unchanged.

Development Method Human selection (#45) stays within planning: persist question intent + State before the root questionnaire, exact answer + State before resolved method, and method + State before Planner. `developmentMethodSelectionRef` is pending / answered / cancelled evidence; final `developmentMethodRef.humanSelectionRef` binds the exact answered record, its intent and original ESCALATE decision. Keep original classifier raw decision/accounting/input bindings; a Human answer is not a synthetic confidence=1 classifier decision. Resume of an original method ESCALATE block with no question intent may open the selection once; a pending/lost/cancelled/invalid result must not reopen automatically. A State-bound answered record may finish an interrupted final method publication idempotently, without another question/classifier call. Changed input/configuration/policy/root session/workspace fails closed. Current and historical Worker strategy verification reads the complete Human chain; missing/corrupt predecessors never become approved method/seam authority.

Oracle attempts bind trigger/budget/input/launch/output and remain advisory-only on restart. Timeout/uncertain advice never grants authority or refunds an unknown attempt. Reuse only exact valid evidence; no mandatory consultation loop.

Material deviation retains stopped Worker/workspace evidence, invalidates active approval/routing/review/gate authority and continues Planning -> simplicity -> Human Gate. Never resurrect old approval or infer a rollback.

#15 stores `implementation/attempt-<id>-deviated.json` and `implementation/deviation-<id>.json` before the invalidation Event/State. Output-before-State faults recover only exact historical public terminal receipt/full output, with stopped-record/report/Plan/input/workspace identity checks and zero redispatch. A subsequent Worker requires a distinct newly Human-approved Plan; changed workspace since stop blocks rather than silently rebaselining. Blocked Worker status queries also require the persisted receipt. See [implementation and fault tests](../implementation/plan-deviation.md).

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

Each child Issue tests its producer-side persistence barriers before final recovery/smoke integration. Cover missing/stale async Plan binding after restart, duplicate results against current State, sequential durable routing after BLOCK_RESOLVED, fresh simplicity/refinement cap, gate intent/binding save failure, exact launch/model/skill/tool drift, classifier consent reservation failure, clarification document partial writes and local synchronous Code attempt/result/source failures.

A failed routing/intent/launch/reservation/local-gate State write starts zero downstream calls. Failure after possible Worker/document mutation or lost Human Code response blocks instead of relaunch/reopen. Final #12 recovery/fault/host tests integrate these contracts; no third-party modification is permitted.

Primary safety assertions:

- no duplicate repository mutation
- no stale Jev decision reuse
- no inferred Human approval
- no implementation without a valid approvedPlanRef
