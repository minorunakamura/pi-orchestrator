# Issue #9 — synchronous Human Code Gate

対象: [Issue #9](https://github.com/minorunakamura/pi-orchestrator/issues/9)。依存・順序は [#13](https://github.com/minorunakamura/pi-orchestrator/issues/13)、canonical contract は [Plannotator](../detailed-design/plannotator.md) / [Coding Orchestration](../detailed-design/coding-orchestration.md#15-human-code-gate) / [Recovery](../detailed-design/persistence-recovery.md#12-phase-specific-reconciliation)。

## Preparation / scope

#9 は OPEN、comments なし。#13 の body / relevant completion comments と prerequisite 状態を確認。#3 / #18 / #19 / #21 / #4 / #6 / #7 / #8 / #11 / #16 / #14 / #17 / #20 / #15 は CLOSED。#10 は OPEN で、#13 に従って parallel producer として分離する。

既存の async Code handle / external review-status / 5-second timer を除去する。既存の Git observation、immutable Artifact、StateStore/CAS、normal driver、mandatory Human Gates を再利用。第三者 package、private API、runtime dependency、workflow scripts、release evidence / CHANGELOG は変更しない。

## Public adapter

Released public [0.27.23 contract](https://unpkg.com/@plannotator/pi-extension@0.27.23/plannotator-events.ts) と実インストールの [0.27.16 contract](https://unpkg.com/@plannotator/pi-extension@0.27.16/plannotator-events.ts) を確認。0.27.23 を新しい minimum version として要求しない。

- Plan: `plan-review` → `{ status: "pending", reviewId }` → exact persisted binding に対する `review-status`。従来の bounded integration timeout と async recovery を維持。
- Code: `openCodeReview()` → `{ approved, feedback?, annotations? }` の settled result。公開 payload は cwd / Git options または patchFile のみ。implementationRef/revision / local attempt / origin は送信しない。
- Code request の requestId は local intent の correlation identity。Code に外部 reviewId、`getCodeReview()`、status polling、Human deadline はない。24 hours の fake-clock wait 中も zero timers / unsettled を検証。
- Explicit unavailable / throw / invalid envelope は fail closed。`agentSwitch` 等の UI hint は workflow / execution / approval authority にしない。Approval に付随する notes / annotations も result Artifact に保持。

## Durable local binding / authority

```text
current immutable implementation + succeeded Worker workspace evidence
 -> exact Git static patch + source verification
 -> code-reviews/attempt-rN.json
 -> CAS coding.codeReviewAttemptRef + coding.codeReview(local attemptId/ref/revision)
 -> public synchronous code-review
 -> current durable State / exact original attempt / unchanged source verification
 -> immutable code-reviews/result-<local-attemptId>.json
 -> CODE_APPROVED | CODE_FEEDBACK -> CAS State
 -> same normal driver continuation
```

Attempt は既存 `code-review` Artifact family を使用し、`recordType: code-review-attempt` / schemaVersion / workflow・approved Plan/version・exact implementationRef/revision / UUID local attemptId / requestId / pending / timestamp / source を保存。State は ref と短い local binding のみ。

Source は `type: git-patch` / canonical cwd / canonical immutable patchFile / patch SHA-256 / workspace digest。Workspace digest は既存 Git snapshot の root/cwd/HEAD/index/worktree/untracked identity に bind。Worker の received observation ではなく、現在の succeeded observation と implementation linkage / after snapshot を検証する。Plan と implementation output hash の既存 authority checks を維持。

Human settlement 後は cached pre-request State を authority とせず、StateStore から現在の State を読み直す。同じ revision でも違う implementation hash、Plan/workflow/local attempt、source drift、missing binding、legacy external Code identity を拒否。Driver の error handling も intent publication 後の current State revision を使用する。

Identical applied duplicate は現在の advanced/blocked State を変更しない。Changed settled result は拒否。CODE_FEEDBACK は Human counter のみを charge し、fresh Fix / new implementation で attempt/result を無効化する。両 Human Gates は必須のまま。

## Git / static source / #10 boundary

Production Git review も static patch に固定する。Live VCS UI の mode switching / runtime Artifact 表示によって review scope が変わることを避けるためであり、Git を non-Git evidence として扱う変更ではない。

- Git HEAD（unborn は現在の tracked additions）→ current worktree の net diff と untracked additions を deterministic path order で生成。Staged + unstaged の同一 file を二重 patch として扱わない。
- Pre-existing changes を消去せず、Git provider の existing observation/exclusion policy を維持。`.pi/orchestrator` と exact Artifact root を除外。
- `--no-ext-diff` / `--no-textconv` / fixed prefixes / no color、finite Git command wait、1 MiB patch limit。Unsupported binary/link/submodule/hidden-index evidence を省略して clean と扱わない。
- Git observation の cwd と exclusion directory の両方を canonicalize。`/tmp` / symlink alias から起動したときの runtime Artifact false drift を shared observation function で修正し regression test を追加。
- Patch/workspace を preparation 後・intent State 保存後・Human settlement 時・durable result recovery 時に検証。Patch tampering / out-of-band mutation は approval にならず operator attention。

Adapter の public `patchFile` は repository を要求しない。**Production Worker / review-source producer は今回 Git のまま**。Non-Git filesystem manifest、retained baseline、create/modify/delete patch generation、provider-specific recovery は #10 の範囲。#10 は source variant / producer / verification を追加しても、pre-request local intent と settled result binding を維持し、Code polling を導入しない。

## Recovery / deliberate limits

- Local intent Artifact/State failure → zero external Code requests。Orphan intent も再表示の許可にならない。
- Lost result / shutdown / responder silence → unresolved local attempt が barrier。Code status を捏造せず、resume は explicit recovery 待ちで block。Public EventBus に responder-presence/Code-status API はないため、silence を Human wait と区別する fake timeout は追加しない。
- Result Artifact failure → no authority。Result-before-State failure → original immutable result のみを recover / apply。Adapter recreation に UI reopen / Code polling は不要。
- Legacy Code handle / previous source schema は auto-migrate / rebind しない。Explicit safe abandon/reconciliation の UI は本 Issue では追加しない。
- Observations は filesystem atomicity / OS sandbox / universal semantic implementation verifier を主張しない。General ownership guard は #5、non-Git は #10、full integrated production verification は #12。

## Acceptance criteria coverage

| #9 criterion | Implementation / runnable evidence |
| --- | --- |
| Published Code response shape | `plannotator.test.ts` の boolean approval/feedback/annotations、invalid shape、Git options、static patch public payload tests。`FakePlannotatorGate` / shared workflow fixtures も同期契約へ変更 |
| Human duration is not integration timeout | Fake clock 24-hour wait、zero Code timers、single settlement。Focused actual Human smoke は下記 |
| Durable exact implementation approval/feedback | `code-review-gate.test.ts` の pre-request Artifact/State failures、lost result、binding/ref/revision/workflow/source tampering、result publication faults/recovery、current-State duplicates、changed result rejection。Normal driver の genuine wait / automatic continuation と fresh feedback Fix/new Gate を検証 |
| Plan remains async/reconcilable | Plan pending/external identity/recreated adapter/status recovery tests を維持。Code API・fixtures の external polling は削除 |

## Validation record

- Focused final run: **PASS — 4 files / 54 tests**（adapter / Code authority / Oracle compatibility / Git source）。
- Full final `VITEST_MAX_WORKERS=1 pnpm check`: **PASS — typecheck / lint（warnings なし）/ format / 61 files / 848 tests**。
- `git diff --check` / final format / changed Markdown local links: **PASS**。
- 最初の focused run は Worker received observation を succeeded after evidence と取り違えて失敗。現在の succeeded record / predecessor / implementation binding に修正し、assertions を弱めず focused PASS。
- 初期全体 check の old async fixture expectations、concurrent command-watcher/manual-driver lock collision、5-second Vitest load contention、Git fixture の operator signing config、non-canonical patch path を PASS と扱っていない。Fixture / expectations / canonical identity を修正し、既存 timeout / safety assertions は緩和しない。

### Real Pi / actual Human Code smoke

`tests/platform/code-review-smoke-extension.ts` は disposable fixture の preceding stages だけを scripted で構築し、actual Pi EventBus / installed Plannotator / production adapter / local gate / same normal driver を検証する。Actual Worker / live classifier / actual Human Plan approval / full lifecycle PASS ではない。

Initial smoke: Pi **0.99.1** / Plannotator **0.27.16**、new Herdr **wF:t2X / wF:p38 / issue9-code-review**。Actual Human approval は **29,349 ms**、Code request **1** / Code poll **0** / reopen **0**、full exact-bound result / `completed` / unchanged workspace / recreated recovery PASS。Independent hash/State/patch audit PASS。Source type 明示前の checkpoint として保持し、final schema の proof には代用しない。作成 tab は audit 後 close。

Final new Herdr **wF:t2Y / wF:p39 / issue9-code-final**、start **2026-10-04T07:26:51.953Z**、finish **2026-10-04T07:31:13.297Z**。Report `/tmp/issue9-code-review-final-smoke.json`。**Final Human settlement / independent audit: PASS**。

- Actual Human approval の wait **260,425 ms**（約4分20秒）。公開 response は `{ status: handled, result: { approved: true, feedback: "", annotations: [] } }`、external reviewId なし。
- Durable local attempt / exact source → one actual Code request → immutable exact result → State revision **50 / completed** → recreated local recovery の no-op。
- Actual Code request **1** / Code poll **0** / reopen **0**、workspace unchanged、current exact Plan/implementation/local correlation を確認。
- Independent stdlib audit: **34 unique immutable refs / hashes / State / implementation / Plan / patch / regenerated Git workspace digest PASS**。Source type/hash は final schema に bind。
- Preceding Scout/Planner/Worker/review/Validation/classifier/Human Plan approval は scripted fixtures。Actual Worker **0** / live classifier **0**。Actual Human Code UI / public adapter / same normal driver / local binding/recovery の focused proof であり、full v1 / #10 non-Git / actual Human Plan Gate / release PASS ではない。
- Audit 後、作成した両 Herdr tabs のみ close。Operator auth/settings と repository contents の mutation、tmux、direct Pi spawn、Human 代理回答なし。
- Herdr shell initialization の `agent_pane_busy` / one output-wait timeout は Code review failure/PASS と扱わず、available shell の確認後に public `agent start`。Possibly opened Code request の retry は行っていない。

再現: `platformFixture()` の isolated agentDir を `PI_CODING_AGENT_DIR` として新 Herdr tab に渡す。Root model は offline `platform-smoke/probe`。`--no-approve --no-extensions --no-skills --no-prompt-templates --no-themes` と explicit installed Plannotator / `probe-provider.ts` / `code-review-smoke-extension.ts` を指定し、Herdr `agent start` → `/code-review-smoke <report-path>`。Human が actual browser で 5 秒以上待ってから Approve/Feedback。Agent による代理回答、tmux、direct Pi spawn、operator auth/settings / third-party modifications は使用しない。

#9 の明記された scope / acceptance criteria と必須検証に対する既知の blocking / important な残件はない。#10 / #5 / #12 の既存 scope は維持し、#13 / release readiness の完了を主張しない。
