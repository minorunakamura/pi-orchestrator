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

Research の低 confidence / explicit ESCALATE は root Human の **RUN / SKIP / HOLD** 選択で解決します（[#47](https://github.com/minorunakamura/pi-orchestrator/issues/47)）。Confidence が `autoDecisionThreshold` 未満でも Research 不要とは確定しません。質問前の intent と回答・解決結果を保存し、RUN は Research 後、SKIP は直接 Clarification 判定へ進みます。HOLD/cancel/lost reply は停止を維持し、既存 block は explicit `/wf-resume`、保存済み有効回答は再利用します。これは product clarification や Plan/Code approval ではなく、他 stage の ESCALATE は変更しません。[実装・検証・制限](docs/implementation/research-selection.md)。

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

### settings.json の配置

Pi の `settings.json` のトップレベルに **`piOrchestrator`** を追加します。pi-orchestrator 専用の別ファイルではありません。既存の `packages`、`subagents` などの設定は残してください。

| 配置先 | 適用範囲 |
| --- | --- |
| `<agent-dir>/settings.json`（標準: `~/.pi/agent/settings.json`） | ユーザー共通設定 |
| `<projectRoot>/.pi/settings.json` | Pi が trusted と判定した project の設定 |

global → trusted project の順で nested object を merge します。同じ項目は project 側が優先され、未指定の項目は global 側の値を使います。untrusted project の設定は読み込みません。Project 固有の classifier grant は project 側に置くと、共通の model 設定と分離できます。

### 完全な設定例

以下は classifier への evidence 送信を許可する場合の例です。`stageProfiles` は省略しているため、後述の default tier が適用されます。

**使用前に必ず次の項目を変更・確認してください。**

- `executionProfiles` の provider/model は、自分の Pi で利用できる physical model に置き換えます。`provider` と `model` は別フィールドで、`model` に `provider/` や `:thinking` は付けません。この例では3 tier を同じ model にしていますが、別々の model に設定できます。
- **`grant.projectRoot` の `/absolute/path/to/project` は、そのまま使えません。** Workflow を開始する project root の実際の絶対パスに置き換えてください。Git project は repository root で開始し、そこで `pwd -P` を実行すると物理パスを確認できます。
- `active: true` は列挙した evidence を classifier に送る許可です。`evidenceCategories` と `maxRequests` を確認し、許可する範囲・予算だけを設定してください。
- API credentials は Pi 側で設定します。`piOrchestrator` に API key を書きません。model の利用可能性や認証と、classifier 送信の grant は別の要件です。

```json
{
  "piOrchestrator": {
    "decision": {
      "autoDecisionThreshold": 0.8,
      "escalationThreshold": 0.5
    },
    "executionProfiles": {
      "ECONOMY": {
        "provider": "openai",
        "model": "gpt-5.6-luna"
      },
      "STANDARD": {
        "provider": "openai",
        "model": "gpt-5.6-luna"
      },
      "STRONG": {
        "provider": "openai",
        "model": "gpt-5.6-luna"
      }
    },
    "reasoningMapping": {
      "LOW": "low",
      "MEDIUM": "medium",
      "HIGH": "high"
    },
    "retries": {
      "maxAutomatedFixRounds": 3,
      "maxStrongerRetries": 1
    },
    "validation": {
      "stopOnInfrastructureFailure": true
    },
    "jev": {
      "classifier": {
        "provider": "typesafe",
        "model": "jev-latest"
      },
      "timeoutMs": 15000,
      "maxTransportRetries": 0,
      "runtimePolicy": {
        "maxRequests": 20,
        "grant": {
          "id": "project-classifier-grant",
          "policyVersion": "1",
          "active": true,
          "projectRoot": "/absolute/path/to/project",
          "destination": "typesafe/jev-latest",
          "evidenceCategories": [
            "task",
            "scout",
            "diagnosis",
            "research",
            "clarification",
            "design",
            "history",
            "plan",
            "context",
            "implementation",
            "review",
            "validation"
          ]
        }
      }
    }
  }
}
```

上記は現在の runtime が受理する設定です。設定全体として `decision`、全3 tier の `executionProfiles`、全3 tier の `reasoningMapping` が必要です。`reasoningMapping` の値には、選択した model が対応する thinking level を指定してください。

| 項目 | 役割・省略時の動作 |
| --- | --- |
| `decision` | Orchestrator の confidence policy に使う閾値。両値とも 0〜1 |
| `executionProfiles` | `ECONOMY` / `STANDARD` / `STRONG` を concrete provider/model に変換 |
| `reasoningMapping` | 選択された `LOW` / `MEDIUM` / `HIGH` を concrete thinking に変換。tier を選ぶ設定ではなく変換表 |
| `stageProfiles` | 任意。指定した Stage だけ default tier を上書き |
| `retries` | 省略時は automated fix 3回 / stronger retry 1回。Human feedback は別 counter |
| `validation` | 省略時は `stopOnInfrastructureFailure: true`。Validation の内容は Approved Plan が決める |
| `jev.classifier` | 省略時は `typesafe/jev-latest`。`grant.destination` は同じ `provider/model` に一致させる |
| `jev.timeoutMs` / `maxTransportRetries` | 省略時は 15000 ms / 0回。transport retry も request budget を消費 |
| `jev.runtimePolicy` | classifier を利用するには有効な grant と budget が必要。未設定・scope 不一致・予算不足なら送信せず停止 |

`maxRequests` は workflow ごとの outbound classifier request の上限です。per-finding request、retry、timeout も計上するため、workflow の規模に応じて設定してください。`0` は送信不可です。まだ存在しない Workflow ID を grant に記載する必要はありません。

### Stage ごとの model / thinking

Evidence/review/advisory child は、`stageProfiles` の指定または以下の Orchestrator-owned default tier を使います。**Root の現在の model/thinking や pi-subagents の `defaultModel` / `defaultThinking` には戻りません。** 選択した model/thinking が利用できなければ、preflight で停止します。

| Stage key | Default modelTier | Default reasoningTier |
| --- | --- | --- |
| `scout` | `ECONOMY` | `LOW` |
| `diagnosis` | `STANDARD` | `HIGH` |
| `research` | `STANDARD` | `MEDIUM` |
| `planning` | `STANDARD` | `HIGH` |
| `plan-simplicity` | `STANDARD` | `HIGH` |
| `correctness-review` | `STANDARD` | `HIGH` |
| `ponytail-review` | `STANDARD` | `MEDIUM` |
| `oracle` | `STRONG` | `HIGH` |

変更したい Stage だけ `piOrchestrator.stageProfiles` に追加します。以下は**追記・override 用の抜粋**です。完全な設定例の他の項目を消さずに追加してください。

```json
{
  "piOrchestrator": {
    "stageProfiles": {
      "scout": {
        "modelTier": "STANDARD",
        "reasoningTier": "MEDIUM"
      },
      "diagnosis": {
        "modelTier": "STRONG",
        "reasoningTier": "HIGH"
      }
    }
  }
}
```

Effective merged settings の各 override には `modelTier` と `reasoningTier` の両方が必要です。未知の Stage/tier/追加フィールドは拒否されます。例えば default の Diagnosis は `STANDARD/HIGH` → 上の完全な設定例では `openai/gpt-5.6-luna:high` に解決されます。

Scout と Diagnosis は同じ `workflow-scout` Agent definition を使いますが、実行 profile は独立しています。Architecture、Plan refinement、replanning は `planning` を共有します。**Worker/Fix Worker は Jev Execution Routing の判定結果を使い、`stageProfiles` では設定しません。** Root clarification、Jev classifier、deterministic Validation、Human Gates もこの設定の対象外です。詳しい契約は [Configuration](./docs/basic-design/configuration.md) を参照してください。

### 設定変更と consent / persistence

設定は新しい Workflow を開始する前に用意してください。Extension の更新を読み込むには `/reload` を使います。設定変更は次の command runtime 作成時に読み込まれますが、保存済み attempt の実行条件や approval を自動的に置き換えるものではありません。Active Workflow 中に project の `settings.json` を変更すると workspace drift として停止する場合があります。

`jev.runtimePolicy` の grant から、最初の classifier request 前に `decisions/jev-authorization.json` と `jevUsage.authorizationRef` を保存し、generated workflowId に bind した consent を確立します。Current grant と captured consent の両 ceiling を適用し、Classifier/project/destination/evidence scope と finite budget を検証し、毎 outbound attempt/per-finding/retry を **reservation → State persist → request** で計上します。API credentials/model availability、typesafe enable、Plan approval は consent ではありません。Timeout stays charged、restart で budget を resetしません。設定を広げても、既存 Workflow の captured consent は自動的に広がりません。旧 `jev.endpoint` / `runtimePolicy.consent` は使用できません。

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
