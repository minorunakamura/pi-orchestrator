# Integrations

Version: 2.0 — v1 target contract (Issue #3)

## 1. Released platform boundary

v1 production baseline: **Pi / @earendil-works/pi-coding-agent >=0.99.1**, **pi-subagents >=0.74.0**。#19 removes the transitional pi-typesafe dependency after native migration and live smoke。

Use released public APIs only。Do not edit/fork/patch third-party packages or depend on main/Unreleased behavior。External shapes stay in `runtime/integrations/`; core sees normalized decisions/evidence/errors。Adapters do not mutate State or own Human authority。

Reviewed released references: Pi/pi-ai 0.99.1、pi-subagents 0.74.0、pi-typesafe 0.8.1、Plannotator 0.27.23、mattpocock/skills v1.2.3。Later installed/main docs are not baseline proof。Exact source/contract findings and unresolved publication gaps are recorded in [Dependency Contract Review](../implementation/dependency-contract-review.md); source review is not runtime validation。

The intended optional packages are **git:github.com/minorunakamura/pi-ketch** and **git:github.com/minorunakamura/pi-ask-user-question**, not same-name npm packages from other repositories。pi-ketch は operator が指定した GitHub-only distribution を使用し、#6 で commit `e49fd9ea48b675eef2ede729c9f13f7e12d44c20` の公開 package Agent / child tools / actual Research execution を検証した（[記録](../implementation/conditional-stage-routing.md#real-pi--research-integration)）。npm publication や新規 tag は必須ではない。Pi の公開 Git package contract により固定 revision を選択し、moving main の未検証変更を同等と扱わない。Question package の supported immutable source / root UI verification は #8 に残る。

## 2. Pi host / classifier

Pi provides Extension lifecycle、commands/events/tools、Main/root Agent、project trust and native classifiers。

#19 implementation: domain DecisionClassifierPort → PiClassifierDecisionClient → `ctx.modelRegistry.findOfType("classifier", provider, modelId)` / `ctx.modelRegistry.classify()`。Default is explicitly `typesafe/jev-latest`。No Codemode is required for extension-owned classifier requests。Pi resolves credentials/provider transport; Orchestrator must reserve and authorize each request first。

Native classifier Choice returns choice/probabilities/confidence, Score returns score/confidence (no probabilities field is guaranteed), Bool returns probability only。Use Yes/No Choice when domain Boolean confidence is required; don't relabel probability as confidence。

classify() returns stopReason stop/error/aborted rather than rejecting for service errors。Require stop plus complete schema-valid answers before using a result; preserve safe usage when available。Pass finite signal/deadline and maxRetries:0: the released System One transport otherwise retries internally (default 2), bypassing per-attempt reservation。Any retry is an explicit newly reserved Orchestrator call。Core keeps domain types; model availability/authentication is not consent。

Virtual Models remain Future Scope for v1 execution authority。Do not let a virtual routing decision obscure the physical model bound by Agent Launch Policy。

## 3. pi-subagents single-agent execution

Execution Plane, not Workflow Control Plane。Keep public async single-agent RPC spawn; review fanout is orchestrator-owned independent child execution。

```text
subagents:rpc:v1:request        method: spawn, params: agent/task/context/cwd/...
subagents:rpc:v1:reply:<id>     request correlation -> exact run identity
subagent:async-complete        exact run completion evidence
public lifecycle/status/output artifacts -> restart reconciliation
```

Do not move driveWorkflow(), State transitions, Human Gates or authority into workflow scripts。0.74.0 removed workflowScript/workflowScriptPath; if a later integration uses script RPC, released forms are `script` / `workflow`, not removed fields。That is not required for the ordinary single-agent path。

| Role | Agent / policy |
| --- | --- |
| Scout | product workflow-scout, evidence-only |
| Diagnosis | read-only evidence role; implementation may reuse a suitable definition, not a mutating Worker |
| Research | pi-ketch.researcher |
| Architecture / Planning | product planner; Architecture embedded in Plan |
| Plan Simplicity | product plan-simplicity-reviewer, read-only strategy findings (#14) |
| Worker | builtin worker, approved implementation strategy; explicit tdd when selected |
| Correctness | builtin reviewer, fresh read-only context |
| Ponytail | product ponytail-reviewer, actual implementation simplicity |
| Oracle | verified builtin oracle, rare bounded read-only advisory |

Builtin development-time scout/reviewer helpers do not prove product Agent existence。No finding-evaluator Agent: classifiers + core policy evaluate findings。

## 4. Agent Launch Policy / public preflight (#21)

All production child roles use one orchestrator-owned launch boundary before avoidable child side effects。

Public `pi-subagents/preflight` exports `resolveSubagentLaunchContract()`。The 0.74.0 public launch contract version is 3; protocol projection contains lifecycleArtifactVersion and packageVersion。Preflight resolves ordinary single-agent launches without creating child sessions/prompt temp files/run artifacts。

Validate/persist bounded projection:

- canonical selected Agent/source and versioned definition digest; reject inappropriate shadowing (especially builtin Oracle)
- resolved physical model / thinking and any candidate/fallback identity relevant to actual launch
- requested/resolved explicit skills, reject missing required skill
- effective callable tools / required / forbidden sets, MCP and extension capability effects
- fresh context, cwd/input/output binding
- inheritProjectContext / inheritSkills and relevant inheritance flags
- parent's project trust expectation (host public contract, not an invented preflight attestation)
- package/lifecycle/launch contract version, launchContractDigest and relevant preflight digest

Preflight resolves intent; ok:true / effectiveAllowlist is **not** attestation of loaded child tool providers, project trust, skill file bytes or complete repository context。Host-required diagnostics are not proof。Supply real host snapshots (runtimeSnapshotHost for built-in MCP, availableModels/parentModel and scopedModelIds when scoped is used); explicitly compare required/forbidden capabilities。Unresolved execution-critical facts deny dispatch or fail child startup before model/mutation work, never default into capability permission。

For single-agent RPC, express thinking through model provider/id:level; the model-facing dispatch thinking field is ignored in 0.74.0。Preflight's thinking input and foreground delegation's thinking field are different public contracts, not permission to invent an RPC parameter。

Use identical execution-affecting parameters and Intercom bridge config for preflight/spawn。Capture actual receipt/digest and runtime tool registration checks; don't confuse placeholder runId/projected roots with a launched run。definitionDigest covers parsed Agent definition; launchContractDigest excludes runtime acceptance/output-task annotations and is not an input-file/skill-body content hash。Keep authoritative input hashes and any required skill-content/source identity separately。

A separately installed Pi package is not automatically a Node dependency of pi-orchestrator。#21 must make the public preflight subpath resolvable through supported dependency loading and verify its package/source/version corresponds to the execution owner; no private installed-file lookup or assumed shared module instance。

Policy object is orchestrator domain data, not raw third-party types。A preflight success is not Workflow authority。Persist launch evidence + attempt intent + State before dispatch; exact public run receipt follows as soon as exposed。

Changed model/thinking/skills/tools/definition/launch digest is not the same attempt。Resume binds historical receipt, not new ambient defaults。Worker profile continues to come from approved routing authority; evidence/review roles use explicit role-profile policy。

## 5. Trust / explicit skill isolation

pi-subagents 0.74.0 children follow parent project trust。#18 additionally selects public Agent discovery scope from the host's isProjectTrusted(): trusted → agentScope:both, untrusted/unknown → agentScope:user。This excludes project Agent definitions/overrides before launch; native resource trust inheritance alone does not restrict Agent discovery。Orchestrator does not reimplement trust loading: trust-gated project settings/.pi system prompts/skills/extensions must be skipped when untrusted。Pi's sessionDir lookup occurs before trust, and AGENTS.md/CLAUDE.md context discovery is **not** trust-gated; trust is not a filesystem/OS sandbox。When role policy excludes repository instructions, use the public inheritProjectContext:false contract, not assumed trust behavior。Preflight has no projectTrusted input/attestation; actual parent trust inheritance needs host contract/smoke coverage。

`inheritSkills: false` removes inherited skills including extension-added child skills。Explicit Agent `skills` or launch `skill` selection still selects required skills through the public contract。TDD Worker explicitly selects `tdd`; optionally `codebase-design` supports seam vocabulary。Resolve inheritance flags via released Agent definition/settings contracts and verify preflight; do not invent unsupported per-spawn inheritance parameters。Missing required skills fail before dispatch; builtin Worker inheritance is not assumed。

Builtin Worker also defaults reads to context.md/plan.md and progress tracking; #21 must disable or scope-bind those behaviors through supported Agent/settings/output contracts so unrelated root files or default artifacts do not override exact approved inputs/change surface。Preflight's excluded runtime output-task annotations are not proof of that binding。

Clarification is root/Main, not a delegated child question loop。grill wrapper availability is not required when the underlying public skills/tool path is supported。

## 6. Bounded read-only Codemode (#20)

0.74.0 native children can load Pi built-in codemode when tool selection permits it。#20 initial roles are workflow-scout / plan-simplicity-reviewer; correctness/ponytail reviewers are optional after evidence。Worker、root/Main、Oracle/Research expansion、Human Gates、Validation、persistence/classifier authority are not added by #20。

Verify effective **callable** tools, not only active/model-visible declarations: deferred/codemode-exposure tools remain callable while inactive。Deny edit/write, unrestricted mutating shell, mutation MCP/extensions and nested execution/authority paths。denyExtensions:true also prevents automatic child Codemode registration, so it cannot simultaneously serve as proof that Codemode is available。

Stock Codemode separately exposes models.classify with session credentials by default; allowedTools does not account for or deny this non-tool model namespace。#20 must disable models through the official exported createCodemodeExtension({ models:false }) in an orchestrator-owned child extension using supported public extension loading/replacement, or leave Codemode disabled/unsupported until that isolation is proven。Do not treat a tool ceiling, annotation or prompt instruction as classifier consent enforcement。

Script timeout_ms is unset by default and max_output_tokens is model-supplied, not a trusted policy ceiling。Require finite public child/toolTimeoutMs and output acceptance bounds outside optional script hints。Keep provenance/full-output identity checks; unsupported/unverifiable ceiling fails closed。

Codemode scripts cannot invoke model-only `subagent`, `subagents_enable`, `subagent_supervisor`, `contact_supervisor`, `structured_output` in the released Pi 0.99 / subagents 0.74 behavior。Do not route lifecycle/approval through scripts。Runtime state in Codemode is not an authoritative Artifact; outputs still pass immutable provenance/identity validation。

## 7. Bounded output / stop / recovery

- Finite adapter response deadlines even with no RPC subscriber。
- Persist request correlation before dispatch; requestId is not runId。
- Persist exact run/session/launch/output receipt when exposed, even on failure。
- Use full validated output file/structured result, never truncated display or notification prose as authoritative output。
- Timeout/issued stop does not prove cancellation, terminal completion or absence of mutation。
- Public lifecycle v3 status/receipt/output identity must match historical launch; unsupported versions/missing files block。
- Background survival/revival across reload is upstream execution behavior, not automatic orchestrator recovery authority。
- Never blindly retry/relaunch a possibly mutating Worker。

Workflow-specific `failureKind` is used only when the chosen public execution mode exposes it (primarily workflow-script status/details)。Do not require or fabricate workflow-only failureKind for single-agent completion。

## 8. Native Jev adapter / authorization

#19 replaces direct client construction with Pi's public ModelRegistry。`JevIntegration` and `PiClassifierDecisionClient` are the same adapter; no model-facing typesafe_evaluate, `/typesafe enable`, direct backend registry or automatic evaluator fallback。

`jev.classifier` selects explicit provider/model (default typesafe/jev-latest); consent destination binds that exact provider/model。Legacy jev.endpoint / URL consent is rejected, not silently migrated。All six family contracts use native Choice; existing three production coding runners are connected, planning lifecycle remains #6/#8/#16。Pi 0.99.1 live native Jev smoke passed; `pi-typesafe` is removed。See [#19 verification and removal gate](../implementation/native-classifier-migration.md)。

Orchestrator owns operator/project grant upper bounds, generated-workflow scoped consent and finite attempt budget (#11)。Credentials/model availability/Plan approval are not authorization。Reservation Artifact → State before every outbound attempt, including per-finding/retry。Timeout stays charged; no secret durability or silent transport fallback。

## 9. Research / clarification / domain documentation

workflow-scout generates local facts; pi-ketch.researcher generates source-backed external facts using ketch_docs/code/search/scrape。Research is v1 conditional, resolved after Scout/Diagnosis。

Clarification:

```text
GRILL_ME        root/Main Pi Agent -> grilling -> ask_user_question -> Human
GRILL_WITH_DOCS root/Main -> grilling + domain-modeling -> Human + authorized docs
SKIP           sufficient durable evidence
ESCALATE       Human/operator attention
```

Jev routes mode but does not generate questions/answers。domain-modeling is only within GRILL_WITH_DOCS, not independent Stage。Writes require Orchestrator-owned exact allowed CONTEXT/ADR paths and durable before/intent/after evidence; source mutation remains unauthorized。See [Planning](../detailed-design/planning-orchestration.md)。

## 10. Plannotator

Shared public event channel plannotator:request, envelope { requestId, action, payload, respond } and handled/unavailable/error response。Reviewed released public contract: @plannotator/pi-extension 0.27.23 (reference version, not a silently raised project minimum)。The shared plan-review path is review-only; executionMode:external governs Plannotator's own plan-mode/submit-plan handoff and must be used if that alternative entry is integrated。Neither path permits Main/Plannotator to implement outside Orchestrator authority。

| Gate | Public payload / response | Orchestrator binding |
| --- | --- | --- |
| Plan | plan-review `{ planContent, planFilePath? }` → `{ status: "pending", reviewId }`; review-result event / review-status | external reviewId + exact Plan version/hash + fresh simplicity |
| Code | code-review `{ cwd?, defaultBranch?, diffType?, vcsType?, useLocal?, prUrl?, patchFile? }` → `{ approved, feedback?, annotations? }` after Human completion | **local attempt persisted before request** + exact implementationRef/revision + review source |

Code Review is synchronous, has no external reviewId/status-polling contract。Human duration is not a five-second integration timeout。Non-Git passes generated static patchFile (mutually exclusive with prUrl), bound by path/hash/before-after snapshots。

Persist settled result before domain approval/feedback Event, State before continuation。Check source/implementation still current at settlement。Lost synchronous result = blocked explicit recovery, not fake polling/reopening/approval。See [Plannotator Detailed Design](../detailed-design/plannotator.md)。

## 11. Oracle / reviewer / Main boundaries

Oracle uses builtin identity + enforced read-only policy, finite budget/deadline/input/output refs。Released builtin oracle includes bash and defaults context:fork: advice prose/acceptanceRole do not remove mutation capability。Explicitly narrow tools with public capability ceiling/settings (remove bash unless a proven read-only adapter exists), select context:fresh with durable supplied evidence, and verify source/digest/overrides without patching builtin definition。Advice cannot mutate State/files, approve Plan/Code or grant Fix/implementation authority。

Plan Simplicity Reviewer checks proposed strategy before Human approval; Ponytail checks actual code after deterministic Validation。Both are evidence-only; repository evidence is mandatory for strategy simplicity findings。

Main/root owns Human communication and authorized clarification only。Active-workflow guard rejects source mutation or indirect bypass through tools/children; narrow domain-document writes do not grant general implementation authority。Public tool_call hooks cover model-issued tools and ctx.executeTool nested/MCP calls, not arbitrary trusted extension code's direct pi.exec/filesystem access。tool_call handlers run in registration order and may mutate arguments without automatic revalidation; a path check before a later mutation is not final execution authorization。#5 must bind/validate effective execution inputs, not merely an earlier hook snapshot。Unknown mutating tool providers must be denied; trusted extension code/operator out-of-band edits are not an OS sandbox guarantee and require workspace drift detection。Impossible enforcement fails closed。

## 12. Error normalization / testing

External auth/transport/schema errors normalize to integration-unavailable; child pre-dispatch infrastructure failures to agent-infrastructure-unavailable; possible dispatch/unknown result to agent-execution-ambiguous; Plannotator failure to human-gate-unavailable; Validation infrastructure to validation-infrastructure-error。External error classes do not escape into core。

[#18 platform smoke](../implementation/platform-baseline-smoke.md) records released public preflight compatibility, real native single-agent RPC/lifecycle v3, untrusted resource exclusion and explicit skill isolation with an offline model provider。#21 launch authority and #20 read-only Codemode remain separate implementations; current product Agent definitions do not enable Codemode。Adapter contracts + fake scenarios precede live tests。Real Pi integration/smoke uses a **new Herdr tab**, not tmux/direct Pi spawn。Herdr is a test harness, not runtime dependency。Exact baseline versions, trust/isolation/preflight/Code Review/classifier/non-Git behavior are final #12 production-path evidence; no release claims from this design-only change。
