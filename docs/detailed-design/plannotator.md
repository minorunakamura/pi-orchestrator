# Plannotator Detailed Design

Version: 2.0 — v1 target contract (Issues #3 / #9 / #10)

## 1. Public contract / ownership

Plannotator is Human UI, not Workflow State/implementation authority。Orchestrator binds exact durable input and interprets only verified Human results。No third-party source/private API changes。

Shared public event channel: plannotator:request。Released 0.27.23 uses envelope { requestId, action, payload, respond }, with callback responses handled/result, unavailable/error or error/error。Use this public contract, not a fabricated reply-channel API。Plan and Code Gate are intentionally different protocols; reference version is review evidence, not a new minimum silently added to #3。

| Action | Payload | Result / delivery |
| --- | --- | --- |
| plan-review | `{ planContent, planFilePath? }` | handled result `{ status: "pending", reviewId }` |
| review-status | `{ reviewId }` | Plan review status/recovery |
| code-review | `{ cwd?, defaultBranch?, diffType?, vcsType?, useLocal?, prUrl?, patchFile? }` | handled settled `{ approved: boolean, feedback?: string, annotations?: unknown[] }` |

Plan settles through `plannotator:review-result` (`reviewId`, `approved`, `feedback`, optional public metadata) or review-status。Code request waits for Human completion; no external Code reviewId / status polling contract。

Reviewed public references: [released README](https://unpkg.com/@plannotator/pi-extension@0.27.23/README.md) and [exported event contract](https://unpkg.com/@plannotator/pi-extension@0.27.23/plannotator-events.ts)。Code result may additionally carry agentSwitch; it grants no workflow/model authority。Plan status is pending/missing or completed + matching review-result fields。SavedPath/agentSwitch/permissionMode/answersOnly do not replace approval/binding。

## 2. Plan Gate: async

Prerequisites: current immutable strategy Plan, deterministic validation, exact fresh Plan Simplicity evidence, approved method/Test Seams readiness, awaiting-plan-review State persisted。Human Plan Gate remains required for **every** playbook。

```text
persist opening intent + State
 -> plan-review (exact Plan body)
 -> pending / external reviewId
 -> persist PlanReviewBinding + external index + State
 -> wait for Human result / reconcile exact review-status
 -> persist matching result Artifact
 -> PLAN_APPROVED / PLAN_FEEDBACK
 -> persist State
 -> normal driver continuation
```

Binding includes external reviewId、exact planRef/version、simplicityReviewRef。Approval binds full Plan strategy/boundary, method/seams and machine-readable Validation Contract。Source/Plan changes make binding stale。

Shared plan-review requests open review UI and emit review-result; they do not enter Plannotator's automatic implementation flow。executionMode:external is required only if using Plannotator's own plan-mode/submit-plan handoff instead。The handoff event plannotator:plan-approved or UI state alone cannot replace Orchestrator's exact durable binding/result; no automatic Main implementation is allowed。

Existing identity/binding is reconciled, not reopened。Unknown/missing status, identity-only legacy State or save failure cannot create approval。Open/local save are non-atomic; orphan remains evidence-only。Duplicate exact settled result preserves current persisted State without revision/counter/event changes; changed result rejects。Explicit replan/deviation invalidation makes old approval stale。

## 3. Code Gate: synchronous

Prerequisites: current passed validation, complete exact-bound review/evaluation/accepted evidence, Round COMPLETE and awaiting-code-review。No completed until Human approval。

### Local intent before public request

Persist immutable `code-review-attempt`:

- workflowId / **local attemptId**
- exact implementationRef/revision, approved Plan identity
- canonical cwd and source type/options
- source content identity (Git mode/base/workspace or static patch path/hash/before-after snapshots)
- request correlation, pending status and timestamp

Then persist `coding.codeReviewAttemptRef`/State **before** public call。Local attemptId is not PlannotatorReviewId and cannot be polled externally。

```text
source verification -> local intent Artifact -> State
 -> synchronous code-review public payload
 -> Human completes -> approved/feedback/annotations
 -> revalidate exact implementation + unchanged review source
 -> local-bound code-review result Artifact
 -> CODE_APPROVED / CODE_FEEDBACK -> State
 -> normal driver continuation
```

Do not send implementationRef/revision as if they were public payload fields。Public result need not contain workflow/revision: only original durable local binding supplies provenance。

### Human wait vs integration failure

Remove five-second Human Code Review timeout。Human deliberation is a genuine wait, not unavailable infrastructure。Public responder absence/explicit transport/browser failure is normalized safely, but elapsed Human time cannot be treated as cancellation, approval or permission to reopen。

If root shuts down or result is lost, public Code status cannot be queried。Persisted pending local intent remains blocked for explicit recovery; never fabricate an external handle or infer approval. A new review requires the prior attempt to be safely resolved/abandoned through explicit recovery and current source verified, not an automatic duplicate open。

### Freshness / duplicates

Reject old revision、same revision/different implementation hash、source drift、patch tampering、missing local binding、conflicting correlation and changed settled result。After Human settlement re-observe source, so mutations during review invalidate result rather than approving unseen changes。

Identical already-persisted/applied result is a no-op against current State (not cached snapshot)。Artifact-write/State-write failure may republish only the exact original durable result with verified binding/source; it cannot reopen UI or manufacture Human intent。New implementation invalidates current Code attempt/result and requires a new gate。

## 4. Git / non-Git review source

Git: choose only supported public VCS/diffType options, bind intended base/mode/actual content identity, preserve pre-existing changes. If exact source cannot be presented by public live VCS mode, use an exact generated static patch rather than approve a mismatched diff。

Filesystem non-Git: canonical before/after manifest with baseline bytes/metadata -> deterministic added/modified/deleted file patch -> immutable `code-reviews/patch-*.diff` -> SHA-256/source binding -> `patchFile` payload。No repository required。`patchFile` resolves against cwd and is mutually exclusive with prUrl。

Static patch opens without live filesystem affordances。Empty intentional patch still needs verified source/current implementation; unsupported binary/type/link evidence or unavailable baseline must block, never omit changes silently。Runtime Artifact directories are excluded under persisted policy, not arbitrary live ignored files。

A patch/source is evidence only: generating it is not Code Approval。

## 5. Validation obligations

Adapter fixtures must match actual public Plan async and Code settled shapes. Fake synchronous Code responder must remain pending longer than five seconds without being classified as infrastructure failure; finite tests control explicit settlement rather than real-time sleeps。

Fault tests: local-intent Artifact/State failure means zero Code calls; lost response blocks without polling/reopen; source drift/missing binding rejects result; result save failure grants no authority; duplicate preserves current State; feedback new implementation/new Gate; both Git/filesystem patch provenance/tampering coverage。

Real production smoke uses new Herdr tab, actual Human Gates and exact versions after #9/#10/#12 implementation。This design adds no release PASS claim。
