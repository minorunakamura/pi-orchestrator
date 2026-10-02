# Pi Orchestrator Test Strategy

Version: 2.0 — v1 target contract (Issue #3)

## 1. Scope / validation status

Tests cover v1 contracts, not evidence that design-only changes implement them。Pi >=0.99.1 / pi-subagents >=0.74.0 are production baselines; #19 uses native classifier typesafe/jev-latest and removes transitional pi-typesafe after live smoke。Child Issues add focused tests as producers change; #12 integrates host contracts and real production smoke。

For documentation-only #3: validate required docs/links, consistent phase/event/artifact/matrix/authority contracts, and review versioned public dependency declarations/docs with recorded provenance ([Dependency Contract Review](../implementation/dependency-contract-review.md)); run existing pnpm check。Internal link/enum checks and existing tests alone do not prove dependency compatibility。No real Pi smoke or live classifier request is required to validate prose changes, and no redesigned-runtime PASS is claimed。

## 2. Layers

```text
pure core -> persistence -> adapter contracts
 -> real runners + fake ports -> recovery/fault injection
 -> production host contracts -> real Pi / Herdr smoke
```

Core tests have no Pi/filesystem/network SDK dependency。Persistence uses temporary filesystem roots。Fake scenarios connect real State/Artifact/policy/runners; successful scenarios must not manually fabricate transition/approval to bypass a stage。No third-party modification/test prerequisite。

## 3. Core / policy matrix

| Area | Required assertions |
| --- | --- |
| State transitions | every State Machine row; invalid phase/event rejected; INV-001–016 |
| Human Gates | every playbook requires exact Plan approval and exact Code approval; no inferred result |
| Stage matrix | Scout always; bugfix/hotfix Diagnosis; all Research/Clarification conditional; Architecture matrix; required/skip never classifier-overridden |
| Sequential routing | each decision reads accumulated durable refs; start-time transient hints cannot skip; stale input/policy rejected |
| Clarification modes | SKIP/GRILL_ME/GRILL_WITH_DOCS/ESCALATE; classifier cannot generate questions/answers or authorize docs itself |
| Development Method | explicit Human TDD wins; clearly inapplicable STANDARD; eligible bounded routing; low confidence Human attention; missing TDD seams blocks |
| Plan simplicity | evidence-backed findings, exact hash/version, any change stale, same-cycle one-shot cap survives restart; residual findings Human-visible |
| Strategy boundary | local internal choice allowed; material API/dependency/component/boundary/scope/method/seam/validation change stops/replans |
| Execution/Finding/Round | confidence threshold equality/below, accepted Fix subset, B4 precedence for every action and independent reason confidence |
| Retry/advisory | finite automated/stronger/Oracle/classifier bounds; strongest profile/no infinite loop; Human feedback counted separately |
| Oracle | no approval/State/files/implementation/Fix authority, unavailable optional advice cannot authorize mutation |

## 4. Persistence / fault barriers

Assert immutable Artifact/hash/schema, atomic State write, stateRevision/stale writer rejection under exclusive lock, on-demand dirs, no secrets。

Inject failure before/after each intent/output Artifact and State barrier:

- task/ownership/launch/preflight/child dispatch/receipt
- stage/mode/method decision / per-request reservation
- clarification request / confirmed answer / exact docs write before-intent-after
- candidate/simplicity/refinement-cap/review readiness/async Plan open binding
- Worker routing/intent/baseline/received result/after snapshot/implementation success
- material deviation/authority invalidation/replan
- Validation/reviews/evaluation/accepted/Round/history
- static patch/local synchronous Code intent/settled result
- Oracle budget/launch/output

Failed pre-effect State save → zero external/network/Worker/write/gate calls。Failure after possible mutation/result loss → preserve exact intent/identity and block, never blind redispatch/reopen/approval。

Existing stale/dead-owner workflow lock fails closed; PID/age alone cannot auto-delete another owner's lock。Revision check is not an independent filesystem atomic CAS outside locking。

## 5. Platform / launch contract tests (#18/#21)

#18 implementation adds released preflight compatibility tests (`tests/platform/preflight.test.ts`), trust-aware RPC scope regressions and an opt-in real native-child Herdr harness (`tests/platform/smoke-extension.ts`)。Exact versions/results/reproduction and offline-model limitations are recorded in [Platform baseline smoke](../implementation/platform-baseline-smoke.md)。#21 still owns product launch policy/durable freshness; #20 still owns Codemode enablement。

Use released 0.74.0 public preflight/RPC fixtures, not main/Unreleased shapes。Cover:

- all production roles use explicit Launch Policy
- missing/ambiguous Agent, shadowed builtin Oracle, missing required model/skill/tool, unverifiable host fact → no dispatch
- physical model/thinking, explicit skill set, effective callable tools/MCP/extensions, definition digest, inheritance, context, output and package/lifecycle/launch digest freshness; ok:true alone is not runtime-provider/skill-bytes/trust attestation; single-agent RPC uses model thinking suffix, preflight/execution package resolution matches
- equal task/refs with changed model/skills/tools/definition cannot reuse equivalent attempt
- actual receipt/digest matches preflight input, placeholder runId is not actual runId
- parent's project trust inherited for trust-gated settings/.pi prompts/skills/extensions; sessionDir/AGENTS context exceptions preserved, inheritProjectContext:false tested separately
- inheritSkills:false removes inherited/extension-added child skills; explicit tdd (+ optional codebase-design) resolves through public selection
- full authoritative output from exact receipt, truncation/display prose not used
- single-agent completion does not require workflow-only failureKind; normalize it only in modes that expose it
- stop request/timeout is not cancellation/completion proof; survival/revival is reconciled, not assumed

No subscriber, wrong request/run tuple, response/timeout race, late response and partial reviewer fanout settle finitely and release timer/listener (I4)。Possible mutating dispatch remains ambiguous with baseline/run identity retained (I2)。Stronger retry never resumes a weaker retained Worker。

## 6. Native classifier / consent tests (#19/#11)

All six families use Pi native classifiers with explicit default typesafe/jev-latest。Assert maxRetries:0 and finite signal/deadline; provider error/aborted returned with resolved Promise cannot authorize decisions。Bool probability and Score score/confidence fields must match the native contract; don't expect Score probabilities or treat Bool probability as confidence。Capture actual bounded requests and verify runtime-assembled refs/excerpts/provenance, exact classifier/schema/policy/config input identity, probabilities/confidence and safe usage normalization。Adapter cannot read ArtifactStore or invent constraints。

Fixtures: valid/low-confidence/unknown choice/missing result/schema mismatch/auth/timeout/transport errors。Boolean dimensions retain required confidence。Action and escalation reason remain separate; high action confidence cannot mask uncertain reason。

Generated workflowId receives consent derived from operator/project grant upper bounds。Missing/revoked/mismatched grant/consent, classifier/destination/category mismatch, unknown/exhausted allowance and failed reservation → zero requests。Per-finding and transport retries reserve durably; client recreation doesn't reset, timeout doesn't refund (I5)。Pi key/availability, typesafe enable and Plan approval are not consent。

Live native smoke precedes pi-typesafe removal。During transition, validated destination-specific credential prevents arbitrary TypeSafe-authenticated endpoint rewrite。No automatic second transport/classifier/LLM fallback。

## 7. Clarification / ownership / Codemode tests

Production root/Main bridge invokes grilling + ask_user_question; GRILL_WITH_DOCS also domain-modeling。Test direct underlying skills when wrappers unsupported, verify selected package source (not same-name npm) and TUI-only availability, require final shared-understanding confirmation from grilling。Facts researched, Human decisions confirmed; decline/unavailable/timeout cannot become SKIP/guessed answer。

Allow exact CONTEXT/CONTEXT-MAP/nested CONTEXT/ADR paths only after intent/before persistence; reject traversal, symlink escape, source/config writes, stale clarification binding and unrecorded mutation。Partial write blocks retry; after evidence and answers update downstream input freshness。

Main direct edit/write/shell/MCP/indirect child mutation cannot bypass active owner/Plan/Worker authority。Tool hooks are not a sandbox for arbitrary trusted extension pi.exec/filesystem code; unknown mutation providers denied, out-of-band edits invalidate workspace authority。Narrow docs exception is not general write permission; conflicting workspace owner fails closed。

Codemode read-only tests inspect effective callable ceiling, not declarations: prove models namespace disabled through official factory/public child replacement, provider retries cannot bypass consent, denyExtensions isn't mistaken for Codemode availability, finite child/tool bounds cannot be omitted by script hints. Initial #20 roles remain Scout/simplicity, optional correctness/ponytail only. Verify builtin Oracle bash is denied/narrowed and context explicitly selected. Check  mutation and nested execution/authority/unreserved classifier tools unavailable, bounded parallel read/provenance/output, no script calls to model-only subagent/supervisor/structured-output controls。Unverifiable ceiling disables capability rather than trusting prompt annotations。

## 8. Workspace / Plannotator tests (#10/#9)

Git and filesystem variants: stable canonical root/manifest/exclusions, existing dirty changes, unborn Git, untracked files, added/modified/deleted non-Git entries, baseline bytes for patch, after identity/source drift。Unsupported binary/type/link/submodule/unstable observations block rather than omit evidence。Resume cannot silently switch the persisted Git/filesystem provider identity。

Plan async payload/pending/reviewId/result/status with exact current Plan/hash/version/simplicity binding。Missing binding/unknown status/restart/changed result rejects; identical duplicate preserves current State. Open/binding save failures do not grant usable authority or automatic reopen。

Code synchronous actual public `{ approved, feedback?, annotations? }`, cwd/VCS or patchFile payload, no external reviewId/status polling。Pre-persist local attempt/source before request; failed save makes zero calls。Controlled long Human wait is not five-second failure. Lost synchronous response blocks explicit recovery without fake polling/reopen。

Static patch path/hash/before-after identity (patchFile mutually exclusive prUrl) binds non-Git Gate。Source mutation during Human review, patch tampering, same revision/different implementation hash, missing local attempt or changed result rejects approval。Result Artifact before Event/State; idempotent duplicate no new revision/counter。Feedback/new implementation needs a new gate。

## 9. Retained B1–B5 / I1–I5 coding coverage

- B1: passed round requires both raw reviews/evaluation/accepted with exact workflow/Plan/implementation/round. Empty means persisted empty arrays. Missing/stale/partial evidence or incorrect ID coverage/subset stops before Round call/event。
- B2: ValidationRunner derives commands/cwd/checks from exact hash-valid Approved Plan; substitution/invalid contract stops executor. Result binds contract digest/coverage/required aggregation。
- B3: bounded constraints/implementation/validation/history provenance; lost previous decision or unsafe truncation cannot grant authority。
- B4: Human then uncertain/low-confidence action/reason outranks retry/capability/blocking override for all raw actions, including mixed findings。
- B5: local synchronous Code binding/source, not old external ID; no stale completion。
- I1: all current applicable identity/input/policy/config/classifier/launch fields required for reuse。
- I2/I4: durable dispatch/mutation evidence + finite waits; no duplicate Worker/false cancellation。
- I3: infrastructure distinct from failed check; stopOnInfrastructureFailure true blocks, false only Human/uncertain, no auto retry/complete while unresolved。
- I5: finite reservation-before-request survives restart, zero unauthorized outbound calls/no secrets。

## 10. Full fake scenarios / recovery

Required connected scenarios: all-playbook planning readiness, feature happy path, bugfix/hotfix Diagnosis, conditional RUN/SKIP/ESCALATE, both clarification modes/docs writes, explicit/routed TDD, simplicity clean/one-shot/residual findings, Plan feedback, validation/finding/stronger retry, retry exhaustion, material stop/replan/reapproval, optional Oracle, Human Code feedback, Git/non-Git Code approval, integration block and corruption failure。

Recovery injects process death after external output/before Artifact, after Artifact/before State, after State/before next effect, during child/Worker/Validation/async Plan/synchronous Code/clarification docs/classifier/Oracle。Reconcile historical exact identity before same-driver continuation; no stale approval, duplicate mutation, inferred answer or silent launch drift。

Single normal /wf-* invocation must reach genuine wait/completion without repeated resume. Accepted result wakes normal driver; /wf-resume only reconciles + continues。

## 11. Real Pi / Herdr production verification (#12)

Real Pi integration/smoke uses dedicated **new Herdr tab**, never tmux/direct child_process.spawn(pi)。Topology:

```text
herdr tab create --workspace <HERDR_WORKSPACE_ID> --cwd <repo> --label <unique> --no-focus
 -> returned .result.root_pane.pane_id
 -> herdr agent start <unique> --kind pi --pane <pane-id> -- <pi args>
 -> prompt / wait / read / assertions
```

Herdr is not runtime dependency。Success closes tab; failure reports tab ID/pane ID/agent name, may preserve diagnosis。

Record exact Pi/subagents versions and native classifier provider/model identity; test real production composition, not fake replacement of Gates/clarification/classifier paths。Required live matrix: normal driver + recovery, actual Human Plan/Code Gates, Git/non-Git static patch, GRILL_ME/GRILL_WITH_DOCS, TDD/seams/explicit skills, simplicity/refinement, material deviation/reapproval, rare Oracle, native classifier consent/budget, public launch/trust/isolation/Codemode restrictions。

No release evidence/CHANGELOG PASS until all child/required production checks pass。Unavailable credentials/Human environment are explicit unperformed/blocked validation, not success。
