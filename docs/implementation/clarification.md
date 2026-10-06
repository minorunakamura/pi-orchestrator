# Production root clarification (#8)

## Scope / preparation

Issue #8 の本文・acceptance criteria（comments なし）と tracking #13 を確認した。Prerequisite #3 / #18 / #19 / #21 / #4 / #6 / #7 は CLOSED。Planning / integrations / artifact / persistence / authority / test contracts を維持する。

Production composition に root/Main `ClarificationPort` と、`wf_clarification_round` / `wf_clarification_complete` の model-only tools を接続した。通常の lifecycle は引き続き Orchestrator の `driveWorkflow()` が所有する。Child question loop / workflow script / classifier に Human authority を移していない。Third-party package / skill の変更、private API、新しい runtime dependency はない。Schema 用の既存 host `@earendil-works/pi-ai` は peer として宣言する。

## Supported public source / host contract

正規配布元は **[minorunakamura/pi-ask-user-question](https://github.com/minorunakamura/pi-ask-user-question/tree/0a6ad2c5fd7f79ceccb51bc791c10554789bdbd2)**。Operator が GitHub-only distribution として commit **`0a6ad2c5fd7f79ceccb51bc791c10554789bdbd2`** の採用を明示承認した。Tag/npm publication は prerequisite にしない。同名 npm package、moving main、別 module instance/private installed-file lookup は使わない。

```sh
pi install git:github.com/minorunakamura/pi-ask-user-question@0a6ad2c5fd7f79ceccb51bc791c10554789bdbd2
```

Underlying `grilling` と、GRILL_WITH_DOCS の `domain-modeling`（CONTEXT/ADR format references を含む）を Pi の public skill resources に用意する。Wrapper の model invocation に依存しない。Command context の `getSystemPromptOptions().skills` から解決した実際の path/content/SHA-256 と root session ID を request に保存し、各 owned tool execution で skill drift を検証する。

同一 root process の公開 `pi.events` request/reply/cancel v1 を使う。Correlation、normalized exact questions、complete selections、answered/cancelled status を検証する。`ctx.mode === "tui"` と registered questionnaire/owned tools が必要。RPC/print/json、missing skills/package、unsupported loadout は fail closed。`--no-tools` は root registry 全体を除去するため supported smoke の起動には使わない。Registered-but-inactive な owned tools は public `setActiveTools()` で選択する。Human deadline は 15 minutes、abort/timeout は cancel と block、fallback/guessed answer はない。

## Durable lifecycle

1. Exact fresh mode / Task / Scout / Diagnosis / Research / routing / current Plan / previous clarification / Round Decision refs と bounded bodies を集める。Evidence は per-artifact 64 KiB、total 128 KiB、最大12 refs。超過/欠損/hash mismatch は拒否し、黙って truncate しない。
2. Request/prompt/source State revision・semantic digest/canonical project root/root skill setup を immutable `clarification` Artifact に保存 → `planning.clarificationRequestRef` を CAS 保存 → root message / model turn。Transient `clarificationPrompt` は不要。Coding Round Decision 起点の GRILL_ME は、historical SKIP mode ref を current mode authority として偽装しない。
3. Root が grilling の decision frontier を質問にする。1 round は最大4 questions、最終確認を含め最大8 rounds。Question intent Artifact → `planning.clarificationProgressRef` State → public questionnaire → exact Human reply Artifact → State。Jev は質問/回答を生成しない。Prose-only chat は durable answer ではない。
4. Frontier が解消したら root が summary と optional exact document proposals を提示する。Owned complete tool が **別の explicit Human shared-understanding confirmation** を開く。空の question list / root の自己申告だけで完了しない。
5. Confirmed final answer（および文書 evidence）→ completed Artifact / progress State → `CLARIFICATION_COMPLETE` / State → exact workflow/request wake hint → 同じ normal driver。通知自体は answer/approval authority ではない。Architecture/Planner は最新 document evidence と actual file identity を検証し、Planner は exact document ref/body を受け取る。Classifier に document body を送る場合は既存 consent の `design` category が必要で、grant を自動拡張しない。

Request/round/reply/completion は content-addressed JSON payload を `.md` immutable Artifact として保存する。Completion は前の reply/round refs を辿れる。State は long bodies ではなく request/progress/document refs のみ保持する。

## Narrow domain-document authority / #5 boundary

GRILL_ME は document proposal/write を拒否する。GRILL_WITH_DOCS でも mode 単独では grant にならない。

- Candidate は root `CONTEXT.md` / `CONTEXT-MAP.md`、nested `CONTEXT.md`、root/nested `docs/adr/*.md` のみ。Exact normalized project-relative paths と full proposed content を Human が確認する。
- Create/update のみ、最大4 documents、各 proposed content は8 KiB。Traversal、absolute/backslash path、symlink parent/target、hardlink、source/config/package write、runtime/dependency directories を拒否する。Existing before contents は64 KiBまで。Question payload の32 KiB bound も適用し、large changes を隠して承認させない。
- Confirmed answer State → before content/absence/hash + exact scope/source revision/request/answer binding の `domain-document-write` intent Artifact → State → file write。Opened file の before bytes を再確認し、`O_NOFOLLOW` / exclusive create / fsync を使う。
- After full contents/hashes / predecessor intent / same answer の result Artifact → State → clarification completion。Before/after full contents が exact change evidence。Routing/Planner は request / intent / answer / completion / current file の binding を再検証する。
- Active root clarification は owned tools のみ許可し、raw ask/edit/write/shell/MCP/Codemode/child 経由の迂回を拒否する。Own tools は execution 時の実際の params/path/hash/session を検証するため、後続 hook による arguments 変更は grant を広げない。

#5 が使う durable boundary は request root identity と exact document intent/result refs。これは **clarification 内の ceiling** であり、全 workflow phases / conflicting workspace ownership / trusted extension の直接 filesystem access を sandbox にするものではない。General Main ownership enforcement は #5、general workspace evidence は #10 が所有する。Human answer/docs は Plan Approval、Worker/Fix authority、Code Approval の代替ではない。

## Recovery

- Completed progress を exact hash/confirmation/document binding で確認できれば、State transition のみ recover し、質問/文書 write を繰り返さない。
- Main turn の通信エラー/中断だけでは、保存済み request / answered rounds を失効させない。同じ root session の明示的 `/wf-resume` は初回通知済みでも verified request と全 answered history を再提示する。再提示自体は質問/文書 write の replay、completion、approval ではない。Driver の pending wait は維持し、自動 retry loop は追加しない。
- 各 provider request の public `context` hook でも ownership/workspace/source/request/root session/skill と State-bound answer→pending→previous answer chain を再検証して復元する。Transcript の欠落/compaction/host retry に依存せず、既回答を再質問しないよう明示する。History は最大8 rounds、全 question/answer projection は128 KiBまでとし、超過/破損/不正 chain は黙って truncate せず拒否する。Tool execution 境界でも history を再検証し、context 検証後の corruption で Human interaction を開始しない。
- Ownership context は verified durable request の継続に新しい通知を要求しない。復元できない場合は停止指示と tool deny ceiling を維持する。Request-local context は turn scheduling / Human answer / Workflow authority の代替ではない。
- Persisted pending question / declined reply / unresolved document intent は block。UI closed/user-cancelled/caller-aborted/shutdown/timeout は completion/SKIP にしない。
- Output-before-State failure は保存済み intent を barrier とする。Exact immutable publication は idempotent だが、orphan の存在だけで authority に昇格しない。Partial/unrecorded document outcome は明示的 operator reconciliation が必要で、root tool の直接呼び出しでも replay できない。
- Request/source/mode/skill/root session が変われば拒否する。別 root session への自動 adoption、文書の blind retry/rollback、Human の代理回答は実装しない。Missing facts は unresolved prerequisite として止め、root の raw investigation/child launch に permission を与えない。

## Acceptance coverage

| Issue #8 criterion | Evidence |
| --- | --- |
| Real Clarification opens Human question flow | Production composition、normal-driver tests、actual root + public questionnaire smoke |
| GRILL_ME: grilling without domain mutation | Mode-aware skills、document rejection tests、live workspace has no CONTEXT after first mode |
| GRILL_WITH_DOCS: domain-modeling and exact authorized scope | Skill/formats、path/link/hardlink/source denial、intent/answer/after tests、live exact CONTEXT creation |
| Missing transient prompt no longer blocks | Durable evidence-generated prompt、driver/resume tests、live command composition without clarificationPrompt |
| Request and answer durable/hash-bound | Pre-interaction request/round CAS barriers、exact reply validation、stale/corruption/save-fault/recovery tests、live five-artifact chains |
| Documentation bound to same clarification/State | Exact request/source revision/answer/intent/after links、actual-file drift and partial-write/replay rejection、Planner document input |
| Clarification is not implementation authority | No Plan/Code approval Events、mandatory Plan Gate wait、zero Worker / implementation refs in tests and smoke |
| Real Pi smoke both modes, supported public APIs | Pi 0.99.1 + pinned question source + actual skills/Human input/Planner; Herdr tab evidence below |

## Validation / real Pi evidence

Focused `clarification` / `planning-orchestrator` / production command tests: **47 tests PASS**（3 files）。Final `VITEST_MAX_WORKERS=2 pnpm check`: **PASS — typecheck / lint（warnings なし）/ format / 53 files / 704 tests**。`pnpm install --frozen-lockfile --ignore-scripts` / `git diff --check`: PASS。変更 Markdown の local paths は **58件 PASS**。Immutable artifact/document audit も PASS。

Actual Human が両 mode の frontier question と final confirmation（計4 dialogs）に回答した smoke は **PASS**：

- Pi **0.99.1**、pi-subagents **0.74.0**、root/Main and real Planner **openai/gpt-6.1-sol**, thinking **medium**。
- Herdr new tab / pane / Agent **`wF:t2K` / `wF:p2X` / `issue8-human-clarification`**。
- Start **2026-10-03T05:02:47.583Z**、finish **2026-10-03T05:09:51.161Z**。
- GRILL_ME は文書変更なし。GRILL_WITH_DOCS は Human が exact content を確認した root `CONTEXT.md` のみ作成。`source.ts` bytes 不変。
- Both confirmed durable answers → actual read-only Planner → persisted required Plan Gate pending。Both workflows に approvedPlanRef / implementationRef はない。
- Latest reader による post-run audit: each five-artifact question/reply/completion chain と request/hash、document request/intent/answer/after/current-file binding が PASS。Both Planner の public process-terminal proof は **observed / exit 0**。
- Raw reports: `/tmp/issue8-human-clarification-smoke.json` / `/tmp/issue8-clarification-artifact-audit.json`（machine-local）。Process-terminal proof と latest reader audit を確認後、作成した successful / failed probe tabs と temporary auth symlinks のみ cleanup 済み。

First restricted-loadout probes は PASS ではない。`--no-tools` による root tool removal と prose-only wait を検出し、registered capability check / explicit public owned-tool selection / durable-round instructions を追加した。Failed probe IDs は `wF:t2H` / `wF:p2V` と `wF:t2J` / `wF:p2W`。A fast consecutive Herdr slash-command submission also combined editor text; commands を再送・Human answer とみなさず、actual editor state を確認した。TUI で受理されていない **command text** の submit のみ行い、質問の選択/confirmation を Agent が代行していない。

Scout/stage/mode classifier は scripted fixtures（live classify 0）。Plan Gate は scripted public pending contract であり、actual Plannotator approval / Code Gate / Worker / full v1 の PASS ではない。Positive nested ADR / negative path/cancellation/save-fault scenarios は unit/contract tests。#11 generated-workflow consent、#5 general ownership、#12 integrated Human Gates/full lifecycle の境界を維持する。Issue #13 / release evidence / CHANGELOG を完了扱いにしない。

### Reproduction

[Fixture](../../tests/platform/clarification-fixture.ts) は selected checkout の origin/HEAD/tracked source を検証し、fixed archive、isolated settings、explicit skill paths、operator auth への temporary symlink を作る。Operator settings/auth は変更しない。

```sh
node --experimental-strip-types --input-type=module -e '
  import { clarificationFixture } from "./tests/platform/clarification-fixture.ts";
  console.log(JSON.stringify(await clarificationFixture(
    process.env.HOME + "/.pi/agent/auth.json", "openai/gpt-6.1-sol",
    process.env.HOME + "/.pi/agent/git/github.com/minorunakamura/pi-ask-user-question",
    process.env.HOME + "/.pi/agent/skills")));
'
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd <fixture-cwd> \
  --label issue8-clarification --env PI_CODING_AGENT_DIR=<fixture-agentDir> --no-focus
herdr agent start issue8-clarification --kind pi --pane <returned-pane-id> -- \
  --no-approve --no-session --no-extensions --no-prompt-templates --no-context-files \
  -e <repo>/node_modules/pi-subagents -e <fixture-questionPackage> \
  -e <repo>/tests/platform/clarification-smoke-extension.ts --model openai/gpt-6.1-sol:medium
herdr agent prompt issue8-clarification '/clarification-smoke /tmp/issue8-clarification-smoke.json'
# Operator が actual questionnaire の内容を確認して回答する。Agent は回答/承認を代行しない。
# Report と terminal proof を検証後、作成 tab と temporary auth symlink のみ cleanup。
```

## Interrupted Main recovery (#42)

Issue #42 は root/Main の中断後に State-bound request と全 Human answer history を復元する。実装は既存 bridge / ownership context / clarification schema に限定し、dependency・retry scheduler・Worker authority を追加しない。

- Public context hook、owned question/confirmation tools、`WorkflowCommandRuntime.resume()` の回帰テストで、同一 root の再提示、empty transcript / bridge 再生成、全 rounds、corrupt/hash-valid-invalid history、skill/workspace drift、pending/declined、history bound、context 検証後の corruption を検証した。既存 GRILL_WITH_DOCS の文書 barrier / Human Gate tests も維持する。
- 最終 `VITEST_MAX_WORKERS=1 pnpm check`: **PASS — typecheck / lint / format、67 files / 969 tests**、2026-10-06T04:04:14Z開始。既定並列実行と2 workers は既存 heavy Code Feedback tests の5秒 timeout を検出したため PASS と扱わず、timeout/assertion を緩めず1 workerで再検証した。
- [Recovery smoke](../../tests/platform/clarification-recovery-smoke-extension.ts): Herdr new tab **`wF:t3R` / `wF:p43`**。Actual Main / Planner / Simplicity Reviewer は **openai/gpt-6.1-sol**。Actual Human の2 frontier answers → public `ctx.abort()` → 同じ root UUID の `/wf-resume` → final Human confirmation → actual read-only planning/review → required **awaiting-plan-review**。Main tool calls は round 2回 + complete 1回のみ。Source bytes 不変、approvedPlanRef / implementationRef なし、State refs 32件の hash一致、両 child の process-terminal observed / exit 0 を確認した。
- 最初の `wF:t3P` は explicit `-e pi-subagents` に package `sourceInfo.baseDir` がないため preflightで停止し、full PASS ではない。再検証は isolated settings の `packages` で released pi-subagents を読み込み、`--no-extensions` は指定しない。途中の gpt-5.6-luna overload は成功と扱わず、root model を明示変更した。281-byte session path は ceiling の256-byte上限で拒否されたため、停止済みテスト session だけを `/tmp/issue42-sessions/recovery.jsonl` へコピーし、同じ UUID を `--session` で再開した。別 UUID の adoption / ceiling緩和 / possible dispatch の blind retry はない。新規再現は最初から短い `--session-dir` を指定する。
- Raw evidence: `/tmp/issue42-recovery-final-smoke.json`、`/tmp/issue42-check-final-serial.log`（machine-local）。Transport outage は注入せず、State保存後のabortを使う。Scout/classifier と Plan Gate pending response は fixtures、actual Plan/Code approval / Worker / full lifecycle の PASS ではない。Transient restored context snapshot は fixture process restartを跨いで保存されなかったため observed snapshot と推定せず、empty-transcript restoration の直接検証は回帰テストに限定する。
- 元の `pi-test` Workflow は revision 22 / clarifying のまま保存し、調査・修正中に回答や State を変更していない。Issue closure / release / commit はこの検証記録から推定しない。
