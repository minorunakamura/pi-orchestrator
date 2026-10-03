# Required Bugfix / Hotfix Diagnosis — Issue #7

## Preparation / scope

GitHub #7 の本文・acceptance criteria（comments なし）、tracking #13 の本文・全 comments、AGENTS.md、canonical planning / artifacts / State / persistence contracts と現行 Scout/routing/Planner/driver/recovery callers を確認した。前提 #3 / #18 / #19 / #21 / #4 / #6 はすべて CLOSED で、対応実装は checkout に含まれる。

本変更は Diagnosis producer と normal-driver 接続のみ。Root clarification (#8)、generated-workflow consent (#11)、TDD (#16)、Plan strategy/simplicity (#14)、material deviation (#15)、workspace snapshot/non-Git (#10)、統合 production verification (#12) を先行実装しない。Release evidence / CHANGELOG / GitHub Issue status は変更しない。

## Implementation

- [DiagnosisReport](../../src/core/planning/diagnosis.ts): symptom、expected behavior（unknown は null）、reproduction status/steps/evidence または unavailable reason、workspace evidence、root-cause hypothesis/status/strength/support/contradiction、factual gaps、external dependency signals、affected scope、hotfix assessment/reason/risk notes を型・schema に定義。Missing fields / malformed values / unsupported statuses / evidence のない confirmed cause を拒否。
- [Diagnosis runner](../../src/runtime/orchestrator/diagnosis.ts): 既存 [workflow-scout](../../agents/workflow-scout.md) の fresh read-only launch を再利用。Task/Scout refs/hash と canonical project identity、launch/dispatch/receipt を既存 ledger に保存し、structured output を immutable `context/diagnosis.md` に保存する。本文は JSON envelope（schemaVersion / inputRefs / inputHash / launchContractDigest / report）。
- `DIAGNOSIS_PERSISTED` は gathering-context の bugfix/hotfix、Scout 保存後・routing 開始前だけ有効。別 evidence への置換を拒否し、State CAS 保存後に次 action へ進む。独立 linear phase / mutating Agent / 新しい依存を追加しない。
- [PlanningOrchestrator](../../src/runtime/orchestrator/planning-orchestrator.ts) は Scout → required Diagnosis → Research/Clarification routing を連続実行する。new-project/feature/chore は Diagnosis dispatch なし。
- [PlanningRouting](../../src/runtime/orchestrator/planning-routing.ts) は全 frontier で Diagnosis の exact ref/body、Task/Scout input hashes、historical launch/receipt、current public preflight を検証する。Planner も同じ boundary と既存 `plannerInputRefs()` から Diagnosis を消費する。分類モデルに送る evidence category / reservation / consent policy は既存 #6/#19/#11 boundary のまま。
- [Recovery](../../src/runtime/orchestrator/reconciler.ts) と [status projection](../../src/ui/workflow-status.ts) は Diagnosis の stage/attempt を識別する。Completed durable evidence は status query / dispatch なしで再利用。Output 保存前の中断は既存 exact public status/full-output recovery を使い、running は wait、receipt loss / input・launch drift / unknown outcome は block。Artifact 保存後・State 保存失敗も exact output だけを再 publish し、別 child を起動しない。

Diagnosis は `read/grep/find/ls` のみ。`bash/edit/write/subagent/codemode` は既存 Launch Policy で拒否する。Command-based reproduction は unavailable と理由を記録し、既存 test/log の recorded failure と今回実行した reproduction を混同しない。Supporting workspace locations は evidence であり、OS sandbox / 全 workspace の freshness attestation ではない。

## Hotfix / authority

Hotfix の Architecture は引き続き deterministic SKIP。`within-scope` assessment のときだけ後続 routing が可能で、`scope-exceeded` / `unknown` は Diagnosis を State に保存して `operator-attention-required` で停止する。Resume / Planner への直接呼出しでも同じ policy を適用する。

Human による明示的な reclassification/replanning が必要であり、新しい自動 reclassification command は追加しない。Diagnosis / classifier / Oracle は Scope/Architecture を承認せず、両 Human Gates、Implementation/Fix authority、deterministic Validation を変更しない。

## Acceptance coverage

| #7 acceptance criterion | Executable evidence |
| --- | --- |
| Bugfix/Hotfix cannot reach Planner without durable Diagnosis | 両 playbook の producer → driver continuation、invalid/missing Diagnosis で zero classifier/Planner、Artifact/State save fault で次 effect を開始しない tests |
| Conditional Stage Routing and Planner consume Diagnosis | 全 frontier の exact ref、Research child / classifier evidence body / Planner input の Diagnosis inclusion、stale/corrupt input rejection tests |
| Resume does not blindly rerun completed Diagnosis | Completed evidence の zero status/redispatch、output-before-State recovery、launch drift、running receipt wait、missing receipt の zero replacement、actual Pi resume tests |
| Reproducible / non-reproducible / external dependency / hotfix scope-exceeded | Recorded reproducible fixture、not-reproduced/unavailable と unknown cause/factual gaps、external-dependency Research RUN、hotfix scope-exceeded/unknown durable block + resume/direct Planner tests |
| Diagnosis cannot mutate implementation files | Read-only public preflight/launch ceiling、actual child read calls、before/after workspace bytes/files equality。Mutating tool / Worker authority は追加しない |

Focused tests:

- [Schema](../../tests/core/diagnosis.test.ts) / [transition guards](../../tests/core/workflow/transition.test.ts)
- [Routing/driver/Planner/scenarios/persistence faults](../../tests/runtime/orchestrator/planning-routing.test.ts)
- [Public-RPC Diagnosis recovery](../../tests/runtime/orchestrator/diagnosis-recovery.test.ts) / [existing planning recovery](../../tests/runtime/orchestrator/planning-recovery.test.ts)

## Validation

- Focused: `VITEST_MAX_WORKERS=2 pnpm test tests/core/diagnosis.test.ts tests/core/workflow/transition.test.ts tests/runtime/orchestrator/planning-routing.test.ts tests/runtime/orchestrator/diagnosis-recovery.test.ts tests/runtime/orchestrator/planning-recovery.test.ts` — **PASS: 5 files / 88 tests**。
- `pnpm typecheck` / `pnpm lint` — PASS。
- Final `VITEST_MAX_WORKERS=2 pnpm check` — **PASS: typecheck / lint（warnings なし）/ format / 52 files / 682 tests**。
- `git diff --check` / final `pnpm format:check` — PASS。変更 Markdown の local links/anchors **61件 PASS**。
- 最初の all-suite run は tool の 120-second window で timeout し、PASS と扱わなかった。300-second window の再実行は PASS（当時 52 files / 679 tests）。Test assertion / timeout は緩和していない。

### Real Pi / Herdr

[Fixture](../../tests/platform/diagnosis-fixture.ts) と [explicit smoke extension](../../tests/platform/diagnosis-smoke-extension.ts) で disposable workspace の actual Scout → actual Diagnosis → scripted routing → genuine Human wait `clarifying` を検証した。Pi **0.99.1** / pi-subagents **0.74.0** / physical **openai/gpt-6.1-sol**, thinking **medium**。

Final source の smoke は **PASS**：start **2026-10-03T03:23:44.435Z**、Herdr new tab / pane / Agent **`wF:t2F` / `wF:p2S` / `issue7-diagnosis-final`**。Actual Scout/Diagnosis spawn は各1、Diagnosis の `read` は2 calls。Durable report は reproduction unavailable と supplied-log provenance / suspected cause / factual gaps を保存し、public exact receipt/full output が report と一致した。Resume で fresh evidence/decisions を reuse（zero redispatch / extra classifier calls）、workspace files/bytes 不変、approval/implementation refs なし。両 child の public process-terminal proof は **observed / exit 0**。Raw report: `/tmp/issue7-diagnosis-final-smoke.json`。確認後に作成 tab と temporary auth symlink を cleanup 済み。

Initial smoke も PASS（`wF:t2E` / `wF:p2R`）。既存 Scout definition の Markdown-only instruction と Diagnosis JSON request の競合を明示的に解消した後、上記 final source で別 new tab の smoke を再実行した。

既存 [Oracle smoke fixture](../../tests/platform/oracle-smoke-extension.ts) は旧 plain Diagnosis を使わず、新 schema / ledger を fixture executor で生成するよう更新した。これは **synthetic Diagnosis output/receipt + real side-effect-free preflight** であり、actual Diagnosis execution の証明にしない。互換 smoke も PASS：**`wF:t2G` / `wF:p2T` / `issue7-oracle-compat`**、start **2026-10-03T03:27:24.117Z**、actual builtin Oracle spawn 1、normal continuation to `clarifying`、workspace unchanged。Public process-terminal proof は observed / exit 0。確認後に作成 tab と temporary auth symlink を cleanup 済み。Raw report: `/tmp/issue7-oracle-compat-smoke.json`。

全 smoke は new Herdr tab を使用し、tmux / direct Pi spawn なし。Classifier は scripted（network classify 0）。Actual Human Gates、live Jev、Worker/full v1 lifecycle は本 smoke の PASS に含めない。

### Reproduction

```sh
node --experimental-strip-types --input-type=module -e '
  import { diagnosisFixture } from "./tests/platform/diagnosis-fixture.ts";
  console.log(JSON.stringify(await diagnosisFixture(process.env.HOME + "/.pi/agent/auth.json", "openai/gpt-6.1-sol")));
'
# 上記 JSON の cwd / agentDir を使う。Operator settings/auth の内容は変更しない。
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd <fixture-cwd> \
  --label issue7-diagnosis --env PI_CODING_AGENT_DIR=<fixture-agentDir> --no-focus
herdr agent start issue7-diagnosis --kind pi --pane <returned-pane-id> -- \
  --no-approve --no-session --no-extensions --no-skills --no-prompt-templates \
  --no-context-files --no-tools -e <repo>/node_modules/pi-subagents \
  -e <repo>/tests/platform/diagnosis-smoke-extension.ts --model openai/gpt-6.1-sol:medium
herdr agent prompt issue7-diagnosis '/diagnosis-smoke /tmp/issue7-diagnosis-smoke.json'
# Report の status/evidence/receipt/processTerminal を確認してから作成 tab のみ close。
```

Oracle compatibility fixture は `platformFixture()` の personal settings に product package `{ source: <repo>, extensions: [], skills: [], prompts: [] }` と physical model defaults を明示する。これにより synthetic Diagnosis の public preflight が実 product definition を確認できる。Project injection fixtures は untrusted のまま。

## Remaining boundary

#7 の producer は read-only investigation と durable unknowns を提供する。任意 command を「安全な reproduction」と推定して実行する capability は追加しない。Hotfix redesign は Human の明示的な workflow/scope decision を待ち、silent expansion を行わない。上記以外の producer / final production lifecycle coverage は tracking #13 の既存 Issue が所有する。
