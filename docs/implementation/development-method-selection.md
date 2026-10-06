# Durable Human Development Method selection (#45)

対象: [Issue #45](https://github.com/minorunakamura/pi-orchestrator/issues/45)。#16 / #8 / #4 / #5 の follow-up。Canonical contract は [Planning §5](../detailed-design/planning-orchestration.md#5-development-method--tdd) / [Persistence recovery](../detailed-design/persistence-recovery.md)。

## Implementation

- AUTO の valid low-confidence / explicit ESCALATE を、既存 public `AskUserQuestionIntegration` による root TUI の STANDARD / TDD 選択へ接続する。Model に新しい tool を追加せず、child や classifier に質問・同意を生成させない。
- 元の method classifier decision は immutable に保持する。`developmentMethodSelectionRef` に question intent / answer を保存し、最終 method Artifact の `humanSelectionRef` が exact answer → intent → original decision を指す。Raw decision / reservation / usage / policy・configuration・input digests を改変しない。
- `DEVELOPMENT_METHOD_SELECTION_PERSISTED` は exact predecessor と planning/no-current-candidate authority を要求する。`DEVELOPMENT_METHOD_RESOLVED.previousMethodRef` は current selection の存在と exact source method を要求し、既存 Plan authority の silent method replacement は拒否する。
- UI 前の intent/State、Planner 前の answer/State + resolved method/State を保存する。回答中の State revision/workspace drift は拒否。Freshness は既存 PlanningRouting を再利用し、Worker の historical strategy verification でも complete Human evidence chain を検証する。
- 保存済み original ESCALATE block は explicit `/wf-resume` で選択へ移行できる。Pending/lost/cancelled/invalid answer は blocked のままで、再質問・classifier rerun・default decision は行わない。State-bound answered record の最終 method publication は exact bytes/hash を確認して idempotent に回復できる。
- Human method choice は Plan / Code / implementation approval ではない。TDD Test Seams、explicit isolated Worker skills、Validation Contract、both mandatory Human Gates は既存のまま。
- Normal continuation が返した genuine blocked/failed を production UI に通知する。Thrown error の通知とは別で、wake hint は引き続き authority ではない。

## Validation

Focused tests cover both answers for low-confidence and explicit ESCALATE, public question request/reply, intent/answer/method persistence barriers, old block resume, idempotent answered recovery, pending/cancel/unavailable/invalid reply, source/session/project/workspace/revision/corruption denial, Plan Gate wait without Worker, and historical Worker method/skill verification. Existing explicit intent/high-confidence/Plan-seam validation paths remain covered.

- Focused routing tests: 78 tests PASS。Command continuation / schema / transition tests PASS。Historical Human-selected STANDARD/TDD Worker-strategy testsを含む development-method tests: 11 tests PASS。追加 Worker testの初回失敗は混在した fixture reservation counters によるもので、native fixture の method-confidence control を使用して修正・再検証した。
- `VITEST_MAX_WORKERS=1 pnpm check`: **PASS — 67 files / 991 tests**、693.19秒、2026-10-06T05:04:26Z開始。Log `/tmp/issue45-check.log`。初回 lint の smoke-local shadow warning は修正し、最新の typecheck / lint / format:check / diff:check は warning なしで PASS。最新コードの focused 再検証は **4 files / 117 tests PASS**、2026-10-06T06:57:38Z開始。
- 最初の Herdr tab **`wF:t3S` / `wF:p44`**（`issue45-method`）は UI 表示後、回答が保存されないまま15分の期限で `blocked` になり、Plan Gate 到達 smoke は **FAIL**。Pending intent を保存し、blind retry / approval inference はない。Raw report `/tmp/issue45-method-smoke.json` は失敗記録として保持する。
- 新しい disposable fixture / Herdr tab **`wF:t3T` / `wF:p45`**（`issue45-method-2`）で **actual Human TDD answer → durable method → actual Planner → Simplicity Reviewer → real pending Plannotator Plan Gate: PASS**。Model は `openai/gpt-6.1-sol`、root session `01a10ffd-5ca4-73ef-8178-9a033e4a2b05`、Workflow `6dec9565-90eb-463b-a068-4860588d9dad`。Human は Plan を Approve していない。State は revision 31 / awaiting-plan-review、approvedPlanRef / workerAttemptRef なし、implementationRevision 0、source bytes 不変。元 classifier の STANDARD/0.6 と Human TDD の両 evidence を保持する。
- 最新 reader による post-run audit は **18 immutable refs の hash / complete Human chain / TDD Test Seams / exact Plan Gate binding PASS**。Scout / Planner / Simplicity の public process-terminal proof は全て **observed / exit 0**。Raw reports `/tmp/issue45-method-smoke-2.json` / `/tmp/issue45-artifact-audit-2.json`、再実行可能な audit `/tmp/issue45-audit-2.mjs`、isolated manifest `/tmp/issue45-fixture-2.json`（machine-local）。Classifier は controlled fixture（live Jev 0）で、STANDARD answer・explicit ESCALATE・old-block resume・error paths は automated tests の範囲。Full Worker lifecycle / actual Plan/Code approval の PASS ではない。
- 元 `pi-test` Workflow は revision 39 / blocked / updatedAt 2026-10-06T04:29:13.788Z のまま保持した。

Required automated checks and the focused real Pi Human-selection / Plan-Gate smoke are recorded above. Issue #45 remains OPEN; no closure / merge / release / commit or Human Plan/Code approval is inferred. Both fixture tabs / evidence are retained for inspection; no ambiguous workflow is resumed automatically.

## Opt-in real Pi / Herdr smoke

[Smoke extension](../../tests/platform/development-method-smoke-extension.ts) uses actual root Human questionnaire, Scout, Planner, Simplicity Reviewer and Plannotator Plan UI. Controlled classifier STANDARD/0.6 makes escalation deterministic; this is not a live Jev verification. Disposable source bytes must remain unchanged. The fixture detaches normal continuation when opening the actual Plan Gate, so it cannot treat any UI approval as permission to launch a Worker. No Plan/Code approval is requested.

Use the existing pinned [clarification fixture](../../tests/platform/clarification-fixture.ts), isolated agent settings with package discovery for released pi-subagents, public questionnaire and installed Plannotator, and a short `--session-dir`. Start Pi in a **new Herdr tab**, load the smoke extension and run:

```text
/development-method-smoke /tmp/issue45-method-smoke.json
```

The Human must choose STANDARD or TDD in the actual questionnaire. The Agent must not answer or approve on behalf of the Human. Audit the saved report/State/evidence/process-terminal proof before reporting PASS. Preserve operator settings/auth and the original `pi-test` Workflow; only fixture-local resources may be cleaned up.
