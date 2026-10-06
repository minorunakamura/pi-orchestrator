# Durable Human Research selection (#47)

対象: [Issue #47](https://github.com/minorunakamura/pi-orchestrator/issues/47)。#6 / #45 / #4 / #5 の follow-up。Canonical contract は [Planning §2.2](../detailed-design/planning-orchestration.md#22-research-human-resolution-47)、[Decision Engine](../basic-design/decision-engine.md#4-conditional-stage-routing-v1)、[Persistence recovery](../detailed-design/persistence-recovery.md)。

## Implementation

- Research-only の valid low-confidence RUN/SKIP / explicit ESCALATE を、既存 public root questionnaire の RUN / SKIP / HOLD 選択へ接続する。Confidence == auto threshold は既存の自動採用、他 conditional stage の ESCALATE / mandatory Human Plan・Code Gates は変更しない。
- `researchSelectionRef` が exact original decision / workflow / project / root session / source revision / request ID / questions の intent と answer を保存する。Original classifier outcome/raw confidence/reservation/usage/digests は immutable のまま、resolved Research の `humanResearchSelectionRef` から complete answer → intent → source decision chain を検証する。
- `RESEARCH_SELECTION_PERSISTED` と Research-only `STAGE_RESOLVED.previousDecisionRef` は exact predecessor と no later-stage authority を要求する。Intent/State → UI → exact answer/State → resolved decision/State → current consent/configuration/freshness revalidation → next side effect。Human answer を confidence=1 の classifier output に置換しない。
- Human RUN は Research 完了後、SKIP は直接 Clarification 判定へ normal driver が継続する。HOLD/cancel/unavailable/invalid/pending result loss は停止を維持し、blind re-ask / classifier rerun / Scout redispatch はしない。State-bound answered record の interrupted final publication は exact immutable bytes から再利用できる。
- 保存済み original Research ESCALATE block は explicit `/wf-resume` で selection へ移行できる。Current evidence/configuration/root/workspace drift は fail closed。既存 `pi-test` State の手編集・自動再開・playbook relabel は行わない。
- Question / blocked command start / `/wf-status` / `/wf-resume` / automatic continuation diagnostics に raw value・confidence・configured auto threshold を表示する。Missing/corrupt display evidence は推測しない。空の project は停止条件ではない。
- New phase / generic resolution framework / dependency / child questionnaire / third-party patch/private API / Main raw-tool exception は追加しない。Development Method と同じ durable selection パターン、同じ public questionnaire / artifact / transition / driver / recovery を使用する。

## Validation

- Focused routing / transition / domain schemas / commands: **4 files / 156 tests PASS**（2026-10-06、全体 check 前）。RUN/SKIP、low-confidence RUN/SKIP、explicit ESCALATE、exact threshold、public question request/reply、original history、UI/next-side-effect persistence barriers、old block resume、answered reuse、pending/HOLD/cancel/invalid/unavailable、session/project/revision/workspace/configuration、source/intent/answer corruption、both Gate authority 不在、command diagnostics を検証する。
- Initial `VITEST_MAX_WORKERS=1 pnpm check`: **67 files / 1022 tests PASS**、704.97秒、exit 0、log `/tmp/issue47-check.log`。その後の fixture 修正について最新 typecheck/lint/format/diff checks を再検証した。
- **Final `VITEST_MAX_WORKERS=1 pnpm check`: PASS — typecheck / lint / format / 67 files / 1022 tests**、704.14秒、exit 0、log `/tmp/issue47-check-final.log`。最新 pinned Research fixture / public preflight guard を含む。Required automated validation と focused actual Human RUN / Research / pending Plan Gate smoke は完了し、implementation の Human Code Gate は別途確認する。
- 最初の real smoke `issue47-research` / `wF:t3V` / `wF:p46` は **FAIL**。Actual Human RUN → exact durable answer → Research RUN は保存されたが、isolated packages に pi-ketch がなく、Research は `notDispatched:true / missing_agent` で止まった。Research/Worker 実行0。Failure report `/tmp/issue47-research-smoke.json` と Workflow `66df9c34-185c-44e4-896d-4a9015ba18cf` は保持し、blind resume/代理回答はしていない。
- 修正 fixture は pinned pi-ketch archive を読み込み、選択肢を提示する前に production public Research preflight を検証する。新規 tab `issue47-research-2` / `wF:t3W` / `wF:p47`。Preflight-only の profile/session-root 入力不足 probes も zero child/question で fail closed とし、失敗記録を保持した。
- **Actual Human RUN → actual Research → Planner → Simplicity Reviewer → real pending Plannotator Plan Gate: PASS**。Positive smoke start `2026-10-06T09:50:00.379Z`、finish `2026-10-06T09:53:59.745Z`、Workflow `c99e4dae-7c4e-43b1-94ae-05e4cf2fd643`、root session `01a11098-7c84-7230-9886-17bbf76a1c29`、model `openai/gpt-6.1-sol`。State revision **35 / awaiting-plan-review**、approvedPlanRef / workerAttemptRef なし、implementationRevision 0。Human は Approve していない。
- Independent audit **PASS**: **19 immutable refs/hashes**、complete Human answer → intent → original SKIP/0.78 → resolved RUN chain、one Research classifier decision、exact pending Plan/simplicity binding、unchanged workload/source。Actual Research の `ketch_scrape` は **1 call / 1 success**、Pi v0.99.1 README を取得。Scout/Research/Planner/Simplicity の public process-terminal proof は全て **observed / exit 0**。
- Raw reports `/tmp/issue47-research-smoke-4.json` / `/tmp/issue47-research-audit-4.json`、audit `/tmp/issue47-audit.mjs`、fixture manifest `/tmp/issue47-fixture-2.json`（machine-local）。Classifier は controlled fixture（live Jev 0）。Other answers / explicit ESCALATE / old block resume / faults は automated tests の検証範囲。Full Worker lifecycle / actual Plan・Code approval / release PASS は主張しない。

## Opt-in real Pi / Herdr smoke

既存 [selection smoke extension](../../tests/platform/development-method-smoke-extension.ts) に Research command を追加し、#45 fixture を共用する。[Pinned clarification fixture](../../tests/platform/clarification-fixture.ts) の第5引数に clean pinned pi-ketch checkout（`e49fd9ea48b675eef2ede729c9f13f7e12d44c20`）を渡し、archive を fixture package として追加する。Isolated agent settings に product Agent discovery、released pi-subagents、public questionnaire、installed Plannotator を設定し、short `--session-dir` で **新規 Herdr tab** に Pi を起動する。Ketch CLI が必要。Research preflight は実際の policy/profile/output/session-dir binding を使い、成功前に質問を開かない。

```text
/research-selection-smoke /tmp/issue47-research-smoke.json
```

Human は実 UI で RUN / SKIP を選択する。HOLD は正常に停止を維持するが、後続 Plan Gate 到達の positive smoke とは区別する。Fixture は Plan Gate open 時に continuation を切り離し、approval / Worker を起動しない。Actual Research は Human が RUN を選択した場合のみ。Raw report、complete immutable chain、State、unchanged source、public process-terminal proof を audit してから PASS とする。Agent は代理回答しない。Operator settings/auth と既存 `pi-test` は変更しない。
