# Artifact Model

Version: 2.0 — v1 target contract (Issue #3)

## 1. State / Artifact / authority

State is current progress + authoritative refs + bounded identities/counters。Artifact is immutable durable content/evidence。State does not contain long Plan/review/log bodies。

```ts
export interface ArtifactRef<K extends ArtifactKind = ArtifactKind> {
  kind: K;
  path: string;
  schemaVersion: number;
  sha256: string;
}
```

Exact ref equality includes kind/path/schemaVersion/sha256。File existence, Agent prose, an external ID or classifier confidence alone is not authority。Artifact kinds and State/Event payloads are defined in [Domain Model](../detailed-design/domain-model.md); the following catalog uses exactly the same kinds。

## 2. Runtime paths / producer-consumer contract

Paths below are naming patterns, created on demand; N/attempt identity must be unique and durable。No directory scans infer current authority。

| Kind | Path pattern | Producer / consumer / binding |
| --- | --- | --- |
| task | task.md | Human task capture → Scout/Planner; exact workflow |
| scout | context/scout-*.md | workflow-scout → Diagnosis/routing/Planner; launch + input refs |
| diagnosis | context/diagnosis.md | read-only workflow-scout Diagnosis → Research/clarification/Architecture/Planner; structured report + exact Task/Scout refs/input hash/launch digest; [contract](../detailed-design/planning-orchestration.md#21-required-diagnosis-evidence-7) |
| research | context/research-*.md | pi-ketch.researcher → later routing/Planner; sources + inputs |
| conditional-stage | decisions/conditional-stage-*.json | Jev or deterministic required/skip policy → Orchestrator; stage/policy/accumulated refs |
| clarification-mode | decisions/clarification-mode-*.json | bounded routing + policy → root/Main clarification; mode + input identity, no write authority |
| clarification | context/human-{request,round,reply}-*.md / clarification-complete-*.md | root/Main + Human → Planner; content-addressed JSON request/source State/questions/confirmed answers/docs refs; #8 |
| domain-document-write | context/domain-document-{intent,result}-*.md | Orchestrator intent/observation → clarification/ownership/recovery; JSON exact allowed paths + full before/after contents/hashes + clarification/answer binding; #8 |
| development-method | decisions/development-method-*.json | captured request/deterministic policy/Jev → Planner/Worker; STANDARD/TDD + reason/input identity |
| plan | plans/plan-vN.md | Planner → validation/simplicity/Human/Worker/Jev; exact strategy/boundary |
| plan-simplicity-review | plan-reviews/simplicity-vN-*.json | read-only reviewer → refinement/Human; exact Plan version/hash + repository evidence |
| plan-review | plan-reviews/human-vN-*.json | Plannotator + Human → Orchestrator; async reviewId + exact Plan + review-ready simplicity |
| oracle-advisory | advisory/oracle-*.json | builtin oracle → current caller; trigger/input refs/launch/budget/output; advisory only |
| agent-launch | agent-runs/launch-*.json | public preflight + Orchestrator policy → dispatch/recovery; resolved launch projection, not State authority |
| execution-routing | decisions/execution-routing-*.json | classifier + deterministic policy → Worker; exact authority/input/profile floor |
| jev-request | decisions/jev-request-*.json | Orchestrator reservation/accounting → authorization/recovery; workflow grant/consent/classifier/ordinal/usage |
| workspace-evidence | workspace/snapshot-*.json | deterministic Git/filesystem observer → Worker/review/recovery; manifest/baseline/content digest |
| implementation | implementation/attempt-*.json or revision-*.json | Worker lifecycle/success observation → Validation; intent/failure is NOT implementation success |
| plan-deviation | implementation/deviation-*.json | stopped Worker + Orchestrator → replan/optional Oracle; exact Plan/attempt/observed changes/proposed material change |
| validation | validation/revision-*.json | deterministic executor + runner → review/Round; exact Plan/implementation/contract/checks |
| correctness-review | reviews/correctness-*.json | reviewer → evaluation; exact current round/Plan/implementation |
| ponytail-review | reviews/ponytail-*.json | ponytail-reviewer → evaluation; actual implementation simplicity |
| finding-evaluation | reviews/finding-evaluation-*.json | classifier + policy → accepted set; each current raw finding exactly once |
| accepted-findings | reviews/accepted-findings-*.json | Orchestrator policy → Worker Fix; equals evaluation ACCEPT subset |
| round-decision | reviews/round-decision-*.json | classifier + hard policy → routing; action/reason confidence + history |
| code-review-attempt | code-reviews/attempt-*.json | Orchestrator BEFORE synchronous request → Human Code Gate/recovery; local attempt + exact implementation/review source |
| code-review | code-reviews/result-*.json | synchronous Plannotator + Human → Orchestrator; exact local attempt/source/result |
| reconciliation | reconciliation-*.json | Orchestrator recovery → normal driver; exact evidence, never guessed approval |

A static review patch is a durable file under `code-reviews/patch-*.diff`; its path/hash and before/after workspace refs are bound by code-review-attempt。It is not an extra authority kind。`.pi/orchestrator` runtime data is excluded from workload observation; exclusions themselves are part of workspace policy identity。

## 3. Plan / Development Method

Plan is approved implementation strategy, not an exact execution recipe。Required logical sections:

```text
Scope / Requirements
Architecture / Design（when RUN）
Implementation Approach
Expected Change Surface
New Components
New Dependencies
Non-goals
Development Method: STANDARD | TDD
Test Seams（required when TDD）
Validation Contract（machine-readable executable checks）
```

`none` for new components/dependencies must be explicit。Architecture remains embedded in Plan; independent architecture Artifact is not required。

TDD seams describe observable behavior / interfaces / controllable dependencies / test assertions for Human review。Approval binds exact method/seams/Validation Contract with the rest of the Plan。

Plan simplicity findings include ID/category/summary、Plan location/section、repository evidence refs/locations、proposed narrower alternative where justified。Preference without repository evidence is not a finding。Review binds exact Plan version/hash and reviewer launch/input identity; any Plan edit makes it stale。

Each planning cycle records automatic refinement used (0/1) durably。A refined candidate gets a new Plan version and fresh review, without resetting that cycle's cap。Remaining findings are Human-visible; only Human Plan approval grants implementation authority。

## 4. Clarification write evidence

GRILL_WITH_DOCS only: before side effect save exact clarification request/mode/source State、authorized canonical project-relative paths、before hash or absence、intended write scope。Reject traversal/symlink escape/outside allowlist/source mutation。After write save predecessor intent、after hashes、exact changes and Human answer refs。

Partial/unknown write outcome preserves intent as an unresolved mutation barrier; no blind repeat, inferred answer or source authority。Document changes become new evidence inputs and invalidate dependent planning/routing where applicable。

## 5. Workspace evidence / Code Review source

Git and filesystem are explicit `kind` variants with durable provider identity。Resume cannot silently switch evidence providers。Both record canonical root/cwd、policy/exclusions、stable manifest/content identity、pre-existing changes、before/after linkage。Git additionally records HEAD/base (null for unborn)、index/worktree diffs and untracked content; Worker prose hashes do not identify files。

Filesystem manifests bind normalized relative path/type/mode/content hash or symlink target without following escaped targets。Keep baseline content needed for reconstructing a static patch; hashes alone cannot generate deleted/modified file diffs。Added/modified/deleted files must be reviewable。Unstable observation、unsupported binary/type/link or unavailable contents block rather than pretend clean evidence。

Human Code Gate source is `git` (pinned review mode/base + workspace content identity) or `patch` (exact static patch path/hash + before/after snapshot refs)。Check source before/after synchronous Human review; changed implementation/source invalidates result。

## 6. Decision headers / launch freshness

All decision evidence records schema/decision schema、family、classifier identity when used、exact input refs/input digest、policy/version/configuration digest、relevant Plan/revision、raw probabilities and effective policy outcome。Pre-plan decisions record absent Plan authority, not fictional approval。

Agent-launch evidence binds canonical Agent/source/definition digest、physical model/thinking、requested/resolved skills (missing required skills deny)、effective callable tools/MCP/extensions、inheritProjectContext/inheritSkills、trust expectation、context/cwd/input/output binding、package/lifecycle version、launchContractDigest。Only bounded non-secret projections are stored。

Historical attempts are not equivalent after model/thinking/skill/tool/definition/digest changes。Recovery validates historical receipt and public lifecycle/output identity; current defaults cannot rewrite launch history。

## 7. Coding artifacts / hard safety

Implementation success binds exact Plan/version、input/target revision、run/request/attempt identities、resolved launch/routing、accepted findings/Human feedback、workspace before/after and output source。Intent/pending/failure/timeout/ambiguous observations do not populate implementationRef as success。

Validation binds exact Plan/implementation refs/versions and parsed Validation Contract digest。Passed review round requires both raw reviews + evaluation + accepted artifacts (explicit empty arrays) for the same round/input identity。Evaluation IDs cover raw findings exactly once and accepted IDs equal ACCEPT subset。

Round artifacts retain action and escalation-reason confidence separately plus effective policy reason。Previous round history remains linked when current refs clear。Stale/partial evidence cannot authorize retry/completion。

## 8. Authority rules

- AR-001: Agent output is evidence, not State Transition Authority。
- AR-002: Jev/Oracle output is decision/advisory evidence, not approval/Fix authority。
- AR-003: Orchestrator validates evidence and applies deterministic policy/events。
- AR-004: exact Human Plan Approval alone grants Plan Implementation Authority。
- AR-005: exact Human Code Approval alone grants Completion Authority。
- AR-006: Raw findings/simplicity preferences grant no Fix Authority。
- AR-007: Accepted Findings grant bounded Fix Authority only under the current approved strategy。
- AR-008: domain-document intent is a narrow clarification exception, not implementation authority。
- AR-009: preflight/launch success and advisory budget are never approval。

## 9. Persistence ordering / recovery

```text
validate authoritative inputs / current ownership / policy
 -> persist required intent / consent reservation / baseline / local gate attempt
 -> persist State reference (lock + revision check)
 -> external or mutating side effect
 -> validate output / exact identity / unchanged review source
 -> immutable output Artifact
 -> pure Event / guarded State update
 -> persist State
 -> next side effect
```

This applies to child launch, each classifier attempt, clarification write, Oracle dispatch, Worker and synchronous Code Gate。Plan Gate records intent before open and exact returned external review binding before using a handle/result。Open and local persistence are not atomic; orphan ambiguity never grants approval。

Artifacts are append-only; conflicting overwrite fails。State writes atomic temp/fsync/rename with exclusive workflow mutation lock and monotonically checked stateRevision。A crash after possible mutation never permits blind retry。Resume reconciles exact State/refs/public identities, then normal driver continues。

## 10. Future Scope

Generic context-routing、arbitrary escalation-target、semantic validation-failure artifacts and multi-Worker packages are deferred。Do not create placeholder directories/files。Conditional-stage, Diagnosis, Development Method, simplicity, deviation, Oracle, launch and non-Git workspace evidence are v1。
