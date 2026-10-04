# pi-orchestrator

Pi 上の開発 workflow を State / Artifact / Decision / Human Gate に分離して安全に実行する Extension です。Orchestrator が lifecycle と authority を所有し、Human-approved strategy の範囲内で Worker が実装します。

## Design status / release status

この README と canonical design は [Issue #3](https://github.com/minorunakamura/pi-orchestrator/issues/3) の **v1 target runtime** を記述します。文書更新は redesigned runtime の実装・production 検証完了を意味しません。

現在の package/release は v0.1.0。過去の Release Candidate PASS は [v0.1.0 release evidence](./docs/release/v0.1.0.md) / [CHANGELOG](./CHANGELOG.md) の範囲だけです。v1 の実装順・未完了作業は [Issue #13](https://github.com/minorunakamura/pi-orchestrator/issues/13) / [Implementation Plan](./docs/implementation/implementation-plan.md) を参照してください。release evidence / CHANGELOG は後続実装と production-path validation 合格後だけ更新します。

## Installation

既存 release:

```sh
pi install git:github.com/minorunakamura/pi-orchestrator@v0.1.0
```

ローカル checkout:

```sh
pi install ./path/to/pi-orchestrator
```

Pi loader は `pi.extensions: ./src/index.ts` の TypeScript source を読み込みます。別の compiled output は同梱しません。package の product custom Agents は agents/ に配置します。

## v1 production requirements / public integrations

- Node.js >=22.19.0
- pnpm >=11.22.0 <12

| Component | v1 contract |
| --- | --- |
| Pi / @earendil-works/pi-coding-agent | **>=0.99.1**、host peer dependency の range は Pi package 契約に従い `"*"` |
| pi-subagents | **>=0.74.0**、released public single-agent RPC / preflight / lifecycle v3 |
| Classifier | Pi native **typesafe/jev-latest**（Pi が credential/provider を解決。`pi-typesafe` dependency は削除済み） |
| @plannotator/pi-extension | mandatory Human Plan/Code UI、Plan async / Code synchronous public contract |
| [minorunakamura/pi-ketch](https://github.com/minorunakamura/pi-ketch) | GitHub 配布のみ。conditional Research / pi-ketch.researcher。検証 revision は `e49fd9e`（[検証記録](./docs/implementation/conditional-stage-routing.md#real-pi--research-integration)）。同名 npm package は使用しない |
| [minorunakamura/pi-ask-user-question](https://github.com/minorunakamura/pi-ask-user-question) | root/Main の Human clarification。Same-name npm askUserQuestion は代替ではない |

package/lockfile は Pi **0.99.1** / pi-subagents **0.74.0** で検証します。Pi は host peer のまま、pi-subagents は public preflight 用 runtime dependency です。実行 host は同じ released dependency の extension を明示 load してください（development smoke: `-e ./node_modules/pi-subagents`）。Jev decision transport は Pi native classifiers（default `typesafe/jev-latest`）を使います。`jev.classifier: { provider, model }` を選び、`jev.runtimePolicy.grant.destination` は同じ `provider/model` に明示 binding してください。grant に未来の workflow ID は不要です。旧 `jev.endpoint` / URL consent は拒否され、自動変換・fallback はありません。Pi が credentials/provider transport を所有し、Orchestrator が request ごとの durable reservation と confidence policy を所有します。Pi 0.99.1 の live smoke 検証後に `pi-typesafe` dependency を削除しました。検証状況は [Issue #19 migration record](docs/implementation/native-classifier-migration.md) を参照してください。

Platform の検証範囲・再現手順は [#18 platform smoke evidence](./docs/implementation/platform-baseline-smoke.md) を参照してください。後続 Issue の runtime 実装や v1 全体の production PASS を意味しません。

全 production child launch は orchestrator Agent Launch Policy / public preflight を通し、resolved physical model/thinking、explicit skills と content hash、effective tools、Agent definition、inheritance/trust、package/lifecycle/launch digest を dispatch 前に保存します。Planning/review の recovery は exact historical contract/receipt を検証し、Worker は historical approved profile/receipt に bind します。ambient capabilities・legacy evidence の移行・blind relaunch は仮定しません。[#21 実装・検証・制限](docs/implementation/agent-launch-contract.md)を参照してください。

Third-party package の変更/patch/fork/private API 利用は禁止。released contract で安全に実現できない経路は blocked/unsupported。Virtual Models は v1 execution authority ではなく Future Scope。Codemode (#20) は verified bounded read-only child capability のみで、lifecycle/approval を所有しません。

## Skills / roles

| Capability | Role |
| --- | --- |
| grilling | GRILL_ME / GRILL_WITH_DOCS の root/Main Human interaction |
| domain-modeling | **GRILL_WITH_DOCS のみ**、narrowly authorized CONTEXT/ADR writes。standalone Stage ではない |
| tdd | selected TDD Worker が public skill selection で明示取得。builtin inheritance を仮定しない |
| codebase-design | optional supporting Test Seam/interface vocabulary |
| ponytail-reviewer | post-code actual implementation simplicity findings |
| plan-simplicity-reviewer | required pre-Human strategy review、repository evidence 必須 (#14) |
| builtin oracle | rare bounded read-only advisory、approval/Fix/State authority なし (#17) |

Skills は JavaScript runtime dependencies ではありません。wrapper grill-me/grill-with-docs が unsupported/disabled の場合、underlying grilling/domain-modeling skills を直接使えます。CodeGraph は任意の開発調査 tool、Herdr は real Pi test harness のみです。

## Commands / normal lifecycle

```text
/wf-new <task>       # new-project
/wf-feature <task>
/wf-bugfix <task>
/wf-hotfix <task>
/wf-chore <task>
/wf-resume <id>      # recovery reconciliation + normal continuation
/wf-status <id>      # read-only
```

Explicit method intent は `/wf-feature --tdd <task>`（全 start commands で利用可）、API の `developmentIntent: "TDD"`、またはtask内の独立した `Development Method: TDD` 宣言でcaptureします。Behavior-free work は `--behavior-free` / `developmentIntent: "BEHAVIOR_FREE"`、未指定は `AUTO` としてbounded routingを行います。TDD宣言が優先し、free-form proseからHuman intentを推測しません。

v1 normal driver は pi-orchestrator の driveWorkflow() が所有します。single /wf-* invocation は genuine Human/external wait、blocked、failed、completed まで進み、accepted Human/child result は同じ driver で continuation します。繰り返し /wf-resume を使う phase-stepping は通常 progress ではなく、pi-subagents workflow scripts に control plane を移しません。

#4 では **既存 runner 上の driver foundation** を実装しました。Commands は createWorkflow → driveWorkflow、/wf-resume は exact reconciliation → 同じ driver。Plan の公開 review-result notification は wake-up のみで、保存済み binding と取得した status を検証・保存してから継続します。既存 Validation/review/Fix loop は自動で進みますが、以下の target lifecycle 全体の実装済みを意味しません。[実装範囲・検証・後続 Issue](./docs/implementation/normal-workflow-driver.md) を参照してください。

```text
Task -> Scout -> Diagnosis? (bugfix/hotfix required)
 -> conditional Research
 -> Clarification: SKIP | GRILL_ME | GRILL_WITH_DOCS | ESCALATE
 -> conditional Architecture -> Development Method STANDARD | TDD
 -> Planner -> deterministic Plan validation
 -> Plan Simplicity Review -> optional one-shot refinement/fresh review
 -> Human Plan Gate (all playbooks required)
 -> Jev Execution Routing -> Worker
      -> material deviation: stop/evidence -> replan/simplicity/Human approval
 -> deterministic Validation -> Correctness + Ponytail
 -> Finding Evaluation / Round Decision -> bounded retry/escalation
 -> Human Code Gate (all playbooks required) -> completed
```

Oracle は difficult Diagnosis/Architecture/strategy disagreement/deviation/post-code escalation の optional advisory で、mandatory stage ではありません。#17 の explicit request / durable budget / builtin read-only launch / normal continuation / recovery は [実装・検証記録](docs/implementation/oracle-advisory.md) を参照してください。

## Sequential evidence / Human clarification

required → RUN、skip → SKIP は deterministic。Jev は conditional → RUN/SKIP/ESCALATE のみ route し、low confidence を silent skip にしません。Research/Clarification/Architecture は accumulated durable Scout/Diagnosis/Research/Human evidence を sequential に使います。

#6 では、この逐次 routing と immutable stage/mode decision、freshness 検証、normal-driver continuation を実装しました。旧 `PlaybookContext` の hint は authority にしません。#7 では bugfix/hotfix の required Diagnosis を既存 read-only `workflow-scout` で実行し、durable evidence から routing を自動継続します。hotfix の scope/redesign 超過・不明は Human reclassification/replanning 待ちで停止し、Architecture SKIP は維持します。[Diagnosis の実装・検証・制限](./docs/implementation/diagnosis.md) を参照してください。#8 では production root clarification / exact domain-document writes と actual Human TUI の両 mode を接続・検証しました（[実装・検証・制限](./docs/implementation/clarification.md)）。#11 では生成 ID 後の durable consent capture を実装しました（[設定・検証・移行制限](./docs/implementation/classifier-authorization.md)）。[実装・acceptance coverage・production 制限](./docs/implementation/conditional-stage-routing.md) を参照してください。

GRILL_ME は root/Main + grilling + ask_user_question。GRILL_WITH_DOCS はさらに domain-modeling。Jev は mode を選べても Human-facing question/answer は生成しません。Production は underlying skills の実 bytes/hash と root identity を bind し、durable question rounds と **final shared-understanding confirmation** を経て normal driver を継続します。Transient `clarificationPrompt` は不要です。

```sh
pi install git:github.com/minorunakamura/pi-ask-user-question@0a6ad2c5fd7f79ceccb51bc791c10554789bdbd2
```

正規 GitHub-only source は operator 承認の上記 commit に固定し、同名 npm / moving main は使いません。Pi に `grilling` / `domain-modeling` skills と question package を load してください。Root TUI と registered tools が必要で、RPC/print/json / missing skill/package / `--no-tools` は unsupported として block します。

Allowed document candidates: CONTEXT.md、CONTEXT-MAP.md、nested CONTEXT.md、docs/adr/*.md / nested docs/adr/*.md。Orchestrator が active clarification に bind した **exact path scope / intent / before identity を write 前に**保存し、after identity/diff/answer evidence を保存します。source/config/implementation mutation は Main に許可されず、docs exception も implementation authority ではありません。

## Active workflow ownership

#5 のproduction boundaryは canonical workspace / root session / workflow をdurableにbindします。Active（blockedを含む）workflow中はMainのraw tool / shell / MCP / Codemode / child executionを拒否し、Human chatとowned clarificationだけを許可します。Trusted project resourcesやread-only hintsでも実装権限は増えません。Normal driver / resume / Worker直前でworkspaceを検証し、unexpected mutationはbaselineに取り込まずblockします。

GRILL_WITH_DOCSの例外は実Humanが確認したexact CONTEXT/ADR create/updateだけです。Legacy ownership、conflict、workspace/provider/root/session drift、unresolved mutationは自動adoption/retryしません。Gitはrepository rootで開始してください。Hooksはtrusted extensionのdirect filesystem accessに対するOS sandboxではなく、その変更はworkspace driftとして検出します。[実装・acceptance・real Pi証拠と制限](./docs/implementation/workflow-ownership.md)。

## Plan strategy / simplicity / TDD / Worker boundary

Plan は frozen editing recipe ではなく approved implementation strategy/boundary。必須 content:

- Scope / Requirements、Architecture / Design when required
- Implementation Approach、Expected Change Surface
- New Components、New Dependencies、Non-goals
- Development Method STANDARD/TDD、Test Seams when TDD
- machine-readable Validation Contract

Exact Plan hash/version が authority。required read-only Plan Simplicity Review は不要な abstractions/flexibility/dependencies、ignored repository patterns、過大な surface を evidence-backed findings として提示し、自動 refinement は1回まで。Any Plan change は simplicity/approval を stale にし、残る findings は Human-visible。

Explicit Human TDD request → deterministic TDD。Clearly inapplicable behavior-free work → STANDARD。それ以外の eligible ambiguity は bounded Jev; low confidence で Human decision を捏造しません。TDD approval は exact Test Seams に bindし、Worker が明示 tdd skill で vertical RED → minimal GREEN を実行します。TDD は deterministic Validation を置き換えません。

#16 ではdurable method routing、必須 Development Method section / TDD Test Seams、exact Plan approval binding、explicit upstream `tdd`（必要時のみ `Supporting Skills: codebase-design`）のpublic launchを接続しました。Missing/extra skill、stale method/seams/launch、missing legacy intentはfail closed。Workerのslice reportはimmutable implementation evidenceに保存され、Validation Contractは引き続き独立のdeterministic authorityです。[Acceptance coverage・実Human/Worker smoke・制限](./docs/implementation/development-method.md)を参照してください。#14 では `Implementation Approach` / Expected Change Surface / New Components / New Dependencies / Non-goals を必須化し、durable candidate → exact-bound simplicity review → one-shot refinement → mandatory Human Plan Gate を接続しました。残る findings は Human-visible、completed valid review は再実行しません。[Acceptance coverage・focused real Pi smoke・制限](./docs/implementation/plan-simplicity.md)を参照してください。Material deviation本体は #15、full production verification は #12のままです。

Worker は local internal choice を行えますが、unauthorized component/dependency/API/boundary/scope/method/seam/Validation change は実装前に止まり、durable deviation evidence → new Plan/simplicity/Human Gate を必要とします。Oracle/classifier/reviewer advice は permission ではありません。

## Validation / Human Gates / workspace

Approved Plan の Validation Contract が sole WHAT authority。exit code/test/build/lint/typecheck pass/fail は deterministic tools、Jev は bounded decisionsのみ。passed round は両 reviewers/evaluation/accepted findings の exact-bound evidence（空配列も明示）が必須。Raw findings は Fix Authority ではありません。

Plan Gate は async external reviewId + exact review-ready Plan binding。Code Gate は synchronous public approved/feedback result で、external reviewId/status polling を仮定しません。**local attempt + exact implementation/revision + review source を request 前に**保存し、Human settlement 時も source が unchanged であることを確認します。Human duration を五秒 timeout にしません。

Git と filesystem non-Git は first-class workspace。before/after manifests/content/baseline を durable に記録し、non-Git Code Review は generated static patch を Plannotator patchFile に渡します。Worker prose hash は workspace identity ではありません。[Workspace evidence implementation / limits / validation](docs/implementation/workspace-evidence.md) に provider pinning、retained baseline、unsupported-entry policy を記録しています。Filesystem は UTF-8 text のみ、256 KiB/file・8 MiB total・10,000 entries・depth 64、patch は 1 MiB まで。Symlink/hardlink/binary/unsupported modes は省略せず block します。

## Configuration / consent / persistence

Pi trusted settings の piOrchestrator を読みます。global settings を trusted project settings が host precedence で override; untrusted project injection を独自実装で許可しません。Child trust は Pi/pi-subagents の public contract を継承します。Agent discovery は host の `isProjectTrusted()` に基づき trusted → public `agentScope: "both"`、untrusted/unknown → `"user"` とし、project Agent definitions/overrides の混入も除外します。Orchestrator は trust loader を再実装しません。

`jev.runtimePolicy: { maxRequests, grant: { id, policyVersion, active, projectRoot, destination, evidenceCategories } }` を workflow 開始前に設定できます（[設定例](./docs/basic-design/configuration.md#6-operatorproject-grant-vs-workflow-consent-11)）。最初の classifier request 前に `decisions/jev-authorization.json` と `jevUsage.authorizationRef` を保存し、generated workflowId に bind した consent を確立します。Current grant と captured consent の両 ceiling を適用し、Classifier/project/destination/evidence scope と finite budget を検証し、毎 outbound attempt/per-finding/retry を **reservation → State persist → request** で計上します。API credentials/model availability、typesafe enable、Plan approval は consent ではありません。Timeout stays charged、restart で budget を resetしません。

Default coding retry は automated fix 3 / stronger retry 1、Human feedback は別 counter。詳しい target config は [Configuration](./docs/basic-design/configuration.md)。現行 JSON schemaとの差分は後続 Issue が実装し、未対応 settings を先行追加しません。

Workflow data は `.pi/orchestrator/runs/<workflow-id>/`。State stores refs/metadata、Artifacts are immutable/content-bound。Required intent/authority/evidence と State 保存後だけ next side effect を開始します。

/wf-resume は exact State/Artifact/historical launch/review/decision を reconcile後、normal driverへ continuation。Ambiguous Worker/document mutation、lost synchronous Human result、unknown ownership は blocked、blind relaunch/reopen/approval inference をしません。Failed は safely unreconstructable authority/stateのみ。

## Issue #12 production verification

[Production verification record](./docs/implementation/production-verification.md) records connected Git/non-Git runs using the unchanged production package, actual Human clarification/Plan/Code Gates, native Jev and TDD Workers, plus released-owner host contracts and focused strategy/advisory probes. Read-only audits verify retained hashes, exact authority, current patches and completed history after `/reload` without relaunch. The record distinguishes scripted setup from live integrations and is not a package version bump or automatic tracking-Issue closure.

## Scope / verification limits

v1 は single active Workflow / single Worker。Multiple Coding Orchestrations/Work Package DAG/worktree parallelism、generic Context Routing、arbitrary Jev escalation target、semantic Validation failure classifier、Virtual Models execution authority は Future Scope。

Producer Issues の実装・focused verification と、#12 の connected production / host-contract verification を区別します。#12 は実 Human clarification / Plan / Code Gates、native Jev、TDD Worker を含む Git/non-Git normal lifecycle と、focused simplicity/refinement・deviation/reapproval・Oracle、recovery/authority regressions を検証しました（[release verification と制限](./docs/release/v1-production-verification.md)）。Read-only Codemode の採用は Plan Simplicity Reviewer のみ（[#20 isolation / real smoke](docs/implementation/readonly-codemode.md)）。全 optional-stage 組合せを一つの live workflow で検証したという意味ではなく、各 record の real / scripted 境界を維持します。real Pi integration/smoke は **new Herdr tab**、tmux 禁止。Package release / merge / Issue #13 closure はこの検証から推定しません。

## Further reading

- [Documentation index](./docs/README.md)
- [Canonical Basic Design](./docs/basic-design/basic-design.md)
- [Implementation/dependency map](./docs/implementation/implementation-plan.md)
- [Dependency public-contract review](./docs/implementation/dependency-contract-review.md) — 指定公開契約の根拠・条件。Ketch は operator 指定の GitHub source / 固定 commit で検証済み。Question package の選定・runtime 検証は #8。moving main を検証済み revision と同一視しません
- [Historical v0.1.0 release evidence](./docs/release/v0.1.0.md)
