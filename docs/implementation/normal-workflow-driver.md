# Issue #4 — Normal workflow driver foundation

## Preparation / boundary

GitHub #4 と #13 の本文・acceptance criteria・comments、AGENTS.md、canonical runtime/planning/coding/persistence/state-machine contracts と現行 caller を確認。前提 #3 / #18 / #19 / #21 はすべて CLOSED で、対応 commit が checkout に含まれていることを確認した。

対象は **既存 runner の normal lifecycle backbone**。後続 stage、generic plugin registry、pi-subagents workflow-script execution mode は追加しない。Full canonical v1 lifecycle / production readiness / #13 completion を意味しない。

## Runtime changes

- Commands: `createWorkflow()` が Task と initial State を保存し、`driveWorkflow()` が Scout/Research、clarification、Planner、Human Plan Gate、Coding、Validation、Review/evaluation/Round Decision、Human Code Gate の既存 runner を順次呼ぶ。低レベル `startWorkflow()` の create + Context Gathering helper は stage 単位の既存 caller 用に維持する。
- Normal driver は `WorkflowReconciler` を呼ばない。`/wf-resume` は exact historical authority / orphan artifacts / unresolved attempts を reconcile してから同じ driver に渡す。Recovery-only の `reconcileWorkflow()` は通常実行を開始する API ではない。
- Failed Validation の artifact reference も State に保存してから Round Decision に進む。Validation failure、accepted findings、bounded stronger retry、Human Code feedback、Plan feedback / plan-conflict の安全な loop は phase ごとの resume 不要。
- Clarification の prompt/port が未供給なら genuine Human wait。provided answer は既存 runner の immutable evidence / State 保存後のみ Planning に進む。Declined answer は継続しない。
- 公開 `plannotator:review-result` は **wake-up hint のみ**。Command runtime は workflow ごとに通知を直列化し、initial open/binding save と競合した通知も保存完了後に処理する。Notification の approved/text を authority にせず、exact persisted Plan binding + public status を既存 runner が検証・保存する。無関係な reviewId は無視する。
- Plan Gate open intent と State marker を open 前に保存する。Binding 保存失敗後や orphan intent からは自動再 open しない。
- 既存 Code Gate port の accepted result も driver 内で検証・保存後に継続する。**現行 production Code adapter の async/reviewId 仮定の是正は #9**。Plan notification を Code result として使う架空の bridge は追加しない。

## Authority / persistence / execution

Driver は各 action 前に authoritative State を load し、workflowId と core invariants を検証する。通常 action は既存 workflow lock を使用。Planning child wait では lock を保持せず、既存 durable CAS intent / launch / receipt により duplicate dispatch を防ぐ。Persistence の返した State/revision を既存 runner が次の保存・side effect に使用する。

Blocked/failed/completed は normal driver で解除しない。Runner の保存失敗で後続 effect を開始しない。曖昧な Worker attempt は exact historical status/receipt/workspace の recovery なしに再 dispatch しない。Existing launch preflight/freshness、immutable artifacts、classifier reservations/decision freshness、mandatory Human Plan/Code Gates は維持する。

Static reviewer fanout は全 sibling の公開 preflight が成功してから最初の child を dispatch する。各 run は従来どおり resolved launch の保存前後にも freshness を再検証する。Missing static sibling による不要な片側 dispatch を防ぐ regression test を追加した。

Single-agent RPC の released status/full output contract のみを使う。Truncated parent-facing text は authoritative output にしない。Workflow-only `failureKind` を要求せず、error prose から workflow failure semantics を推定せず、新しい execution mode を導入しない。

Session shutdown は notification subscriptions を解除し、driver の次 action を停止する。In-flight child の cancellation/completion を宣言する操作ではない。残った attempt は既存の durable evidence と `/wf-resume` reconciliation で扱う。

## Acceptance coverage

| #4 criterion | Evidence |
| --- | --- |
| Single command → first genuine wait | Command composition tests: create → Scout/Research → clarification または Planner → Human Plan Gate |
| No per-phase resume / safe automatic loops | `drive-workflow.test.ts`: Validation failure、accepted finding、stronger retry、Plan/Code feedback、plan-conflict |
| Results durable before continuation | Existing phase-runner authority tests + driver routing/Validation/Gate State failure tests |
| Mandatory Human waits | Pending Plan/Code、clarification no prompt/decline、fresh approval after replan |
| Recovery first, same driver thereafter | Updated resume tests retain corrupt/missing/stale authority、orphan output、historical child identity、duplicate-mutation barriers |
| No second normal lifecycle | Normal driver test asserts zero `WorkflowReconciler.reconcile` calls; ordinary runner dispatch removed from recovery fallbacks |
| Public single-agent/preflight/truncation semantics | Static sibling preflight failure → zero dispatch regression + existing launch/subagents/lifecycle contract suites; no third-party or execution-mode changes |
| Stop/timeout fail closed | Driver timeout/ambiguous Worker/no redispatch and shutdown continuation tests; existing exact historical recovery tests |
| Persistence/CAS/returned State | Full command composition uses actual StateStore revision checks; launch/reservation/approval fault tests retained |

## Validation

| Validation | Final result |
| --- | --- |
| Focused driver/command/subagents suites | **PASS — 3 files / 47 tests** |
| `VITEST_MAX_WORKERS=2 pnpm check` | **PASS — typecheck / lint / format / 47 files, 613 tests**（168.30 seconds） |
| `git diff --check` | **PASS** |

4 workers の全 suite 実行では既存 `phase-c-e2e.test.ts` の Human Code feedback test が 5-second timeout（5.15 seconds）で1件失敗した。Test の timeout/authority assertions は緩めず、2 workers で全 validation を再実行して PASS を確認した。最終 source に対する未解消の required validation failure はない。

本 Issue の指定 validation は focused tests と pnpm check。Real Pi / actual Human Gate smoke は今回未実施であり、fake host/child/classifier を使う command tests を live integration と呼ばない。新しい third-party API/execution mode は追加していない。後続 producer 自身の実装・必要な検証と #12 の integrated production-path / new Herdr tab testing を省略する根拠にはしない。

## Remaining producer dependencies

- #6: sequential conditional Research/Clarification/Architecture + normal continuation。
- #7: required bugfix/hotfix Diagnosis + continuation。
- #8: root/Main GRILL_ME/GRILL_WITH_DOCS、confirmed answers/authorized document writes + continuation。
- #16: STANDARD/TDD、Test Seams、explicit Worker skills + continuation。
- #14: lightweight Plan、simplicity review、bounded one-shot refinement + continuation。
- #17: bounded read-only Oracle evidence + continuation。
- #15: material deviation → authority invalidation → fresh Plan/simplicity/Human approval。
- #9/#10: public synchronous Code Review / non-Git review source。
- #11: generated-workflow classifier consent。現在の production command は欠けた consent を fail closed にし、Plan approval を代用しない。
- #5/#20/#12: ownership enforcement / selected read-only Codemode / integrated production verification。

Missing target stages を success、SKIP、approval として記録していない。Foundation fixture が既存 runner だけで completed に達することは full canonical v1 completion の証拠ではない。GitHub Issue status / #13 checkboxes / release evidence / CHANGELOG は変更しない。
