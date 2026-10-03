# Planning Orchestration Detailed Design

Version: 2.0 — v1 target contract (Issue #3)

## 1. Pipeline / owner

pi-orchestrator owns the normal driver, not pi-subagents scripts or resume phase-stepping。

```text
Task -> Scout -> Diagnosis? -> Conditional Research
 -> Clarification Routing -> SKIP / GRILL_ME / GRILL_WITH_DOCS / ESCALATE
 -> Conditional Architecture -> Development Method
 -> Planner -> deterministic Plan validation
 -> required Plan Simplicity Review
 -> optional one-shot refinement -> fresh simplicity review
 -> Human Plan Gate (all playbooks) -> Approved Plan
```

Pi >=0.99.1 / pi-subagents >=0.74.0 public contracts apply; #19 uses native typesafe/jev-latest and removes the transitional pi-typesafe dependency after live smoke。All child roles use #21 launch policy/preflight, exact input refs, physical model/skills/tools/definition identity and durable attempts。

## 2. Sequential evidence / Stage routing

Scout is required for every playbook。Diagnosis is required for bugfix/hotfix and skipped otherwise。Diagnosis produces symptom/repro/observed failure、competing root-cause hypotheses、support/contradiction locations、affected surface、unknowns before later routing。Insufficient facts are durable unknowns, not guessed certainty; unsafe unresolved decisions escalate。

Research is conditional for every playbook。Resolve it after Scout/Diagnosis persist。Then resolve clarification against accumulated evidence; after any Human answers/document writes, resolve Architecture。

`required -> RUN` / `skip -> SKIP` deterministic; only conditional calls Jev RUN/SKIP/ESCALATE。Matrix is [Basic Design §5](../basic-design/basic-design.md#5-playbook-baseline)。Architecture RUN stays owned by Planner; no mandatory independent architect。

Each resolution persists stage/policy/input refs+hash/digest、raw decision/confidence if called、effective outcome → State → next side effect。No start-time all-stage boolean resolution, no absent transient hint default-to-skip。Current v0.1.0 flags are legacy and cannot establish new conditional authority。

#6 implementation: conditional Clarification の stage decision が RUN のときだけ mode を classifier で選択する。Stage SKIP は deterministic mode SKIP、stage RUN に対する mode SKIP は contradictory として ESCALATE。Mode selection は質問生成や文書 write grant ではない。実装範囲と未実装 producer / production prerequisite は [implementation record](../implementation/conditional-stage-routing.md) を参照。

Reusing prior evidence requires current input/policy freshness and historical launch identity。Running/ambiguous child is not permission to rerun。Scout/Research cannot run in parallel where Research decision depends on Scout/Diagnosis。

### 2.1 Required Diagnosis evidence (#7)

Implementation は既存 read-only `workflow-scout` を fresh context / explicit Launch Policy で再利用する。独立 mutating role / linear phase は追加しない。Scout 後の `agentAttempts.diagnosis` が exact Task/Scout refs/hash、canonical project root、request/receipt、resolved launch を bind する。Intent/launch → State → dispatch、structured output → immutable `context/diagnosis.md` → `DIAGNOSIS_PERSISTED` → State → routing の順序。

Diagnosis report は observed symptom、expected behavior（unknown は null）、reproduction status（reproduced/not-reproduced/unavailable）・steps・observed evidence または unavailable reason、workspace locations、root-cause status/explanation/strength・support/contradiction evidence、unresolved factual gaps、external dependency signals、affected scope、hotfix scope assessment/reason/risk notes を保存する。空配列は explicit none。Confirmed cause は strong supporting evidence、reproduced は steps/evidence を必要とし、構造不正なら後続を止める。

`read/grep/find/ls` のみで implementation files を変更しない。Command-based reproduction はこの ceiling では unavailable と理由を残す。既存 test/log の observed failure と「今回実行して再現した」を混同しない。Tool ceiling は OS sandbox ではない。

全 routing frontier / Planner は exact Diagnosis evidence を消費し、artifact/input/launch freshness を再検証する。Completed evidence は status query / redispatch なしで reuse。Artifact publication 前の中断は exact historical public status/full output を回収し、running は wait、receipt loss/ambiguous/drift は block。Missing legacy evidence を成功/SKIP と扱わない。

Hotfix は `within-scope` assessment のときだけ先へ進み、Architecture は SKIP。`scope-exceeded` / `unknown` は Diagnosis を durable に残して Human/operator attention で止める。Human が明示的に reclassify/replan する必要があり、runtime が playbook/scope を自動変更しない。Diagnosis assessment は Human scope/architecture decision や Plan approval を代替しない。[実装・acceptance coverage・検証記録](../implementation/diagnosis.md)。

## 3. Clarification production bridge

| Mode | Required execution |
| --- | --- |
| SKIP | durable sufficient evidence, no unresolved Human decision |
| GRILL_ME | Main/root Pi Agent + grilling + ask_user_question |
| GRILL_WITH_DOCS | root/Main + grilling + domain-modeling + ask_user_question/Human |
| ESCALATE | Human/operator attention; do not infer answer |

Wrapper names grill-me/grill-with-docs express product semantics; underlying skills may be invoked directly where wrapper unsupported/disabled。Jev may route mode, never generate questions or answer on Human's behalf。Facts are investigated by read-only evidence tools; product/scope/architecture choices go to Human。

Before root interaction, persist request/source State/mode/input refs and authorized capability scope。After interaction persist exact questions、confirmed answers、unresolved decisions、request binding and any document-write refs as append-only clarification evidence。Only durable confirmed answer allows CLARIFICATION_COMPLETE; timeout/decline/tool absence blocks/escalates, not SKIP。

#8 は operator が正規 GitHub-only distribution として承認した [pi-ask-user-question commit 0a6ad2c5fd7f79ceccb51bc791c10554789bdbd2](https://github.com/minorunakamura/pi-ask-user-question/tree/0a6ad2c5fd7f79ceccb51bc791c10554789bdbd2) の公開 same-root-process request/reply/cancel v1 を使う。Only answered with complete exact selections is a Human answer; user-cancelled/caller-aborted/shutdown do not complete clarification。ctx.mode:tui と registered questionnaire/owned tools を必要とし、RPC/print/json / absent integration は fail closed。同名 npm package / moving main / third-party patch は使わない。Tag/npm publication は prerequisite にしない。Underlying skill bytes/root session/request refs、durable question rounds、final shared-understanding confirmation、exact document writer と normal continuation の [実装・acceptance・real Pi evidence](../implementation/clarification.md) を参照。

The released grilling skill requires Human confirmation of shared understanding after its decision frontier is settled。CLARIFICATION_COMPLETE must capture that confirmation, not infer completion from an empty question list。Fact gathering requested by the skill still uses Orchestrator-owned approved read-only roles, not root bypass of launch policy。

Changed request/source State/answer produces a distinct content-bound Artifact。Artifact-write success / State-write failure permits only exact verified idempotent republication with confirmed result, never file-existence inference。State revision rejects stale publication。

## 4. Narrow domain-document writes

domain-modeling is not a Stage and runs **only within GRILL_WITH_DOCS**。Mode decision alone does not permit files to change。

Permitted candidate paths:

```text
CONTEXT.md
CONTEXT-MAP.md
**/CONTEXT.md
docs/adr/*.md
**/docs/adr/*.md
```

Orchestrator narrows these patterns to exact project-relative authorized paths for the active clarification request。Validate canonical root、normalization、traversal/symlink escape、allowed operation/type before write。Source/config/package/implementation writes remain denied, even if Main holds edit/bash tools。

```text
clarification-bound exact path grant
 -> before content identity / absence + write intent Artifact
 -> State persist
 -> authorized document write
 -> after content identity + exact diff/answer linkage Artifact
 -> State persist
 -> next clarification/planning action
```

Partial/ambiguous document mutation leaves intent as recovery barrier; do not repeat blindly。Document changes update routing/planning evidence and freshness。This exception does not give Worker/source authority or substitute for Plan approval。

## 5. Development Method / TDD

Captured explicit Human TDD request wins deterministically。Otherwise clearly behavior-free/inapplicable work may use STANDARD。Ambiguous eligible behavior change may use bounded Jev STANDARD/TDD/ESCALATE; low confidence requests Human input rather than inventing a decision。

Persist method evidence before Planner。TDD Plan requires explicit Human-reviewable Test Seams: observable behavior/API、controllable dependency seam、interface boundary、regression assertions/expected outcomes。Approval binds exact method/seams with full Plan。Worker Launch Policy requests tdd explicitly, inheritSkills:false; codebase-design may support seam vocabulary if explicitly selected。

TDD uses vertical RED → minimal GREEN slices。No horizontal all-tests-first mandate, no automatic deterministic-validation bypass。

#16 は `StartWorkflowInput.developmentIntent` / start-command `--tdd` / task内の独立した `Development Method: TDD` 宣言をcaptureする。`--behavior-free` はHumanが明示したbehavior-free scope、未指定は `AUTO`。TDD宣言を優先し、曖昧なfree-form proseをHuman decisionと推定しない。Method evidenceは `family: method` / absent Plan authority / exact accumulated refs+digests+policy / classifier reservation・usageを保存し、`DEVELOPMENT_METHOD_RESOLVED.methodRef` → CAS State → Plannerの順。Low confidence / ESCALATEはdurable evidenceを残してoperator attentionで止まる。Planner outputのmethodが逆転、TDD seamsが空/missing/noneならPlan publication / Gateは不可。

Human approvalはimmutable Plan ref/version/hash全体（method/seams/Validation / optional Supporting Skillsを含む）へbindする。WorkerはそのPlanからmethod/seamsを抽出し、`Supporting Skills`で必要性が明示された `codebase-design`のみ追加する。Required skillsの欠落・余分なresolved skills・legacy/method/skill/launch driftはdispatch/recoveryで拒否。Plan feedback / clarification / replanはmethod refを明示invalidateし、新しいPlanとHuman Gateを必要とする。[実装・acceptance・real Pi evidence](../implementation/development-method.md)。#14のstrategy sections / simplicity readiness、#15のmaterial deviationを先行実装したものではない。

## 6. Planner input / Plan contract

Inputs: task、Scout、Diagnosis when required、Research when RUN、clarification/authorized document evidence、resolved Architecture/method decisions、previous Plan/feedback/simplicity/deviation/advisory refs when relevant、target version/cycle/refinement budget。

Runtime passes hash-validated bodies/refs with provenance; Planner does not mutate source or State。Optional Oracle advice for hard Architecture/strategy disagreement is read-only evidence, not a design approval。

Authoritative candidate path: plans/plan-vN.md。

Required logical content:

```text
Scope / Requirements
Architecture / Design（when Architecture RUN）
Implementation Approach
Expected Change Surface
New Components（explicit none allowed）
New Dependencies（explicit none allowed）
Non-goals
Development Method: STANDARD | TDD
Test Seams（TDD only, required）
Validation Contract
```

Plan is approved strategy/boundary, not required line-by-line recipe。Expected surface permits local details while making new components/dependencies/public interfaces/test/validation boundaries Human-reviewable。

## 7. Machine-readable Validation Contract

````markdown
## Validation Contract

```orchestrator-validation
{
  "schemaVersion": 1,
  "checks": [
    {
      "id": "unit-tests",
      "type": "command",
      "command": "pnpm test",
      "cwd": ".",
      "required": true,
      "timeoutMs": 120000
    }
  ]
}
```
````

ValidationContract contains executable deterministic checks (id/type/command/cwd/required/optional finite timeoutMs)。Approved Plan is sole WHAT authority; method/configuration/Agent hints cannot replace checks。Invalid structure/contract/method/seams prevents candidate publication/review readiness。

## 8. Candidate → simplicity → review readiness

1. Validate required logical sections, Architecture policy, method/Test Seams and machine-readable contract。
2. Persist immutable Plan Artifact。
3. PLAN_CREATED updates currentPlanRef/version (N+1), clears approval/current Human binding/simplicity, stays planning。
4. Persist State before launching read-only Plan Simplicity Reviewer。
5. Reviewer binds exact Plan version/hash + repository/input/launch evidence; persist review Artifact → PLAN_SIMPLICITY_REVIEWED → State。
6. Optional PLAN_REFINEMENT_REQUESTED consumes same-cycle 0/1 cap durably **before** Planner refinement。
7. Refined Plan is new version; repeat deterministic validation and fresh simplicity review, but not another automatic refinement。
8. Remaining findings + refinement disposition are Human-visible; PLAN_REVIEW_READY enters awaiting-plan-review only with fresh exact simplicity/method/seam evidence。
9. Persist State before opening Human Gate。

Simplicity findings must cite repository evidence for unnecessary abstraction/speculative flexibility/avoidable dependencies/ignored local patterns/broad surface。Taste alone is not a finding。Reviewer does not edit Plan/source or approve strategy。

Any Plan change invalidates simplicity (including Human edits/refinement) and approval; no hash relabeling。One-shot cap survives restart/automatic version increments; unavailable reviewer blocks, not silent bypass。

#14 implementation は cycleId / candidateCycleId / automaticRefinementsUsed / refinementReviewRef と per-version simplicity attempts を保存する。Findings は supplied Scout/Diagnosis の exact ref/location/verbatim excerpt を必要とし、各 input 64000 chars / total 128000 chars、report 64000 chars / 20 findings に bounded。Public Plan UI は unchanged Plan body に literal evidence-only annotation を付加し、Human binding/settled result に simplicity ref を含む。Legacy readiness/cycle は自動 upgrade しない。[実装・acceptance・focused real Pi evidence](../implementation/plan-simplicity.md)。

## 9. Human Plan Gate (async)

Every playbook requires this Gate。Only exact current review-ready Plan may be submitted。Persist intent before public open, then external reviewId + exact planRef/version + simplicityReviewRef with versioned external index before handle/result use。

Public payload is plan-review `{ planContent, planFilePath? }`; response pending/reviewId, eventual review-result or review-status。The shared plan-review path itself is review-only; external execution mode is required if using Plannotator's separate native plan-mode/submit-plan handoff。Neither path may automatically implement through Main。Public metadata cannot replace Orchestrator binding。

Matching settled result Artifact precedes PLAN_APPROVED / PLAN_FEEDBACK; State precedes continuation。Approval binds the entire strategy/method/seams/contract and sets approvedPlanRef/version。Feedback starts a new planning cycle/new immutable Plan/fresh simplicity; no old approval reuse。

Existing binding/external identity is reconciled, never unconditionally reopened。Missing exact binding/unknown status does not authorize a second open or inferred approval。Open/state persistence are not atomic; orphan review may remain but has no authority。

Identical duplicate settled result returns current persisted State unchanged (no new write/event/counter)。Changed result rejects。Explicit replan/deviation clears active approval/result binding: old approval is stale even before new Plan exists。

## 10. Replan / material deviation

Approved strategy allows local internal choices。Unauthorized new dependency/component、public API/boundary/scope/method/seam/validation change is material。Worker stops before knowingly implementing it, saves exact deviation/attempt/workspace evidence; Orchestrator invalidates coding authority and returns to planning。

Optional builtin Oracle may analyze deviation or unresolved Planner/simplicity disagreement under finite read-only policy。It grants no implementation/Fix/Plan authority; core stop/replan works without Oracle。

New Plan → validation → simplicity (one-shot refinement maximum) → mandatory Human Plan Gate before Worker continues。Retain old Plan/approval/workspace history; no blind relaunch/rollback or reuse of stale Test Seams。
