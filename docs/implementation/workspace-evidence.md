# Workspace Evidence / Non-Git Code Review (#10)

## Scope / preparation

[Issue #10](https://github.com/minorunakamura/pi-orchestrator/issues/10) は comments なし。本文・全 acceptance criteria と [Tracking #13](https://github.com/minorunakamura/pi-orchestrator/issues/13) の本文・13 comments を確認した。#3 / #4 / #6 / #7 / #8 / #11 / #16 / #14 / #17 / #20 / #21 / #15 / #9 を含む前提 child Issues は CLOSED。推奨順序は #10 → #5 → #12。#9 の production synchronous Gate/source contract を再利用する。

Canonical [Artifacts §5](../basic-design/artifacts.md#5-workspace-evidence--code-review-source)、[Persistence §6.1](../detailed-design/persistence-recovery.md#61-worker-attempt-evidence-i2)、[Plannotator §4](../detailed-design/plannotator.md#4-git--non-git-review-source)、[Runtime](../detailed-design/runtime-design.md)、[Test Strategy §8](../detailed-design/test-strategy.md#8-workspace--plannotator-tests-109) に従う。Main ownership enforcement (#5)、integrated production verification (#12)、release evidence / CHANGELOG は変更しない。

## Implementation

- [WorkspaceEvidenceProvider](../../src/runtime/worker/workspace-evidence.ts) の `GitWorkspaceEvidenceProvider` / `FilesystemWorkspaceEvidenceProvider` は capture と reviewPatch を提供する。新 dependency / transport / workflow script / third-party modification はない。
- Git は既存の canonical root/cwd、HEAD（unborn は null）、index/worktree digests、untracked content、submodule/hidden-index rejection と static patch 制限を保持する。Snapshot に explicit `kind: git` / versioned exclusions policy を追加した。
- Filesystem は Git executable を使用しない。Canonical cwd/root、normalized sorted relative paths、file/directory types/modes、file SHA-256、full UTF-8 contents、stable aggregate entries digest と versioned exclusions/limits を記録する。
- Ancestors に `.git` marker があれば Git を選ぶ。Broken marker / missing Git / observation failure を filesystem fallback にしない。Persisted provider/root/cwd/policy と異なる次の observation は拒否する。
- Filesystem observation は2回一致を必須にし、途中の directory/file identity・size・mtime/ctime drift、unsupported links/entries、read failure は block する。Final file open は `O_NOFOLLOW | O_NONBLOCK`、regular-file / inode / single-link checks と bounded read を使用する。Filesystem atomic snapshot / OS sandbox とは扱わない。

### Durable baseline / Worker authority

Snapshot と baseline bytes は immutable Worker attempt の `before` / `after.snapshot` に保持する。別の同一 snapshot Artifact は作らない。`coding.workspaceBaselineRef` は **最初の Worker intent** を pin し、Fix / replan / proven non-dispatch recovery でも保持する。`coding.workerAttemptRef` は現在の exact terminal/received observation を参照する。

```text
capture stable before / verify provider + previous after
 -> immutable original baseline + Worker intent
 -> CAS State (workspaceBaselineRef / workerAttemptRef)
 -> public preflight / recheck current workspace
 -> immutable launch + State
 -> Worker dispatch / receipt
 -> received Artifact + State
 -> same-provider after observation
 -> implementation / terminal observation + State
 -> normal driver
```

Next Worker は previous after と現在の workspace が一致しなければ dispatch しない。Proven non-dispatch で current attempt ref を clear しても original baseline/provider は失わない。Success-before-State recovery は exact public result を使用し、すでに保存された after と異なる live contents を新しい after として採用しない。Ambiguous Worker は再起動しない。

### Filesystem patch / Code Gate

Original baseline に到達する immutable predecessor refs/hash と workflow/revision/provider/root/policy を検証する。Fix 後も最初の baseline を使うため、以前の Worker による deletion/modification を後の Code Review から落とさない。Pre-existing unchanged contents は manifest に残るが patch に変更として表示しない。

Patch は deterministic sorted create/modify/delete、executable-mode change、empty regular file、CRLF、no-final-newline、quoted space/Unicode/quote paths を扱う。Full-file unified hunks を使用し、unbounded LCS / 新 diff dependency を追加しない。Tests は retained bytes から baseline を再構成し、公開 `git apply --no-index` で exact resulting contents を検証する（production filesystem provider は Git を呼ばない）。

`source.type: filesystem-patch` は original `baselineRef` と current `workerAttemptRef`、canonical cwd/immutable patchFile、patch SHA-256、whole current snapshot digest を bind する。Code request は public `{ cwd, patchFile }` のみ。Gate 前・settlement/recovery 時に current workspace/provider、original retained baseline/Worker linkage、regenerated patch hash を再検証する。

#9 の immutable local attempt → CAS State → synchronous request → exact Human result → Artifact/State ordering、no Code polling、no Human-duration timeout、duplicate no-op と result-before-State recovery を維持する。Patch generation / Worker output / provider detection は approval を付与しない。Human Plan/Code Gates、Orchestrator-owned lifecycle/State/Artifact/CAS を維持する。

## Explicit bounds / unsupported policy

| Item | Policy |
| --- | --- |
| Filesystem text | Round-trip-valid UTF-8; NUL / unsupported control bytes / invalid UTF-8 は拒否 |
| File content | 256 KiB/file、8 MiB aggregate |
| Tree | 10,000 entries、depth 64、15,000 ms observation checks |
| Regular file modes | 0644 / 0755; special permission bits / other file modes は拒否 |
| Links / special entries | Symlink（known link を follow しない）、hardlink、FIFO/socket/device は拒否 |
| Exclusions | `.pi/orchestrator` と canonical in-workspace ArtifactStore root のみ。Policy に保存; `.gitignore` / node_modules を暗黙除外しない |
| Static patch | 1 MiBまで。Oversized changes は省略/truncateせず block |
| Directories | Identity に含む。File changes に伴う directory create/delete は扱うが、empty-directory-only / directory mode / file-directory replacement は unified patch で安全に表示できないため block |
| Legacy evidence | Provider/policy/original baseline identity がない legacy authority は自動 migration/rebinding しない |

これらは意図した fail-closed limits。Unsupported post-Worker contents は mutation を rollback/retry せず、保存済み intent/received/available observation を残して停止する。Known symlink rejection・double observation は adversarial concurrent filesystem mutation に対する OS isolation ではない。Observation deadline checks は filesystem operations の cancellation proof ではない。

## Acceptance coverage

| #10 criterion | Evidence |
| --- | --- |
| Project without `.git` executes Worker evidence capture | `non-git-workflow.test.ts`: real normal driver / runners、both Gate fixture contracts、filesystem before/after → completed。`workspace-evidence.test.ts`: PATH empty の capture/patch |
| Out-of-band mutation remains detectable | Before Code / during Human wait / before Fix / success-before-State recovery の drift rejection。Unit stable digest、mode/content identity、injected unstable observation |
| Plannotator opens static patch mode | Public adapter payload is exactly cwd/patchFile; `filesystem-patch` source refs/hash/regeneration checks。Real Pi smoke below |
| Existing Git authority remains intact | Existing Git Code-source / Worker / completed-authority / deviation / recovery / Gate tests; explicit Git provider/policy and no filesystem fallback |
| Create/modify/delete, symlinks/unsupported entries, exclusions, resume consistency | File replay tests、binary/invalid UTF-8/large/aggregate bounds、symlink/hardlink/FIFO/mode rejection、canonical alias/exclusions、both provider switches、retained original baseline through Human feedback Fix / proven non-dispatch / exact Worker recovery / missing baseline |

Runnable tests: [workspace-evidence.test.ts](../../tests/runtime/worker/workspace-evidence.test.ts)、[non-git-workflow.test.ts](../../tests/runtime/orchestrator/non-git-workflow.test.ts)、existing [Git source](../../tests/runtime/worker/code-review-source.test.ts)、[Code Gate](../../tests/runtime/orchestrator/code-review-gate.test.ts)。

## Validation record

- Final focused workspace/Git-source/non-Git/recovery: **PASS — 4 files / 37 tests**。
- First full `VITEST_MAX_WORKERS=1 pnpm check`: **FAIL — 1 assertion / 873 tests**。Workspace drift error wording の互換性を修正した。Safety assertion / timeout を緩和しない。
- Second full `VITEST_MAX_WORKERS=2 pnpm check`: **FAIL — 2 existing 5-second tests timed out / 873 tests**。Parallel load と live smoke 同時実行下の timeout/cleanup failure を PASS と扱わない。
- Final `VITEST_MAX_WORKERS=1 pnpm check`: **PASS — typecheck / lint（warningsなし）/ format / 63 files / 875 tests**。Final serial run は 589.80 seconds。Timeout / safety assertions は変更していない。
- `git diff --check` / changed Markdown local links・anchors **72件**: **PASS**。

### Real Pi / non-Git static Code UI smoke

[Existing opt-in smoke harness](../../tests/platform/code-review-smoke-extension.ts) に `/non-git-code-review-smoke <report-path>` を追加した。Disposable non-Git workspace の scripted Worker が create/modify/delete を行い、actual Pi EventBus / installed Plannotator / production Code adapter / source producer / normal driver が **one** static Code request を開く。Preceding Scout/Planner/Worker/reviews/Validation/classifier/Human Plan approval は fixtures; actual Worker / live classifier / actual Human Plan Gate / full v1 PASS とは扱わない。

- Pi **0.99.1** / installed Plannotator **0.27.16**。
- New Herdr tab / pane / Agent: **`wF:t2Z` / `wF:p3A` / `issue10-non-git`**。
- Started **2026-10-04T08:34:46.780Z**。Report: `/tmp/issue10-non-git-smoke.json`。
- `filesystem-patch` original/current refs、canonical patch SHA-256、create/modify/delete contents、unchanged pre-existing content exclusion、exact public cwd/patchFile payload、pre-request durable local intent を確認。
- **Actual Human settlement / focused smoke: PASS**。Finished **2026-10-04T08:54:06.528Z**、wait **1,159,422 ms**（約19分19秒）。公開 result は `{ approved: true, feedback: "", annotations: [] }`。Immutable exact-bound result → State revision **50 / completed** → recreated recovery no-op を確認。
- Actual Code request **1** / Code poll **0** / reopen **0** / actual Worker **0** / live classifier **0**。Human wait を integration timeout / inferred approval と扱わない。
- Independent stdlib final audit: **PASS — 34 immutable refs / current State / exact Plan・implementation・local attempt・settled result・original/current Worker refs / baseline + after hashes / regenerated patch / unchanged current workspace**。Reports: `/tmp/issue10-workspace-audit.json`（pending時33 refs）、`/tmp/issue10-workspace-final-audit.json`（settled後34 refs）。
- User への画面確認時には既存 request はすでに終了していた。Structured answer を Code approval として使わず、保存済み actual public response のみを audit。新しい review は開かなかった。Final audit 後、作成した **wF:t2Z** のみ close。
- 初回独立 audit は manifest entry を ArtifactRef と誤認して失敗した。`schemaVersion:1` を含む exact ref shape に修正し、同じ保存済み evidence の audit のみを再実施した。Worker/UI を再起動しない。
- tmux / direct Pi spawn / Human代理回答 / third-party modification / operator auth/settings mutation は行わない。

再現は [#9 smoke procedure](./code-review.md#real-pi--actual-human-code-smoke) と同じ isolated `platformFixture()`、explicit Plannotator/probe-provider/Code harness を使用する。新 Herdr tab で `/non-git-code-review-smoke <report-path>` を実行し、actual browser で Human が5秒以上待って Approve/Feedback を操作する。成功後に State/result/source/recovery audit と作成 tab のみの cleanup を行う。未完了 request を retry/reopen しない。

## Completion boundary

#10 の明記された scope / acceptance criteria に対する既知の blocking・important な実装/必須検証残件はない。上記の bounded text/entry/patch policy、legacy authority の fail-closed refusal は意図した制限。Actual Worker / actual Human Plan Gate / live classifier を含む full v1 lifecycle の PASS は主張しない。General Main ownership は #5、integrated Git/non-Git lifecycle / all actual Gates / live classifier / release verification は #12 の既存 scope。#13 / GitHub statuses / release evidence / CHANGELOG は更新しない。
