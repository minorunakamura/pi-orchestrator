# pi-orchestrator 基本設計

Version: 2.0 — v1 runtime redesign / GitHub Issue #3

## 1. Scope / design status

本書と `docs/basic-design/`・`docs/detailed-design/` は、[Issue #3](https://github.com/minorunakamura/pi-orchestrator/issues/3) の **v1 target contract** を定義する。実装順・完了状態は [Issue #13](https://github.com/minorunakamura/pi-orchestrator/issues/13) と [Implementation Plan](../implementation/implementation-plan.md) を参照する。設計更新は実装済み・production 検証済みを意味しない。

既存 v0.1.0 の実装・検証結果は [release evidence](../release/v0.1.0.md) に固定する。旧コードとの差分を設計に合わせる作業は後続 Issue が所有する。

対象は new-project / feature / bugfix / hotfix / chore。v1 は single active Workflow、single Planning Orchestration、single Coding Orchestration、single Worker とする。Git と filesystem（non-Git）workspace を同等の authority 対象とする。

## 2. Platform baseline

| Component | v1 production baseline / ownership |
| --- | --- |
| Pi / `@earendil-works/pi-coding-agent` | **>=0.99.1**。host / peer dependency、bundled runtime ではない |
| `pi-subagents` | **>=0.74.0**。released public single-agent RPC / preflight / lifecycle contracts |
| Classifier | Pi native **typesafe/jev-latest**。#19 live smoke 後に transitional pi-typesafe dependency を削除済み |
| Plannotator | public event API。Plan Review async、Code Review synchronous |

Jev decision transport の v1 target は Pi native classifier、default は `typesafe/jev-latest`。Virtual Models は v1 execution authority ではなく Future Scope。bounded read-only child Codemode は #20、全 child の Agent Launch Policy は #21 が実装する。

第三者 package は read-only dependency。source / `node_modules` 編集、patch、fork、private API 依存は認めない。released public contract で安全に実現できなければ orchestrator-side adapter または `blocked` / unsupported とし、main / Unreleased behavior を前提にしない。

## 3. Authority boundaries

```text
Orchestrator                 State / lifecycle / Artifact / policy / Human Gate authority
Scout / Diagnosis / Research evidence generation
Jev native classifier        bounded typed decision evidence
Oracle                       bounded read-only advisory evidence
Planner                      candidate implementation strategy
Plan Simplicity Reviewer     pre-code strategy findings（read-only）
Human Plan Gate              exact approved Plan の implementation authority
Worker                       approved strategy 内の automated implementation
Deterministic Validation     test / build / lint / typecheck の pass/fail authority
Correctness / Ponytail       post-code structured findings
Human Code Gate              completion authority
Main/root Pi Agent           Human interaction / clarification、通常の source mutation authority なし
```

外部 Agent、classifier、Oracle、Codemode、reviewer、pi-subagents は State を変更せず、Plan / Code を承認しない。preflight success、model confidence、API key、child success、Plannotator UI の消失は Human authority ではない。

Raw findings は Fix Authority ではない。Orchestrator が approved Plan と evidence を検証した Accepted Findings のみが自動 Fix の追加 authority となる。Human Code Feedback も exact implementation に bind した durable authority を必要とする。

## 4. Normal lifecycle and recovery

```text
/wf-* Task
 -> Scout
 -> Diagnosis?                         # bugfix/hotfix: required
 -> Conditional Research
 -> Clarification Routing              # SKIP | GRILL_ME | GRILL_WITH_DOCS | ESCALATE
 -> Conditional Architecture           # Planner owns design; optional Oracle advice
 -> Development Method Routing         # STANDARD | TDD
 -> Planner
 -> deterministic Plan validation
 -> Plan Simplicity Review
 -> optional one-shot Planner refinement + fresh simplicity review
 -> Human Plan Gate                    # required for every playbook
 -> Jev Execution Routing
 -> Worker
      -> local detail: continue
      -> material deviation: stop -> durable evidence -> Planning
 -> Deterministic Validation
 -> Correctness + Ponytail Review
 -> Jev Finding Evaluation / Round Decision
      -> bounded Fix / stronger retry / replan / Human attention
      -> optional Oracle advice for hard escalation
 -> Human Code Gate                    # required for every playbook
 -> completed
```

`driveWorkflow()` は pi-orchestrator が所有する normal lifecycle driver。single `/wf-*` invocation は genuine Human/external wait、`blocked`、`failed`、`completed` まで進める。Human result / child completion の受理後も同じ driver で continuation する。phase を1つ進めるために繰り返し `/wf-resume` を呼ぶ設計にはしない。

`/wf-resume` は durable State / Artifact / external identity の reconciliation **後**、同じ normal driver へ continuation する recovery entry。通常 lifecycle を pi-subagents workflow scripts へ移さない。`/wf-status` は read-only projection。

## 5. Playbook baseline

`new` は command `/wf-new` / internal playbook `new-project` を表す。

| Stage | new | feature | bugfix | hotfix | chore |
| --- | --- | --- | --- | --- | --- |
| Scout | required | required | required | required | required |
| Diagnosis | skip | skip | required | required | skip |
| Research | conditional | conditional | conditional | conditional | conditional |
| Clarification | conditional | conditional | conditional | conditional | conditional |
| Architecture | required | conditional | conditional | skip | skip |
| Human Plan Gate | required | required | required | required | required |
| Human Code Gate | required | required | required | required | required |

`required -> RUN`、`skip -> SKIP` は deterministic。Jev は `conditional -> RUN / SKIP / ESCALATE` のみ判断する。low confidence を silent SKIP にしない。Human Gates は conditional routing の候補に含めない。

Scout → Diagnosis → Research → Clarification → Architecture は accumulated durable evidence から **sequential** に解決する。開始時に全 conditional flag を transient hint から固定しない。Stage decision は exact input refs/hash と policy に bind して保存し、次 side effect より先に State を保存する。

Diagnosis は症状、再現 / observed failure、root-cause hypothesis、支持 / 反証 evidence、affected surface、unknowns を durable に残す。競合 hypothesis への Oracle advice は optional で、Diagnosis を省略しない。

## 6. Clarification and domain-document authority

| Mode | Executor / semantics |
| --- | --- |
| `SKIP` | current evidence で Human decision 不要 |
| `GRILL_ME` | Main/root Pi Agent + `grilling` + `ask_user_question` |
| `GRILL_WITH_DOCS` | Main/root Pi Agent + `grilling` + `domain-modeling`、Human interaction は root |
| `ESCALATE` | unresolved / low-confidence / unavailable capability、Human attention。回答を推測しない |

Fact は Agent / Tool が調査し、Product / Architecture / Scope decision は Human が決める。Jev は bounded evidence から mode を route できるが、質問文の生成や Human の代理回答はしない。`grill-me` / `grill-with-docs` は product semantics。wrapper invocation が未対応・無効なら underlying skills を直接利用できる。

`domain-modeling` は独立 Stage ではなく **GRILL_WITH_DOCS のみ**。この mode 自体で write authority は発生しない。Orchestrator が active clarification request に bind した exact path allowlist / intent を保存してから、以下の範囲だけを許可する。

```text
CONTEXT.md
CONTEXT-MAP.md
**/CONTEXT.md
docs/adr/*.md
**/docs/adr/*.md
```

許可対象は CONTEXT / context map / ADR の narrowly-scoped design-document writes。canonical project root 内に限定し、path traversal・symlink escape・source / implementation / configuration mutation を拒否する。before identity（absence を含む）、authorized intent、clarification binding を **write 前**に保存し、after identity / exact diff / Human answers の refs を write 後に保存する。missing / ambiguous evidence は fail closed。これは source implementation authority、一般的 docs write 権、Plan approval の代替ではない。

正規化は case-sensitive POSIX project-relative path の exact spelling を要求する。Absolute / backslash / control-byte path、`posix.normalize(path) !== path`、`.` / `..` / `.git` / `.pi` / `node_modules` component を拒否する。Nested `CONTEXT-MAP.md` と `docs/adr` の再帰的 file placement は許可しない。Create/update のみで、parent/target symlink・hardlink・非regular file は拒否する。Raw edit/write/bash は例外の対象ではなく、Human-confirmed exact content を owned bridge が execution 時に再検証して書く。全workspaceの before/after と、exact対象fileだけを除外した scope観測を intent/result に bindし、同時の無関係な変更を許可しない。

## 7. Plan contract and simplicity review

Plan は frozen line-by-line execution recipe ではなく、Human が承認する **implementation strategy and boundary**。exact approved Plan content/hash が Implementation Authority である。

Required logical content:

- Scope / Requirements
- Architecture / Design（Stage policy が RUN のとき）
- Implementation Approach
- Expected Change Surface
- New Components（なしなら明記）
- New Dependencies（なしなら明記）
- Non-goals
- Development Method: `STANDARD` / `TDD`
- Test Seams（TDD のとき required）
- machine-readable Validation Contract

Planner → candidate Plan → deterministic section/contract validation → required read-only Plan Simplicity Review → optional **at most one** automatic refinement → fresh review of changed Plan → Human Plan Gate。repository pattern / file / dependency evidence なしの好みは finding としない。

Plan Simplicity Review は不要な abstraction、speculative flexibility、avoidable dependency、ignored repository pattern、過大な change surface を検査する。evidence は exact Plan version/hash に bind し、**any Plan change** で stale。one-shot refinement の消費を durable に残し、自動再生成で cap をリセットしない。残る findings は Human に提示し、無限 refinement を行わない。

Plan feedback / replan / material deviation は新しい immutable Plan と fresh simplicity evidence、Human Plan Approval を必要とする。Simplicity reviewer は Plan を承認・修正・実装しない。post-code Ponytail Reviewer とは対象とタイミングが異なる。

## 8. Development Method

- explicit Human TDD request → deterministic `TDD`
- clearly inapplicable behavior-free work → deterministic `STANDARD`
- ambiguous eligible case → bounded Jev routing
- low confidence → `ESCALATE` / Human clarification、Human decision を捏造しない

method routing evidence は durable。TDD Plan には Human-reviewable Test Seams（observable behavior / interface / controllable dependency / regression assertions）を含める。Human Plan Approval は method + exact Test Seams + Validation Contract を含む Plan 全体へ bind する。

TDD Worker は public pi-subagents skill selection で `tdd` を明示取得する。`codebase-design` は supporting seam/interface vocabulary として選択可能。builtin Worker の ambient skill inheritance は仮定しない。vertical RED → minimal GREEN slices とし、TDD は deterministic Validation を置き換えない。

## 9. Worker flexibility and material deviation

Worker は approved approach / scope / boundary を保つ local internal implementation choice（private helper、local algorithm 等）を行える。Plan は全編集行を指定する必要がない。

新たな unauthorized component / dependency、public API change、architecture boundary change、scope broadening、Development Method / Test Seam / Validation change 等は **material deviation**。Worker は knowingly 実装する前に停止する。

```text
Worker stop
 -> deviation evidence + observed workspace identity を永続化
 -> approved authority を無効化
 -> optional read-only Oracle analysis
 -> Planner -> Plan validation -> Plan Simplicity Review -> Human Plan Gate
 -> new approved authority のみで Worker continuation
```

Oracle がなくても fail closed で停止・replan できる。existing mutation は history として保持し、blind relaunch / rollback しない。

## 10. Oracle advisory

pi-subagents builtin `oracle` は rare / hard decision の bounded read-only escalation。mandatory linear Stage ではない。

候補: competing Diagnosis、difficult Architecture trade-off、unresolved Planner vs simplicity disagreement、material deviation analysis、hard post-implementation escalation。

Orchestrator が trigger、finite attempt budget / timeout、input evidence refs、launch policy を dispatch 前に保存し、output を durable advisory Artifact にする。Oracle は State / target files を変更せず、Plan / Code approval、implementation / Fix authority、Human Gate bypass を一切行わない。unavailable / uncertain advice を authority に昇格させない。

## 11. Execution, validation and gates

全 child は #21 の explicit Agent Launch Policy と public preflight を通す。resolved physical model / thinking、explicit skills、effective callable tools、Agent definition digest、inheritance flags、project-trust expectation、package / lifecycle version、launch-contract digest を durable に bind する。model / skill / tool / definition drift を同じ attempt と扱わない。preflight は resolved intent であり、runtime tool provider/trust/skill-body の attestation ではない。公開 host/child-startup checks と exact input hashes を別途検証する。

Worker intent / routing / workspace baseline → State persist → dispatch。実行中は exact receipt / run identity を保存し、output / after-workspace evidence → State persist → next stage。truncated/display text、timeout、stop request は completion proof ではない。曖昧な mutating attempt を再起動しない。

Validation は exact Approved Plan の machine-readable contract を実行し、pass/fail は deterministic tools が決める。validation failure の retry は durable Round Decision + hard policy を通す。passed round は Correctness / Ponytail / evaluation / accepted-findings の全 current evidence（空配列を含む）が required。

Jev は classifier selection / auth transport ではなく bounded domain decision plane。Orchestrator は project/operator grant upper bound から generated workflowId に bind した workflow consent と finite request budget を保存し、毎 outbound attempt を reservation-before-request で計上する。credentials / Plan approval は consent ではない。native classify は maxRetries:0 と finite cancellation/deadline を明示し、returned stopReason/answers を検証する。

Plan Gate は async external reviewId と exact Plan を bind。Code Gate は synchronous public request/result と **orchestrator-owned local attempt** を exact implementation / review source に bind。non-Git は durable snapshot から生成した static patch を `patchFile` に渡す。result Artifact → Event → State の保存後に authority を進める。

## 12. Ownership, persistence and recovery

Active workflow ownership は canonical workspace / root session / workflowId / authority を durable に bind し、Main Agent の source mutation や別 child 経由の迂回を拒否する。GRILL_WITH_DOCS の exact authorized paths だけが clarification exception。project trust を再実装・推測せず、Pi / pi-subagents の public trust contract を継承する。enforcement を証明できなければ blocked/unsupported。

State の sole writer は Orchestrator。immutable Artifact refs/hash、stateRevision、exclusive lock / revision check、stale binding rejection を維持する。intent / authority / reservation が必要な外部・mutating side effect は **実行前に**保存する。

`blocked` は一時依存障害・authority ambiguity・budget exhaustion 等の recoverable suspension。`failed` は State / Authority / Artifact の安全な再構築が不能な terminal state。通常 test failure / feedback / finding は terminal failure ではない。

## 13. Canonical references / Future Scope

- [State Machine](./state-machine.md): phases / events / transitions
- [Decision Engine](./decision-engine.md): bounded decisions / confidence / authorization
- [Artifacts](./artifacts.md): identity / freshness / authority / ordering
- [Integrations](./integrations.md): released public platform contracts
- [Configuration](./configuration.md): grants / profiles / budgets
- [Directory Structure](./directory-structure.md): ownership / dependencies
- [Detailed Design Overview](../detailed-design/detailed-design-overview.md)
- [Dependency Contract Review](../implementation/dependency-contract-review.md): released references / corrections / pending source and runtime verification

Future Scope: multiple Coding Orchestrations / Work Package DAG / worktree parallelism、generic Context Routing、arbitrary Jev escalation-target selection、semantic Validation failure classifier、dynamic reviewer selection、Virtual Models execution authority。Conditional Stage Routing、Diagnosis、non-Git、clarification modes、TDD、Plan Simplicity Review、material deviation、Oracle advisory、bounded read-only Codemode は **v1**。

Release evidence / CHANGELOG は後続実装と production-path validation の合格後だけ更新する。real Pi integration / smoke は new Herdr tab（tmux 禁止）で #12 が最終検証する。
