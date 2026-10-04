# Pi Orchestrator Runtime Design

Version: 2.0 — v1 target contract (Issue #3)

## 1. Responsibility / platform

Commands/tools/events/UI → runtime → pure core。No core import of Pi/filesystem/network/classifier/Plannotator/pi-subagents transport types。

Pi >=0.99.1 and pi-subagents >=0.74.0 are production baselines。#19 replaces and removes the transitional pi-typesafe 0.8.1 dependency after native classifier live smoke; #18 historical package/contract verification used exact 0.99.1 / 0.74.0 / 0.8.1; [platform smoke evidence](../implementation/platform-baseline-smoke.md) is separate from full #12 production validation。Use only released public APIs; no package modification/private API dependency。

## 2. Normal driver vs recovery

```text
/wf-* -> startWorkflow (task / ownership / initial State)
      -> driveWorkflow
         -> sequential planning / Human Plan Gate
         -> coding / Validation / reviews / Human Code Gate
         -> wait | blocked | failed | completed

/wf-resume -> reconcileWorkflow (exact persisted authority)
           -> driveWorkflow continuation

/wf-status -> read-only projection
```

A single normal invocation progresses until genuine Human/external wait, block, failure or completion。Human/child result handlers validate/persist evidence and wake the same driver。Repeated resume is not normal phase advancement。pi-subagents scripts are execution helpers, not lifecycle authority。

Driver loads current State, validates ownership/authority, selects one admissible phase action, receives evidence, applies core policy/Event, persists State and only then starts next side effect。It must use State returned by persistence (updated stateRevision), not cached pre-reservation/approval snapshots。

Recovery inspects State/Artifact/public historical identities and reconstructs a safe next action before continuation。No blind Worker/review recreation when dispatch/result is ambiguous。Driver and reconciler share action/phase runners rather than maintaining two different normal lifecycles。

## 3. Runtime ports (logical target)

Minimal ports retain existing responsibility areas; exact TypeScript fields belong to implementing Issues。

| Port | Contract |
| --- | --- |
| SubagentExecutor | public preflight resolution + exact single-agent dispatch/receipt/result/status; normalized launch policy projection |
| DecisionClassifierPort | conditional stage, clarification mode, method, execution, finding and round requests; bounded domain decisions |
| ClarificationPort | persisted root/Main request/mode/evidence/scope → confirmed Human questions/answers + authorized write refs |
| PlanGate | async open/pending/external identity/status/result |
| CodeGate | synchronous request/settled Human result through pre-persisted local attempt; no external review-status |
| ValidationExecutor | authoritative parsed contract → execution statuses/checks only |
| workspace observation | deterministic Git/filesystem baseline/after/source/patch evidence |

ValidationExecutor does not read WorkflowState or invent revision。ValidationRunner reads/hash-validates exact approved Plan, parses contract, validates result coverage/aggregation, binds Plan/implementation/contract digest, persists result and normal Event。

Adapters forward runtime-assembled evidence and normalize output/errors。They do not read ArtifactStore to guess classifier constraints or mutate State。

## 4. Planning runtime

Scout → required Diagnosis? → Research routing/execution → clarification mode/root Human → Architecture routing → method → Planner → deterministic Plan validation → read-only simplicity → optional one-shot refinement/fresh review → async Human Plan Gate。

Each stage consumes accumulated durable evidence sequentially。required/skip deterministic, conditional classifier only。New normal code must not use start-time transient booleans as authority or run Scout/Research concurrently before dependent routing。

GRILL_WITH_DOCS grants only exact clarification-bound CONTEXT/ADR write scope after before/intent persistence。No independent domain-modeling Stage/general source write。Plan stays planning after PLAN_CREATED until fresh simplicity/method/Test Seams permit PLAN_REVIEW_READY。

## 5. Active workflow ownership / Main guard (#5)

Bind active workflow to canonical workspace/root session/workflow identity and durable ownership projection。Enforce the same policy at public host tool-call and launch boundaries: Main cannot directly edit source, run mutating shell/MCP or launch a child to bypass Worker/Plan authority。

Root/Main normally owns Human interaction/read-only explanation only。GRILL_WITH_DOCS temporarily admits exact authorized CONTEXT/ADR paths/operations with persisted clarification intent/before/after evidence。Mode selection is not general mutation permission。

Worker mutation requires current approved strategy/routing/launch/attempt identity。Evidence/review/Oracle/Codemode roles remain read-only。Permission prompts/tool hints are not a sandbox; unsupported/unverifiable enforcement fails closed。Do not recursively invoke subagent tools inside tool_call; use supported public adapter/capability seams。

Pi/pi-subagents own trust inheritance。Untrusted trust-gated project settings/.pi prompts/skills/extensions must be skipped; AGENTS.md/CLAUDE.md context and startup sessionDir lookup are exceptions, not sandboxed by trust。Use explicit inheritance policy for context exclusion。tool_call guards model/nested/MCP calls, not arbitrary trusted extension pi.exec/filesystem code; deny unknown mutation providers and detect out-of-band workspace drift。Single active owner is reconciled before continuation; ownership conflicts block rather than switching Main into executor。

### #5 implemented ownership projection

Production composition は public `session_start` / `before_agent_start` / `tool_call` / `user_bash` を登録し、毎callで同じworkspaceの durable active State を再観測する。Workspace-wide lock 下で single owner を確認し、initial State → immutable `ownershipRef`（canonical root/root session/workflow/full workspace observation）→ CAS State を保存してから normal driving を開始する。Public session custom entriesはdeny-only breadcrumbとしてState binding前に保存する。Known State/runtime-directoryの消失をowner解放とみなさず、reload/branch navigation後もnew start/raw toolを拒否する。Session hintsはpermission/approvalではなく、current State/Artifactsだけがauthority。`blocked` は ownership を保持し、`completed` / `failed` は terminal とする。Legacy/unbound owner、conflict、corrupt observation、別root sessionへのadoptionは permission にせず停止する。Git workflow のcwdは canonical repository root を要求する。

Active ownership中は Main の raw toolsをすべて拒否する（read-only hints / trusted project tool / shell / MCP / Codemode / childも含む）。Human chatと `/wf-status` は可能。Clarifying中の例外は owned `wf_clarification_round` / `wf_clarification_complete` のみで、effective params/session/path/workspace は `execute()` で再検証する。Missing factsはOrchestrator-owned evidence待ちであり、Mainへのraw investigation permissionを推定しない。

Normal driver、resume/reconciliation entry、Oracle request、最初/次のWorker baseline直前で ownership/workspaceを検証する。Changed workspaceはfresh baselineにせず durable denial → block。`workspaceCheckpointRef` はexact succeeded/deviated Workerのbefore/after、またはconfirmed clarification/document intent/result/full workspace/scope evidenceだけから更新する。Unresolved Workerはexisting exact historical reconcilerへ渡し、ここでrelaunch/rebaselineしない。Ownership/checkpointは implementation/Plan/Code approvalではない。[実装・acceptance・real smoke](../implementation/workflow-ownership.md)。

## 6. pi-subagents Integration

Mapping: workflow-scout / read-only Diagnosis role / pi-ketch.researcher / planner / plan-simplicity-reviewer / worker / reviewer / ponytail-reviewer / builtin oracle。Product custom definitions must exist before runtime selection; development-time builtin helpers do not replace them。

### Agent Launch Policy / preflight

#21 common boundary applies to **all** production child roles。Call released resolveSubagentLaunchContract from pi-subagents/preflight with consistent actual host snapshots and launch parameters before avoidable child side effects。

Implemented boundary: domain `AgentLaunchPolicy` / `AgentLaunchEvidence` → `SubagentExecutor.preflight()` and `run({ onPrepared, onStarted })` → public preflight/capability-ceiling/RPC adapter。`onPrepared` belongs to the Orchestrator and persists Artifact/attempt + State before spawn; the adapter never owns State. The adapter rechecks the projection after persistence, pins the resolved physical model/thinking, disables default reads/progress and compares the real receipt digest. Codemode-aware read-only inspection can return bounded resolved tool evidence without dispatch; #20 permits `run` only for Plan Simplicity Reviewer with the exact isolated Orchestrator child replacement. All other Codemode inspection roles remain unsupported for dispatch. Replacement bytes join extension freshness; actual registered/callable loadout is checked before provider work and at script execution. See [#20 implementation](../implementation/readonly-codemode.md). No caller Boolean, prose or preflight success bypasses that gate. See [#21 implementation and smoke](../implementation/agent-launch-contract.md) for supported policy and limits。

Resolve/validate canonical Agent/source/definition digest, physical model/thinking, required/resolved skills, effective callable tools/extensions/MCP, inheritance/context/trust expectations, cwd/input/output identity, package/lifecycle versions and launchContractDigest。Preflight contract version 3 is released in 0.74.0; unresolved host_required execution facts deny dispatch。ok:true/effectiveAllowlist resolves intent, not runtime provider availability/trust/skill-body attestation。Supplement public host/child-startup checks before model/mutation work, not private API guesses。Single-agent RPC thinking uses model provider/id:level, not the ignored model-facing thinking field。

Persist bounded non-secret projection + attempt intent + State before spawn。Capture actual launch receipt and exact run ID as exposed; compare execution digest to intended launch。No secret/raw settings/unbounded prompt durability。Changed model/thinking/skills/tools/definition/digest cannot be equivalent historical attempt。

TDD Worker explicitly requests tdd via public skill selection; inheritSkills:false isolates inherited/extension-added skills, optional codebase-design is explicit。Oracle verifies builtin identity + read-only ceiling。Read-only Codemode (#20) initial Scout/simplicity (optional correctness/ponytail) roles require proven callable ceiling excluding mutation/nested authority plus finite child/tool/output bounds。Stock models.classify bypasses the tool list; disable the models namespace with public createCodemodeExtension({models:false}) via supported child extension loading/replacement, or keep the capability disabled until isolation is proven。denyExtensions:true also prevents Codemode registration; preflight alone cannot prove replacement behavior。Oracle/Research/Worker expansion is not part of #20。

#18 current adapter passes public Agent discovery scope from the host trust decision: trusted → both, untrusted/unknown → user。This prevents project Agent definitions/settings overrides from entering a launch without duplicating Pi's trust loader。Native child resource loading still inherits parent trust through pi-subagents。No unsupported RPC projectTrusted/inheritSkills parameter is added。

### Product runtime fresh-context policy

Scout/Diagnosis/Research/Planner/simplicity/Correctness/Ponytail/Oracle/initial Worker default fresh。Ordinary Fix is fresh by default; retained resume only when exact historical identity/policy is proven safe。Stronger retry always fresh, never reuse a weaker retained Worker。

### Durable Dispatch and Bounded Wait (I2 / I4)

Persist request correlation and intent before emitting public async single-agent RPC spawn。A requestId is not runId。Receipt/run/session/launch/output identities are persisted as soon as public API exposes them; preflight placeholder IDs/roots are not real execution identity。

Every adapter request has a positive finite deadline even without a subscriber。On result/error/expiry settle once and release timer/listener。Mismatched IDs cannot settle; late results cannot authorize work after timeout。

Proven no dispatch → infrastructure unavailable。Possible dispatch/timeout/unknown completion → ambiguous execution; preserve intent/known run/workspace evidence and BLOCK before another Worker。Timeout/stop request is not terminal/cancellation/mutation-absence proof。

Authoritative output is full hash/schema-valid file/structured result bound to receipt, never truncated display/status/notification text。Public lifecycle v3 is reconciled exactly; missing/unsupported identity/output blocks。

0.74 background survival/revival is not orchestrator authority。Workflow-specific failureKind is normalized only when that selected public mode exposes it; ordinary single-agent completion does not require workflow-only fields。Normal lifecycle never depends on workflowScript/workflowScriptPath; released script RPC forms, if needed later, are script/workflow。

## 7. Plannotator Integration

See [Plannotator](./plannotator.md) for complete public payloads and persistence barriers。

PlanGate shared API is review-only and async: pending external reviewId then review-result/status。Exact current review-ready Plan/version/hash + fresh simplicity + external binding must agree before application。Persist intent before open, returned binding before use, settled result before Event/State。No inferred approval/reopen on unknown status。

CodeGate is synchronous: persist local attemptId + exact implementationRef/revision + review source before code-review request; actual payload uses cwd/VCS options or static patchFile。Result approved/feedback/annotations after Human completion is bound locally。No external Code reviewId or getCodeReview/status polling, no five-second Human timeout。

Both Gate results require unchanged current authority/source on settlement。Identical duplicates preserve current State; changed/stale results reject。Lost synchronous result leaves blocked local attempt for explicit recovery, not guessed approval/reopen。

## 8. Classifier / Jev Integration

#19 implementation: DecisionClassifierPort → PiClassifierDecisionClient → ctx.modelRegistry.classify, explicit default typesafe/jev-latest。Pi owns transport/provider/auth; core sees domain decisions/normalized errors。Require stopReason:stop plus complete answers; error/aborted is returned without necessarily throwing。Bool has probability only, Score no guaranteed probabilities; use Yes/No Choice for Boolean confidence。Pass maxRetries:0 and finite cancellation/deadline so each retry stays separately reserved。

The production command composition passes the active context.modelRegistry to the native adapter; absence fails closed rather than constructing another runtime/client。All six bounded family methods share the native boundary; existing Execution/Finding/Round runners use it, while Stage/mode/method lifecycle wiring remains #6/#8/#16。Old endpoint settings/URL consent fail closed。Reservation/result records bind native classifier, exact request and non-secret transport configuration digests, decision schema version and full validated Choice probabilities/confidence。Decision freshness includes classifier identity and relevant configuration for all coding families, including empty findings。Runtime authorization is revalidated separately。Pi 0.99.1 live native smoke passed and `pi-typesafe` is removed, with validation tracked in [#19 migration record](../implementation/native-classifier-migration.md)。

### Product Runtime Consent and Budget (I5)

Operator/project grant upper bounds canonical trusted project/classifier/destination/evidence categories/finite requests。After generated workflowId, persist workflow-scoped consent no broader than that grant (#11)。No preconfiguration of unknown workflowId is required。#11 implements `jev.runtimePolicy.grant` and lazy immutable `decisions/jev-authorization.json` → CAS `jevUsage.authorizationRef` before the first reservation. Both current grant and captured consent ceilings apply; settings widening never expands an existing binding, and narrowing/revocation is revalidated. Cached decisions validate consent/accounting without spending or rebinding. Grant ID/version, canonical project or classifier identity drift blocks rather than replacing authority. Old consent settings/history are not silently migrated; [implementation and live generated-ID smoke](../implementation/classifier-authorization.md) records the scope.

Before every outbound attempt—including per-finding and retry—validate active exact scope, persist immutable reservation then State/counter。Missing/revoked/mismatched consent, unknown/exhausted budget or save failure → zero network calls + operator-attention block。Use State returned by reservation in subsequent runner operations。

Timeout stays charged, client recreation cannot reset budget。Durable history includes predecessor, ordinal/request family, consent/grant/policy/classifier identity, allowance and safe numeric usage。Never API keys/auth headers/secret-bearing destination URLs。

Pi credentials/availability, typesafe enable, Plan approval or model confidence are not Product Runtime consent。Accounting ambiguity/collision fails closed; no default refund or fallback。

### Runtime Evidence / Adapter Policy Boundary

Runtime reads authoritative refs and assembles bounded task/Scout/Diagnosis/Research/clarification/document/Plan/repository evidence with provenance。Each family gets exact decision-critical constraints, branch/counters/history and input digest。Adapter only forwards supplied evidence; it never invents missing facts or drops constraints silently。

Finding/Round preserve B1 completeness, B3 provenance/history and B4 separate action/reason confidence/precedence。Launch/classifier/config identity changes invalidate applicable evidence; historical outputs stay advisory, not reauthorized。

## 9. Workspace / Worker / Oracle

Git and filesystem are first-class workspace variants。Capture stable manifest/baseline bytes/content identity, pre-existing changes, before/after and observation policy/exclusions。Non-Git static patch must be reproducible from retained baseline and current snapshot。Unsupported/unstable observation blocks before mutation/review。

Worker is sole automated implementation executor after approval。Local internal choice within strategy is permitted; material dependency/component/API/boundary/scope/method/seam/Validation change stops before implementation → deviation/workspace evidence → authority invalidation → Planning/simplicity/Human Gate。Core stop/replan works without Oracle。

Oracle is rare cross-cutting builtin read-only advisory, not stage/authority。Save trigger/finite budget/deadline/input refs/launch/attempt before dispatch, output after。Optional unavailable advice does not force mandatory consultation or grant permission; unresolved decisions use deterministic replan/Human attention。

#17 implements explicit supported-reason requests, workflow-wide 2-attempt / 300000ms bounds, immutable request/full-output advice, current State/evidence/launch freshness, and pending-run reconciliation before the same normal driver. Production composition exposes `advise()`; fresh advice reaches Planner as evidence only. Existing Human/operator blocks are not resolved by advice. Producer lifecycle #7/#14/#15 and integrated #12 coverage remain separate; see [implementation / real Oracle smoke](../implementation/oracle-advisory.md).

## 10. Errors / concurrency / persistence

Normalize external errors to domain blocked reasons: integration-unavailable, agent-infrastructure-unavailable, agent-execution-ambiguous, human-gate-unavailable, validation-infrastructure-error, operator-attention-required。Irrecoverable authority corruption alone is failed。

Passed Validation requires both reviewers in parallel, then complete evaluation/accepted artifacts。Dependent planning stages stay sequential。No multiple Workers/Coding Orchestrations in v1。

Exclusive workflow/ownership mutation boundary + revision check rejects stale writers。Required intent/authority/reservation → Artifact/State persist → side effect → validated output/State → next side effect。Never hold a cached State as authority after another reservation/result update。

## 11. Third-Party Dependency Boundary

No third-party source/node_modules/patch/fork/private API changes。Use released API → orchestrator-side adapter → blocked/unsupported → upstream release。Tool/extension capability gaps cannot be fixed by modifying dependency or weakening evidence。

## 12. Development / Test Process Boundary

Herdr is test/development harness only, no runtime/integrations/herdr.ts。

Real Pi integration/smoke: current HERDR_WORKSPACE_ID → new Herdr tab with repo cwd → returned root pane → Herdr agent lifecycle start → prompt/wait/read。No tmux/direct pi child_process spawn。Successful test closes tab; failure reports tab/pane/agent identity。#12 records exact production versions and full Git/non-Git/clarification/TDD/simplicity/deviation/Oracle/classifier/trust/launch paths after child implementation passes。
