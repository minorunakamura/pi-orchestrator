# pi-orchestrator

Pi 上で開発作業を安全な workflow として実行する v0.1.0 Extension です。
State / Artifact / Decision / Human Gate を分離し、Planning から Coding、Validation、Review、Resume までを一つの bounded な Coding Orchestration として扱います。

Initial Scope は **Release Candidate PASS** 済みです。実装範囲と検証結果は [v0.1.0 release evidence](./docs/release/v0.1.0.md)、利用者向け変更点は [CHANGELOG](./CHANGELOG.md) を参照してください。

## Installation

GitHub の release tag から Pi に追加する場合:

```sh
pi install git:github.com/minorunakamura/pi-orchestrator@v0.1.0
```

ローカル checkout を使う場合:

```sh
pi install ./path/to/pi-orchestrator
```

Package は `pi.extensions` の `./src/index.ts` を Extension entry として読み込み、`pi-subagents.agents` の `./agents` から次の product custom Agents を公開します。

- `workflow-scout` — repository-local evidence gathering
- `planner` — Plan / Architecture / Validation Contract の作成
- `ponytail-reviewer` — structured simplicity findings

`src/` は Pi の package loader が読み込む TypeScript source です。この package は別の compiled output を同梱しません。

## Requirements and integrations

- Node.js `>=22.19.0`
- pnpm `>=11.22.0 <12`（CI / `mise.toml` は `11.22.0`、この checkout の lockfile 解決値は `11.28.0`）

Pi / external component:

| Component | 必要度 | 備考 |
| --- | --- | --- |
| [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi) | 必須 | `0.87.1` で smoke 検証済み |
| [`pi-subagents`](https://github.com/nicobailon/pi-subagents) | 必須 | Agent 実行環境 |
| [`@plannotator/pi-extension`](https://github.com/backnotprop/plannotator/tree/main/apps/pi-extension) | 完了に必須 | Plan Gate / Code Gate |
| [`pi-typesafe`](https://github.com/DevMortimer/pi-typesafe) | Jev 利用に必須 | API credentials は supported credential source で設定 |
| [`pi-ketch`](https://github.com/minorunakamura/pi-ketch) | Research 時のみ | `pi-ketch.researcher` |
| [`pi-ask-user-question`](https://github.com/minorunakamura/pi-ask-user-question) | Clarification 時のみ | Main Pi Agent の `ask_user_question` |

CodeGraph CLI は package dependency ではなく、任意の開発・調査用 local tool です。

Skills:

| Skill | 必要度 | 備考 |
| --- | --- | --- |
| [`ponytail`](https://github.com/DietrichGebert/ponytail) | Workflow review 時 | `ponytail-reviewer` の simplicity / over-engineering policy。custom Agent に反映 |
| [`grilling`](https://github.com/mattpocock/skills/tree/main/skills/productivity/grilling) | Clarification 時 | Main Pi Agent の Human clarification |
| [`domain-modeling`](https://github.com/mattpocock/skills/tree/main/skills/engineering/domain-modeling) | 任意（開発・設計用） | product workflow では自動ロードしない |
| [`tdd`](https://github.com/mattpocock/skills/tree/main/skills/engineering/tdd) | 任意（開発用） | product workflow では自動ロードしない |

`grilling` は Clarification の workflow で Main Pi Agent が利用します。`ponytail` の review role は package の custom `ponytail-reviewer` が担当します。`domain-modeling` と `tdd` は開発・設計用です。これらは JavaScript runtime dependency ではありません。

## Commands

```text
/wf-new <task>       # new-project workflow
/wf-feature <task>   # feature workflow
/wf-bugfix <task>    # bugfix workflow
/wf-hotfix <task>    # hotfix workflow
/wf-chore <task>     # chore workflow
/wf-resume <id>      # reconcile して安全に再開
/wf-status <id>      # read-only status
```

Workflow は通常 `.pi/orchestrator/runs/<workflow-id>/` に State と immutable Artifacts を保存します。`/wf-status` は State と安全に公開できる identity / Artifact refs の projection のみを表示し、State を変更しません。

## Workflow lifecycle

```text
/wf-*
  → Context Gathering
  → Clarification（必要時、Human）
  → Planning
  → Human Plan Gate（Plannotator）
  → Jev Execution Routing
  → Worker
  → Deterministic Validation
  → Correctness / Ponytail Review
  → Jev Finding Evaluation / Round Decision
  → bounded retry / escalation
  → Human Code Gate（Plannotator）
  → completed
```

### Human Plan Gate

Planner の Plan Artifact は、Human が Plannotator で承認するまで Implementation Authority になりません。Feedback は immutable な `plan-vN+1.md` を作り、旧 Plan の approval を再利用しません。

### Coding / Validation / Review

Approved Plan の Validation Contract が実行対象の正本です。Validation の pass/fail は deterministic executor が判定し、Jev が代替することはありません。Validation が通った round では Correctness Reviewer と `ponytail-reviewer` が structured findings を生成し、accepted findings だけが Worker Fix Authority になります。

### Jev decision policy

Jev は Initial Scope で次だけに使います。

- Coding Entry Routing
- Finding Evaluation
- Post-Implementation Round Decision

Jev の output は State を直接変更しません。typed decision を deterministic policy で検証してから transition に変換します。Jev unavailable / invalid response / budget denial は automatic LLM fallback せず `blocked` にします。

### Human Code Gate

Round が完了しても `completed` にはなりません。Plannotator の Code Review identity を exact implementation Artifact / revision に bind し、Human の Code Approval を永続化してから `completed` へ進みます。

## Resume and reconciliation

`/wf-resume <workflow-id>` は現在の phase を盲目的に再実行する command ではありません。Persisted State、authoritative Artifacts、decision freshness、外部 review / Worker identity を検証し、再開可能な次の action を reconcile します。

- State / Artifact の永続化成功前に次の side effect を開始しません。
- Worker の dispatch が曖昧な場合は duplicate mutation を避けて `blocked` にします。
- Jev / Plannotator / pi-subagents の一時的な利用不能は `blocked` とし、復旧後に再度 `/wf-resume` します。
- State / authority / artifact を安全に再構成できない場合だけ terminal `failed` になります。
- stale Jev decision、stale Plan / implementation / review binding は再利用しません。

## Configuration

Pi の既存 settings boundary を使います。

- global: `<agent-dir>/settings.json`
- project: `<project>/.pi/settings.json`（project trust 後のみ）
- project settings は Pi の既存 precedence に従い、global settings を deep override します。

`piOrchestrator` は non-secret configuration のみを受け取ります。必須の decision / execution profile / reasoning mapping が欠ける、または未知の Future Scope setting を含む場合は fail-closed します。retry の既定値は automated fix 3 回、stronger retry 1 回です。

最小構成の形:

```json
{
  "piOrchestrator": {
    "decision": {
      "autoDecisionThreshold": 0.8,
      "escalationThreshold": 0.5
    },
    "executionProfiles": {
      "ECONOMY": { "provider": "<provider>", "model": "<model>" },
      "STANDARD": { "provider": "<provider>", "model": "<model>" },
      "STRONG": { "provider": "<provider>", "model": "<model>" }
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
      "endpoint": "https://api.typesafe.ai"
    }
  }
}
```

Live Jev を使うには、さらに `jev.runtimePolicy` に有限の `maxRequests` と、次の scope に一致する operator consent が必要です。

- exact `workflowId`
- exact absolute `projectRoot`
- exact `destination`
- `policyVersion` / consent identity
- 送信を許可する evidence categories

`runtimePolicy` の欠落、失効、scope 不一致、budget exhaustion、reservation の永続化失敗は network request を行わず `blocked` にします。`/typesafe enable`、API key の存在、Plan approval、Jev confidence はこの Product Runtime consent の代わりになりません。API key、auth header、secret URL を State / Artifact / task text に保存しないでください。

## Initial Scope and known constraints

Initial Scope は次を含みません。

- 複数 Worker branch / Work Package の並列実行
- 複数 Coding Orchestration の同時実行
- Future Scope の Context Routing、Jev による Conditional Stage 判定、任意の Escalation Target 選択
- Validation Failure の semantic classifier
- 外部 package の patch / fork / private API modification

`pi-subagents` の current public compatibility boundary では、status / resume の host reconciliation adapter が提供されない場合があります。その場合は retained child や orphan Worker を推測して再利用せず、safe blocked / unsupported path を使います。Human Plan Gate と Human Code Gate は常に Human interaction が必要で、Jev や Agent が代替することはありません。

Herdr は real Pi smoke 用の開発・検証 harness であり、pi-orchestrator の runtime dependency ではありません。real Pi smoke は Herdr の新しい tab で実行し、`tmux` はサポート topology ではありません。

## Further reading

- [Design and implementation docs](./docs/README.md)
- [v0.1.0 release evidence](./docs/release/v0.1.0.md)
- [v0.1.0 release notes](./CHANGELOG.md)
