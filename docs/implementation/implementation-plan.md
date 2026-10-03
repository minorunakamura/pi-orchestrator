# Pi Orchestrator v1 Implementation Plan

Version: 2.0 — Issue #3 design foundation

## 1. Source of truth / status

[GitHub Issue #13](https://github.com/minorunakamura/pi-orchestrator/issues/13) tracks dependencies/order/completion; each child Issue defines its scope and acceptance criteria。This document maps the canonical v1 design to that work, not new speculative Stories。

[Issue #3](https://github.com/minorunakamura/pi-orchestrator/issues/3) is documentation-only and first in the dependency order. It has **no prerequisite implementation Issue**. At this design update, #4–#12 and #14–#21 are OPEN; none is assumed complete。#13 remains open until all children/production-path criteria pass。

Basic/Detailed Design describe **target contracts**, not current production readiness。Historical ORCH-001–020 / v0.1.0 implementation and validation remain in [v0.1.0 release evidence](../release/v0.1.0.md) and Git history; that PASS is not redesigned v1 approval。

### ORCH-020 — End-to-End Hardening and Initial Scope Release Candidate

Historical link compatibility only: the v0.1.0 ORCH-020 completion/PASS is recorded in [release evidence](../release/v0.1.0.md). This section does not grant redesigned v1 readiness or modify the historical validation record.

## 2. Existing implementation vs v1 target

Inspected sources before design revision:

| Current code / fact | Target owner |
| --- | --- |
| #18 package/lockfile: Pi 0.99.1, pi-subagents 0.74.0 (contract-test dev), direct pi-typesafe 0.8.1 | native classifier/direct dependency removal #19; launch policy #21; [platform verification](./platform-baseline-smoke.md) |
| commands start only startWorkflow/gatherContext; resume/Reconciler does phase work | #4 normal driveWorkflow; resume reconciliation + same-driver continuation |
| core playbook flags resolved at start from transient hints; hotfix/chore Research skip; no Diagnosis | #6 sequential conditional evidence / #7 required Diagnosis |
| #8 production root bridge, durable Human rounds/confirmation and narrow docs intents are connected | [Clarification evidence](./clarification.md); general ownership is #5, integrated verification is #12 |
| parser/Planner require Implementation Plan, no method/seams/simplicity | #16 then #14 approved strategy/readiness contract |
| AgentRunRequest lacks full explicit launch policy/preflight projection | #21 all child roles bind model/thinking/skills/tools/definition/digest |
| direct Jev library adapter, exact future workflowId consent config | #19 native classifier / #11 project grant -> generated workflow consent |
| Worker evidence uses Git-only repository observer | #10 filesystem baseline/patch review |
| Plannotator adapter assumes async pending/reviewId/status for Code and five-second timeout | #9 actual synchronous Code result + local attempt |
| no material deviation protocol / bounded builtin Oracle / active Main guard / read-only Codemode policy | #15 / #17 / #5 / #20 |

Subsequent #19 update: all six classifier port families use Pi native typesafe/jev-latest; the existing three production coding families are connected, old endpoint/URL consent is rejected and pi-typesafe is removed after live Pi 0.99.1 smoke。See [migration verification](./native-classifier-migration.md)。The table above is the pre-redesign inspection, not current transport status。Stage/mode/method lifecycle wiring remains #6/#8/#16 and generated-workflow grant/binding remains #11; this migration does not implement those child Issues。

Subsequent #4 update: commands now use createWorkflow → driveWorkflow over existing runners, and /wf-resume reconciles historical authority before the same driver. Plan result notifications wake normal continuation; Validation/review/Fix loops no longer require phase-by-phase resume. See [driver foundation coverage and limits](./normal-workflow-driver.md). Later stage implementation and driver integration remain owned by #6/#7/#8/#16/#14/#17/#15; synchronous Code Gate correction remains #9. Missing required target stages are not success/SKIP/approval, and foundation tests do not establish full v1 readiness。

Subsequent #6 update: Research/Clarification/Architecture は Scout 後に accumulated durable evidence から逐次解決し、stage/mode decision の immutable persistence / freshness / conservative escalation を normal driver に接続した。旧 transient hints は authority にしない。Diagnosis ref を消費するが、bugfix/hotfix の missing producer は block し、実行は #7。root bridge は #8、consent capture は #11。Research は operator 指定の GitHub-only source / commit `e49fd9e` と実 Pi child を検証し、Ketch-only tools / context inheritance の policy 不整合を修正した。詳細は [#6 implementation / coverage / limitations](./conditional-stage-routing.md)。

Subsequent #7 update: bugfix/hotfix は Scout → required read-only Diagnosis → routing を normal driver が自動継続する。Structured symptom/reproduction/root-cause/gap/dependency/scope/risk evidence を immutable Artifact と State に保存し、routing/Planner が exact input/launch freshness を検証する。Completed Diagnosis は再 dispatch せず、hotfix scope-exceeded/unknown は Human reclassification/replanning 待ちで停止する。詳細は [Diagnosis implementation / acceptance / validation](./diagnosis.md)。Root clarification/consent/TDD/Plan strategy/non-Git/Code corrections/full lifecycle は各既存 producer / #12 のまま。

Subsequent #8 update: production root/Main は resolved grilling / mode-aware domain-modeling と public questionnaire v1 から durable request → rounds → final Human confirmation → exact CONTEXT/ADR intent/before/after → CLARIFICATION_COMPLETE → normal continuation を実行する。Transient prompt / prose-only answer / mode-only write grant に依存しない。Both-mode actual Human TUI + real Planner smoke と focused persistence/authority tests は [Clarification implementation / acceptance / validation](./clarification.md)。Generated-workflow consent は #11、general ownership は #5、full production Human Gates は #12 のまま。

Existing immutable Artifacts, exact approvals, lock/stateRevision, stale decisions, B1–B5/I1–I5 coding safety remain required; redesign must not weaken them while replacing incompatible contracts。

## 3. Dependency order

```text
#3 design
 -> #18 platform baseline
 -> #21 Agent Launch Policy   ||   #19 Pi native classifier
 -> #4 normal lifecycle driver
 -> #6 sequential conditional routing
 -> #7 Diagnosis
 -> #8 clarification bridge / docs authority
 -> #11 workflow consent
 -> #16 Development Method / explicit TDD skills
 -> #14 strategy Plan / simplicity review
 -> #15 material deviation
 -> #10 workspace/non-Git   ||   #9 synchronous Code Gate
 -> #5 active Main ownership guard
 -> #12 production verification
```

Cross-cutting work:

- #17 Oracle foundation after #21, may progress beside #6; integration of hard advisory paths as callers exist。
- #20 bounded read-only child Codemode after #21 and target read-only Agents exist, parallel once possible。Optimization, not authority dependency。
- #19 may run beside #21 after #18; #11 authorization remains independent of transport removal。
- #14 is a hard strategy dependency for #15。#17 is only dependency for Oracle-assisted deviation, core stop/replan fails closed without Oracle。
- #9/#10 may run together once local exact review-source contract is fixed。
- #5 final enforcement integrates driver/clarification/trust/workspace; its authority contract is already fixed by #3。

Do not close/check tracking items merely from design updates. Normally one child Issue per PR, closing only that child after its validation passes。

## 4. Child contract / acceptance map

| Issue | Implement / canonical reference | Required focused validation |
| --- | --- | --- |
| #3 | Basic/Detailed/README consistency; target vs current distinction | required docs, links, same State/Event/Artifact/matrix, scope audit, pnpm check |
| #18 | released Pi >=0.99.1 / pi-subagents >=0.74.0 / pi-typesafe >=0.8.1 transition; package/lockfile | public protocol/version, trust/isolation, no arbitrary credential forwarding, real version smoke |
| #21 | [Runtime §6](../detailed-design/runtime-design.md#6-pi-subagents-integration), all-role preflight/launch identity | missing Agent/skill/tool/model zero dispatch; drift/stale receipt; bounded secret-free evidence |
| #19 | [Decision Engine](../basic-design/decision-engine.md), all six native classifier families | actual Pi classify path, confidence/schema/freshness, no fallback, consent reservation, live smoke before dependency removal |
| #4 | [Runtime §2](../detailed-design/runtime-design.md#2-normal-driver-vs-recovery), normal driver | single command reaches genuine wait/completion; resumed reconciliation uses same driver; no duplicate mutation |
| #6 | [Planning §2](../detailed-design/planning-orchestration.md#2-sequential-evidence--stage-routing) | required/skip deterministic, conditional low confidence no silent skip, sequential input freshness |
| #7 | required bugfix/hotfix Diagnosis before later planning | reproduction/hypothesis/location evidence durable, restart/source drift |
| #8 | [Planning §3–4](../detailed-design/planning-orchestration.md#3-clarification-production-bridge) | root Human/tool/skill flow, answers not invented, exact narrow docs paths/before-after/save failures |
| #11 | [Configuration §6](../basic-design/configuration.md#6-operatorproject-grant-vs-workflow-consent-11) | generated workflow consent, revocation/scope/finite budget/retries/client restart zero unauthorized calls |
| #16 | [Planning §5](../detailed-design/planning-orchestration.md#5-development-method--tdd) | explicit Human TDD precedence, low-confidence eligible routing, seams approval, explicit isolated tdd launch |
| #14 | [Planning §6–9](../detailed-design/planning-orchestration.md#6-planner-input--plan-contract) | strategy sections, repository-supported simplicity, one-shot cap/restart/changed hash freshness, Human-visible residual findings |
| #17 | [Basic §10](../basic-design/basic-design.md#10-oracle-advisory) | builtin/read-only launch, finite intent/output, no State/files/approval/Fix authority; unavailable optional advice safe |
| #20 | [Integrations §6](../basic-design/integrations.md#6-bounded-read-only-codemode-20) | callable tool ceiling, blocked mutation/indirect execution, output bounds/provenance, no model-only controls in scripts |
| #15 | [Coding §5](../detailed-design/coding-orchestration.md#5-worker-input) | local approved choices continue; material change stops before mutation; durable replan + new simplicity/Human approval |
| #10 | [Artifacts §5](../basic-design/artifacts.md#5-workspace-evidence--code-review-source) | Git/filesystem before-after/pre-existing/baseline bytes/added-modified-deleted/static patch identity; unsupported entries block |
| #9 | [Plannotator](../detailed-design/plannotator.md) | real synchronous public Code shape, no Human duration timeout/external code polling, local intent/source stale rejection |
| #5 | [Runtime §5](../detailed-design/runtime-design.md#5-active-workflow-ownership--main-guard-5) | Main direct/indirect mutation blocked; only exact clarification docs exception; untrusted injection/ownership conflict |
| #12 | [Test Strategy](../detailed-design/test-strategy.md) | integrated host/fault/Git/non-Git/live classifier/actual Human Gate smoke in new Herdr tab |

## 5. Required retained safety matrix

| Contract | Redesign obligation |
| --- | --- |
| B1 review completeness | passed round has correctness/ponytail/evaluation/accepted with exact Plan/implementation/round; empty arrays persisted |
| B2 validation authority | exact approved Plan contract alone reaches executor; result binds digest/check coverage |
| B3 classifier evidence | runtime-assembled bounded approved constraints/provenance/history; no lost history/unsafe truncation |
| B4 uncertainty precedence | Human/uncertain/low action or reason confidence outranks retry/capability, including mixed blocking findings |
| B5 Code exact binding | synchronous local attempt/source before request, stale/lost result cannot be current approval |
| I1 freshness | decision schema/classifier/input refs+digest/policy/config/revisions and relevant launch identity |
| I2 Worker evidence | launch/routing/intent/baseline before dispatch, actual receipt/after-workspace retained even on ambiguity |
| I3 Validation infrastructure | distinct from check failure; no automatic retry/completion while unresolved under either setting |
| I4 bounded child waits | no subscriber/late/mismatch/race settles safely; timeout/stop not cancellation/completion proof |
| I5 consent/accounting | grant upper bounds + workflow consent + finite reservation every outbound attempt before request |

Add strategy simplicity freshness/refinement cap, TDD seam approval, docs-write before/after, Oracle read-only ceiling, Main bypass prevention and non-Git review-source coverage. Each producer Issue leaves executable tests before #12 final integration; final tests do not compensate for unfinished children。

## 6. Development / validation rules

The [Dependency Contract Review](./dependency-contract-review.md) records released API evidence separately from internal documentation checks. #19 must disable hidden native retries and validate returned stopReason; #21 cannot treat preflight as complete runtime attestation; #17 must narrow builtin Oracle bash; #20 must isolate the separate Codemode models namespace and prove official child replacement. Intended GitHub Ketch/Question packages are not same-name npm packages. Ketch の operator-approved Git source / pinned revision は [#6](./conditional-stage-routing.md#real-pi--research-integration) で検証済み（npm 配布なし）。Question source / root integration verification は #8。 These are existing child-contract prerequisites, not permission to patch third parties or silently choose another dependency.

- Read target Issue/comments, #13, prerequisites and canonical docs before code changes。
- Smallest Issue-scoped diff; reuse existing helpers/ports before new abstractions。
- Core safety first; intent/authority/evidence persist before external/mutating effects。
- Only public released dependency APIs; no node_modules edit/patch/fork/private APIs, even for tests。
- Focused tests during development; pnpm check before implementation completion。
- Documentation-only #3 changes no source/package/lockfile/Agent behavior; validate document links/contracts and existing checks instead。
- No release evidence/CHANGELOG update until required implementation + production-path validation passes。

Real Pi process topology:

```text
HERDR_WORKSPACE_ID -> new Herdr tab (--cwd repo)
 -> returned root pane -> Herdr agent start --kind pi
 -> prompt / wait / read -> assertions
```

No tmux/direct pi spawn。Herdr is a test harness, never runtime dependency。Success closes tab; failure reports tab/pane/agent identifiers and preserves diagnosis as appropriate。

## 7. Final completion boundary

#13 closes only after all children and v1 completion criteria are satisfied, exact versions and integrated production paths are verified, actual Human Plan/Code Gates remain mandatory and no blocking integration mismatch remains。

Required smoke includes single-command normal lifecycle/resume, Git/non-Git, GRILL_ME/GRILL_WITH_DOCS, TDD/seams, Plan simplicity/refinement, material deviation/reapproval, optional Oracle, native classifier consent/budget and launch/trust/skill isolation。

Historical v0.1.0 PASS must not be republished as redesigned v1 PASS. Pending real production validation stays explicit; design completion is not runtime completion。
