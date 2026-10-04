# Changelog

`pi-orchestrator` の利用者に影響する Initial Scope の機能と保証を記録します。内部の実装履歴や remediation の経緯は含めません。

## [Unreleased]

### Fixed

- Conditional routing が Research の必要性と未回答の Human choices を混同しないよう、stage/mode の判断目的を明確化。Instructions を policy freshness に bindし、古い decision の再利用を拒否。Confidence / ESCALATE / mandatory Human Gates は維持。

### Verified

- Issue #12: Pi 0.99.1 / pi-subagents 0.74.0 の公開契約、Git/non-Git の単一 command production lifecycle、実 Human clarification / Plan / Code Gates、native Jev、TDD / Test Seams、focused simplicity/refinement・material deviation/reapproval・Oracle advisory、recovery/authority regressions を検証。Final check: 66 files / 907 tests PASS。
- [v1 production verification](./docs/release/v1-production-verification.md) に、real / scripted の検証境界、失敗記録、exact versions と制限を記録。Package version / historical v0.1.0 release evidence / tracking #13 は変更しない。

## [0.1.0] — Initial Scope release candidate

### Core orchestration

- Pi 上で Planning → Coding → Validation → Review → Human Code Gate を一つの Workflow として実行。
- Workflow State は Orchestrator のみが変更し、State と immutable Artifact を分離。
- Initial Scope は single Coding Orchestration とし、Artifact / State の永続化を次の side effect より先に行う。

### Planning / clarification

- `workflow-scout` による repository-local evidence gathering と `planner` による Plan / Architecture / Validation Contract 作成。
- Fact の収集と Human の product / scope decision を分離し、clarification は Main Pi Agent の Human interaction で扱う。

### Human Plan Gate

- Plan は Plannotator の Human approval 前には Implementation Authority にならない。
- Feedback ごとに新しい Plan version と review binding を作成し、古い approval を再利用しない。

### Coding / Worker execution

- Approved Plan と context を入力に `pi-subagents` の public delegation contract で Worker を起動。
- Worker の dispatch identity、repository baseline、結果または曖昧な完了を durable evidence として扱い、曖昧な mutation の自動再実行をしない。

### Validation

- Approved Plan に含まれる Validation Contract を実行対象の正本として deterministic validation を実施。
- check failure と infrastructure failure を分離し、後者は設定に応じて Human attention または `blocked` とする。

### Automated review / Finding Evaluation

- Validation pass 後に Correctness Reviewer と `ponytail-reviewer` を実行し、structured findings を保存。
- Jev の Finding Evaluation と deterministic policy を通した accepted findings だけを Worker Fix Authority として扱う。

### Jev decision policies

- Jev を Coding Entry Routing、Finding Evaluation、Post-Implementation Round Decision に限定して使用。
- typed decision の schema、confidence、input evidence、Plan / implementation revision、policy / configuration digest を検証。
- Jev unavailable、invalid response、schema mismatch、consent denial は automatic LLM fallback せず `blocked` とする。

### Retry / escalation

- Automated fix round と stronger retry に上限を設ける（既定値は 3 / 1）。
- Stronger profile は単調に強化し、上限到達時は `blocked`。plan conflict / human decision / uncertain は自動的に authority を与えず Planning / Human attention に戻す。

### Human Code Gate

- Round completion だけでは Workflow を完了させず、Plannotator Code Review を exact implementation Artifact / revision に bind。
- Human Code Approval を永続化した場合だけ `completed` へ遷移。

### Resume / reconciliation

- `/wf-resume` は Persisted State、authoritative Artifacts、decision freshness、外部 identity を reconcile して安全な次の action を導出。
- stale decision、stale Plan / implementation / review binding、再構成不能な authority を受け入れず、原因に応じて `blocked` または terminal `failed` とする。

### Slash commands / status

- `/wf-new`、`/wf-feature`、`/wf-bugfix`、`/wf-hotfix`、`/wf-chore` を追加。
- `/wf-resume` は reconciliation 経由、`/wf-status` は read-only projection。

### Package / custom Agents

- v0.1.0 package metadata、Pi Extension entry (`./src/index.ts`)、custom Agent resources (`agents/`) を公開。
- `workflow-scout`、`planner`、`ponytail-reviewer` の role boundary を package manifest と Agent definition で明示。
- package artifact は runtime source、Agent definitions、docs、README、CHANGELOG、MIT `LICENSE` に限定し、tests / CI / local tooling を含めない。

### Hardening / safety

- Human Plan Gate / Human Code Gate の bypass を禁止。
- secrets を State / Artifact / task text に保存せず、Jev consent と finite budget を Orchestrator 側で管理。
- third-party source の変更、fork、patch、private API 依存を Initial Scope の前提にしない。
- real Pi smoke は Herdr の dedicated tab で検証し、Herdr は runtime dependency にしない。

### Known constraints

- Initial Scope は複数 Worker branch、Work Package parallelism、複数 Coding Orchestration を対象外とする。
- Future Scope の Context Routing、Conditional Stage 判定、任意の Escalation Target、Validation Failure classifier は含めない。
- `pi-subagents` の status / resume が host の reconciliation adapter を提供しない場合、retained child / orphan Worker を推測せず safe blocked / unsupported とする。
- Live Jev には exact workflow scope の operator consent、finite request budget、TypeSafe credentials、network 到達性が必要。`/typesafe enable` は Product Runtime authorization ではない。
- Plannotator と Human interaction が利用できない場合、各 Human Gate は承認扱いにせず停止する。
