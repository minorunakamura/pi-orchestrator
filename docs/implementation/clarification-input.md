# Completed Clarification input contract (#49)

## Scope / cause

Issue #49とHuman-approved Planに基づく修正。元のpi-test Runは5 rounds / 20 answers / explicit final confirmationを保存しnormal driverもwakeしたが、17,204 UTF-16 code unitsのcompletion envelopeがPlanningRoutingの12,000 raw-Artifact制限で拒否された。#42のrequest/history restorationとは別の不具合。今回の原本Stateはrevision 33 / blocked-from-planningのまま保持する。

## Contract

- Immutable Artifactは正本のまま。`clarificationEvidence()`がexact completion/request/answer/pending predecessor chainをhash/schema検証し、全question/options/confirmed answerを各1回、Human-confirmed summaryを1回、confirmation/source refs/documentsを`completed-clarification-v1` derived evidenceとして組み立てる。Synchronous confirmed-port evidenceはinteractive historyとは別に扱う。LLM summary、切り捨て、回答推定はしない。
- Architecture / Development MethodとchildのArtifact input assemblyが同じreaderを使う。Refs/hashは原本のidentityで、derived contentのhashではない。Actual input digest、projection policy、child task/launch digestでfreshnessを検証する。変化していない先行Research/Clarification routingを一括invalidateしない。
- Derived completed-Clarificationを旧12,000 per-body / 48,000 aggregate raw-Artifact制限へ押し込まない。Unrelated raw evidenceの制限は維持する。State-boundでintent/result/current-fileを検証済みのdomain-document resultも、同じClarification producer契約としてraw-envelope制限から分離する。Historyは既存128 KiB UTF-8、1 round最大4 questions / 全8 rounds、questions最大32,768 UTF-16 code units、summary最大8,192 UTF-16 code units、document proposals最大4 / 各8 KiB UTF-8など、bounded producer契約を維持する。Synchronous answerもJSON文字列として128 KiB UTF-8にbounded。
- 新しいanswerはdurable保存後にhistoryを検証し、超過/不正なら具体的なlocal diagnostic Artifact → BLOCKを保存する。次round/最終確認UI前にも同じhistoryを検証する。回答は削除せず、質問/文書/childのblind replayはしない。
- GRILL_WITH_DOCSはdocument intent/result/current-file bindingを再検証する。Mode/confirmationはPlan/Code approvalやWorker authorityを付与しない。
- Safe local診断は`planning-input-diagnostic` payloadの既知codeと数値だけからstatus/continuation/Main contextへ表示する。Raw provider errors/secretsは表示しない。Completion toolのplanningはtransition snapshotと明示し、Mainは最新persisted controller Stateを優先する。

## API capacity ≠ application safety bound

公開[Models](https://docs.typesafe.ai/models.md) / [API](https://docs.typesafe.ai/api.md)を確認。現行jev-latestはjev-1.13.0、64k tokens/requestと32k tokens/state＋最長question。Pi 0.99.1のpublic classifier catalogはcontextWindow 64000を公開するが、32kのper-question制約を正確に判定できるpre-request tokenizerは確認できていない。文字数/bytesをtoken fitの保証として扱わない。Provider rejectionは別のfail-closed boundaryであり、safeな原因判定ができなければclassifier failureとして報告する。Alias変更、任意の内容の判断品質、無制限入力を保証しない。

## Validation status — check PASS / Human Code Gate pending

- RED: 新規long-input regressionは修正前にblockedを再現。
- GREEN: 修正後、assembled input自体が48,000 UTF-16 code unitsを超える5 rounds / 20 questionsでも、Architecture/Method → Planner/Simplicity → mandatory pending Plan Gateまで到達。各question/options/answerを検証し、real subagent preflightへ渡すtaskにも最終roundが入ることを確認。
- Focused Clarification suite: 47 tests PASSの時点を確認。その後、oversized custom-answer/status regressionを追加。新規6 casesのfocused runはPASS。全体checkは別途実行中であり、これらをcompletionの根拠としない。
- 元のpi-testのread-only reader check: original completion 17,204 code units → derived input 16,360 code units、5 rounds / 20 answers、State bytes不変。先に示した6,067文字の概算は選択肢などの全情報を含まないため採用していない。実際のderived inputも旧12,000を超え、dedupだけでは修正にならない。
- Real Pi long-input lifecycle smoke: **PASS** — [fixture extension](../../tests/platform/clarification-input-smoke-extension.ts)、new Herdr tab `wF:t3X` / pane `wF:p48` / agent `issue49-long-clarification`。Actual Main / Planner / Simplicity Reviewerはopenai/gpt-6.1-sol。Actual Humanの5 rounds / 20 answers / explicit final confirmation → actual Planner/Simplicity → State revision 43 / **awaiting-plan-review**。Completion envelope 23,824 / derived input 14,393 UTF-16 code units（いずれも旧12,000超過）、State refs 14件のhash一致、両childのpublic processTerminalはobserved / exit 0、source.ts不変、approvedPlanRef / implementationRefなし。Audit完了は2026-10-06T12:16:48.543Z。Scout/classifierとpending Plan Gateはfixturesで、実際のPlan承認UI・live Jev capacity・Worker/Code approvalの検証ではない。
- このsmokeのMainは最後に古いplanningを説明した。Driverは正常にGate待ちへ進んだが、watchのcallbackがblocked/failedだけを通知し、通常のpending waitを通知していなかった。Gate到達通知のRED regression（calls=0）→全continuation結果を通知してGREEN。既存raw-input headerの互換性、ownership deny文言、historyの早期block testも修正し、4 failing seamsのfocused runはPASS。**最新通知修正はunit/host境界の検証であり、先のlive transcriptが正しい表示だったとは主張しない。**
- GRILL_WITH_DOCSのvalid large-before-content resultも旧12,000制限で止まる回帰をREDで確認し、検証済みdocument resultのaccountingを分離してGREEN。Known raw-evidence limitの診断testもfocused PASS。
- 初回full checkは、local診断のJSON payloadをschema必須の`.json`としてwriteTextした不備を検出。JSON payloadを既存Clarificationと同じ`.md` Artifactで保存するよう修正し、該当focused testはPASS。初回full checkを成功と扱わず、sourceを固定した最終checkを再実行する。
- 最終 `VITEST_MAX_WORKERS=1 pnpm check`: **PASS / exit 0** — typecheck、lint（warningsなし）、format:check、**67 files / 1,029 tests**。開始21:23:34、duration 715.47 seconds（2026-10-06、machine-local time）。最初の2回のfull checkはFAILであり、成功とは扱わない。最終run中にruntime/test sourceは変更していない。
- Machine-local reports: `/tmp/issue49-check.log` / `/tmp/issue49-check.exit`、再検証 `/tmp/issue49-check-final.log` / `/tmp/issue49-check-final.exit`、最新treeの `/tmp/issue49-check-final2.log` / `/tmp/issue49-check-final2.exit`、`/tmp/issue49-live-smoke.json`、`/tmp/issue49-fixture.json`。

Human Code Gate、commit、merge、Issue closure、release、元Runのrecoveryは未実施・未承認。
