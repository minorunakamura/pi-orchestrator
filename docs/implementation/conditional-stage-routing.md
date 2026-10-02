# Issue #6 — Sequential Conditional Stage Routing

## Scope / preparation

GitHub #6 と #13 の本文・全 comments、AGENTS.md、canonical planning / decision / state / artifact / persistence contracts、現行 caller を確認した。前提 #3 / #18 / #19 / #21 / #4 は CLOSED、対応実装は checkout に含まれる。#7 は後続 producer であり、Diagnosis 実行を本 Issue に取り込まない。

対象は Research → Clarification stage/mode → Architecture の typed routing と normal-driver 接続。Development Method/TDD (#16)、root skill/UI/document-write bridge (#8)、generated-workflow consent (#11)、Plan Simplicity (#14) は実装しない。Generic Context Routing、独立 architect、third-party API/依存の追加・変更もない。

## Runtime contract

- `createWorkflow()` は未解決の `stageDecisionRefs: {}` を保存する。`PlaybookContext` / `resolvePlaybookPolicy()` は互換用に残るが、hint を無視し、conditional を開始時に解決しない。
- Research / Clarification は全 playbook で conditional。Architecture は new-project required、feature/bugfix conditional、hotfix/chore skip。両 Human Gates は常に required。
- Scout 保存後に Research を決定。RUN の場合は既存の `pi-ketch.researcher` / Agent Launch Policy runner の durable completion を待ち、その evidence を次の決定へ渡す。
- Clarification stage が SKIP なら mode も deterministic SKIP。RUN のときだけ mode classifier を呼び、GRILL_ME / GRILL_WITH_DOCS / ESCALATE を適用する。mode の SKIP が stage RUN と矛盾する場合は ESCALATE。二つの family は stage 要否と実行 mode という別責務で、重複した Context Routing family は追加しない。
- `required -> RUN` / `skip -> SKIP` には classifier を呼ばない。conditional/mode の low confidence は ESCALATE、invalid response は integration block。後続 child / Human request / Planner を開始しない。
- Architecture RUN は Planner の Architecture / Design section を必須にする。別 Agent を dispatch しない。
- Mode は `ClarificationPort` に渡す evidence のみ。文書 path grant、write intent、implementation authority を作らない。既存の coding Round Decision からの再 clarification は deterministic GRILL_ME とし、以前の SKIP mode ref をその根拠に偽装しない。

## Evidence / persistence / freshness

`src/core/decisions/planning-routing.ts` が typed stage/mode decision と strict artifact schema、`src/runtime/orchestrator/planning-routing.ts` が evidence assembly / deterministic policy / persistence を所有する。既存 Pi native `DecisionClassifierPort`、`JevAuthorization`、ArtifactStore、CAS StateStore、child runner を再利用する。

| Decision | Accumulated inputs |
| --- | --- |
| Research | Task、Scout、Diagnosis when applicable |
| Clarification stage | 上記 + Research decision + RUN 時の Research output |
| Clarification mode | 上記 + exact Clarification stage decision |
| Architecture | 上記 + mode decision + durable Human answer when present/required |

Artifact は `conditional-stage` / `clarification-mode`。workflow、stage/policy、schema/policy version、exact refs/hash、input/policy/config digest、classifier provider/model（deterministic は null）、raw value/confidence、effective outcome、exact reservation/usage refs を保存する。Native usage artifact に probabilities を保持する。Pre-plan authority は `approvedPlanRef: null` / `planVersion: null` と明示し、approval を捏造しない。

Hash-validated body を1 artifact 12,000 characters、合計48,000 charactersまで渡す。上限を超える constraint を黙って切り捨てず operator attention にする。各 stage の frontier は自身の output を含まないため、後続 artifact の追加だけでは先行 decision を stale にしない。

順序は既存の reservation → CAS State → native classify → usage persistence → immutable decision → STAGE_RESOLVED / CLARIFICATION_MODE_RESOLVED → CAS State → next effect。保存失敗後に次の child/Human Gate を開始しない。

Resume は State-bound decision が fresh なら classifier capability がなくても再利用する。Task/Scout/Diagnosis/Human answer、project root、classifier、threshold/config、policy、decision body が変わると block。Stale evidence の自動 relabel/reclassification はしない。新しい confirmed answer / Plan feedback / explicit replan は Architecture decision を明示 invalidation してから再 Planning。History は immutable のまま残る。

旧 boolean flags は parser 向け derived projection に限定し、decision の代わりに使わない。Legacy State の missing routing ledger や orphan file existence を fresh authority と推定しない。既存の exact child launch/receipt recovery と Worker redispatch barrier は維持する。

Decision Artifact 保存後に State 保存が失敗した場合、orphan Artifact は authority ではない。Directory scan による昇格はしない。既存の request reservation は消費済みとして残る。

## Diagnosis / production boundary

`diagnosis` Artifact kind / context ref / Planner input と全 routing frontier の入力対応を追加した。bugfix/hotfix で ref がない場合は Scout 後に operator attention で停止する。Missing #7 producer を成功/SKIP と扱わない。Tests は明示的な durable Diagnosis fixture を使い、実 Diagnosis 実行済みとは主張しない。

Root grilling / domain-modeling / ask_user_question、shared-understanding confirmation、exact document-write grant/evidence は #8。選択した mode の保存だけではその production path を実装したことにならない。Generated workflow ID 用 consent capture は #11 のままで、現状の command は exact consent がなければ最初の conditional request 前に停止する。

Research は既存 released pi-subagents launch boundary のみを利用する。Operator が正規配布元を **https://github.com/minorunakamura/pi-ketch（GitHub-only、npm 配布なし）** と明示したため、npm publication / 新規 tag を完了条件にしない。commit `e49fd9ea48b675eef2ede729c9f13f7e12d44c20` を固定して実 integration を検証した。以前の「compatible publication/source が未解決」という記述は、この source 確認と下記 smoke により解消した。[Dependency Contract Review C25 の更新](./dependency-contract-review.md#6-subsequent-6--ketch-source--c25-resolved) を参照。

## Acceptance coverage

| #6 acceptance criterion | Executable coverage |
| --- | --- |
| Scout 後の durable conditional decisions | normal driver の ordered trace、各 classifier call 前の Scout/State/reservation 確認 |
| Bugfix/Hotfix Diagnosis input | 全 stage ref と Planner input の Diagnosis 検証、欠落時 zero classifier/Planner |
| Jev が required/skip を override しない | matrix/policy tests、new/chore/hotfix の Architecture zero classifier、Human Gate stage の adapter 拒否 |
| GRILL_ME / GRILL_WITH_DOCS | 両 mode の immutable evidence、genuine Human wait、confirmed answer 後の自動 continuation |
| Mode は write/implementation authority ではない | root に新規文書なし、approval/implementation ref なし、Human Plan Gate までで停止 |
| Resume fresh reuse / stale rejection | client 不在でも fresh reuse、changed refs/config/classifier/confirmed answer/corrupt body を block |
| Low confidence は conservative path | stage/mode ESCALATE、contradictory mode SKIP の拒否、resume 時も zero reclassification |
| Jev は Human-facing questions を生成しない | closed Choice-only port/response、root-supplied prompt のみを Human port に渡す |

主な tests: `tests/runtime/orchestrator/planning-routing.test.ts`、`tests/core/playbooks.test.ts`、`tests/core/domain-schemas.test.ts`、`tests/runtime/integrations/jev.test.ts`。既存 planning/recovery/command/coding fixtures は開始時 hint ではなく明示 scripted classifier と exact workflow consent を使うよう更新した。

## Validation

- Focused stage / core / adapter / command tests: **PASS — 5 files / 77 tests**。
- Routing 実装時 `VITEST_MAX_WORKERS=2 pnpm check`: **PASS — typecheck / lint / format / 48 files, 648 tests**（223.71 seconds）。
- Research integration focused tests: **PASS — 4 files / 79 tests**。
- Research integration 後の final `VITEST_MAX_WORKERS=2 pnpm check`: **PASS — typecheck / lint / format / 49 files, 652 tests**（217.41 seconds）。
- `git diff --check`: **PASS**。
- 更新文書の local Markdown links/anchors: **PASS — 48件**。

Real Pi / Research integration は下記で PASS。Classifier は scripted decision であり、今回の live Jev smoke や actual Human Gates PASS ではない。#8 / #11 の production capability、#12 の integrated production verification は別 Issue のまま。

GitHub Issue status / #13 checkbox / release evidence / CHANGELOG は変更しない。上記 runtime acceptance coverage は full v1 production readiness や他 Issue の未完了 prerequisite の解消を意味しない。

## Real Pi / Research integration

### Fixed source and minimal fix

- Source: `https://github.com/minorunakamura/pi-ketch`、revision **`e49fd9ea48b675eef2ede729c9f13f7e12d44c20`**。
- Installed origin/HEAD と GitHub commit を照合。Tracked files に差分なし。既存 untracked `package-lock.json` は触らず、smoke は `git archive` の clean snapshot を使った。
- 公開 manifest `pi.subagents.agents` → `agents/researcher.md` → `subagentOnlyExtensions: ../src/researcher-tools.ts` → 4 Ketch tools の登録を確認。
- 実定義は Ketch tools 専用、`inheritProjectContext:false` / `inheritGlobalContext:false` / `inheritSkills:false`。旧 Orchestrator policy は `read` 必須 / `inheritProjectContext:true` で、公開 preflight が拒否する不整合があった。
- `agentLaunchPolicy()` の Research branch のみを修正。Required/allowed tools は `ketch_search, ketch_scrape, ketch_docs, ketch_code`、project context 継承は false。Local repository tools / mutation / nested execution / Codemode / supervisor tool を追加しない。
- `tests/runtime/integrations/research-launch.test.ts` の public discovery/preflight regression は修正前 FAIL → 修正後 PASS。Missing required tool、context drift、extension ceiling denial は zero dispatch。

Pi の Git package source は固定 commit を指定できる。Deployment で今回の検証対象を選ぶ場合の source は `git:github.com/minorunakamura/pi-ketch@e49fd9ea48b675eef2ede729c9f13f7e12d44c20`。Operator の既存設定を自動で書き換えたり、新しい package を install したりしていない。

### Observed smoke

開始 **2026-10-02T17:49:37.548Z**、Research process terminal proof **2026-10-02T17:50:13.830Z**。

| Item | Result |
| --- | --- |
| Host / child owner / CLI | Pi **0.99.1** / pi-subagents **0.74.0** / ketch **0.12.0** |
| Herdr new tab / pane / Agent | `wF:t2B` / `wF:p2N` / `issue6-research` |
| Model / thinking | `openai/gpt-6-astra` / `medium`（live model。operator が費用の可能性を含め承認） |
| Source / tools | unmodified pinned Git snapshot、package agent discovery、上記4 Ketch tools、context/skills inheritance false |
| Normal continuation | actual Scout → scripted Research RUN → actual Research → scripted Clarification RUN / GRILL_ME → genuine Human wait |
| Real tool call | `ketch_scrape` **1回成功**、固定 commit の public README URL、`maxChars:4000, trim:false` |
| Durability / recovery | real launch/receipt digest 一致、immutable Research output と recreated adapter `status(runId, receipt)` の full output 一致 |
| Resume | fresh stage/mode decisions を再利用、Scout/Research 再 dispatch **0** |
| Authority | phase `clarifying`、Plan/approval/implementation ref なし、workspace README unchanged / extra files なし |
| Shutdown | Scout/Research の public `process-terminal.json` がともに observed / exit 0。確認後に作成した tab のみ close、temporary credential symlinks のみ削除 |

Research run ID: `0b43e1c4-4781-42eb-816f-4bb2884ab2c6`。Launch/receipt digest: `1a5c05c8abccd9d5edaa1f97a618ede29f8d3022428779fcda6f5220783706ff`。Research Artifact SHA-256: `0762e3a318711796389d0b894cb13f9e2dacf0ab702ed41a9e398d17e7bc7628`。

Raw report: `/tmp/issue6-research-final-smoke.json`（machine-local）。公開 lifecycle `events.jsonl` の tool_execution_start/end と non-error result を検証し、Agent の自己申告だけを根拠にしない。Output 末尾の「write tool がなく出力ファイルを書けなかった」という Agent prose は failure/authority として採用せず、runtime が保存した canonical full output と exact receipt を照合した。

最初の harness 実行では macOS `/var` と `/private/var` の path 比較、次に side-effect-free preflight probe の missing session binding が pre-dispatch で失敗した。Fixture を canonical realpath にし、probe に公開 dispatch/session binding を供給して修正。どちらも child/model call 前の失敗で、production policy を緩めて通したものではない。上記は修正後の actual child smoke の結果。

### Reproduction

`tests/platform/research-fixture.ts` は selected Git checkout の origin/HEAD/clean tracked source を検査して disposable archive/settings/workspace を作る。`tests/platform/research-smoke-extension.ts` は opt-in command。Operator の既存 auth file への temporary symlink を使い、credentials を report に保存しない。

```sh
# HERDR_ENV=1 の pane から。Git source は上記 commit の checkout を指定。
node --experimental-strip-types --input-type=module -e '
  import { researchFixture } from "./tests/platform/research-fixture.ts";
  console.log(JSON.stringify(await researchFixture(
    process.env.HOME + "/.pi/agent/git/github.com/minorunakamura/pi-ketch",
    process.env.HOME + "/.pi/agent/auth.json",
    "openai/gpt-6-astra:medium"
  ))));'

herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd <returned-cwd> \
  --label issue6-research --env PI_CODING_AGENT_DIR=<returned-agentDir> --no-focus
# returned pane の shell-ready を確認してから起動。repo path は absolute。
herdr agent start issue6-research --kind pi --pane <returned-paneId> -- \
  --no-approve --no-session --no-extensions --no-skills --no-prompt-templates \
  --no-context-files --no-tools \
  -e <repo>/node_modules/pi-subagents \
  -e <repo>/tests/platform/research-smoke-extension.ts \
  --model openai/gpt-6-astra:medium
herdr agent prompt issue6-research '/research-smoke /tmp/issue6-research-final-smoke.json'
# report.status:passed と exact process-terminal proof を確認後、作成した tab のみ close。
herdr tab close <returned-tabId>
# 終了後、returned-agentDir/auth.json の symlink のみ削除。リンク先は削除しない。
```

Jev は test-only scripted classifier（3 durable reservations、network classifier calls 0）。Full lifecycle、root Human interaction/document writes、actual Human Gates、全 Ketch search/docs/code backend credentials、任意の新しい Git revision の互換性はこの smoke の範囲外。Third-party package の patch/private API/new npm dependency はない。
