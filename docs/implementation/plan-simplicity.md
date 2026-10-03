# Lightweight Plan / Plan Simplicity Review (#14)

## Preparation / scope

Issue #14（本文・11 acceptance criteria、commentsなし）、tracking #13（本文・全comments）、AGENTS.md、canonical Basic Design / Artifact / State Machine / Planning / Domain / Plannotator / Persistence / Test Strategy と現行 implementation を確認した。前提 #3 / #18 / #19 / #21 / #4 / #6 / #7 / #8 / #11 / #16 は CLOSED。推奨順序の次は #14。

既存 `PlanningRouting`、`runPlanningAgent`、normal driver、immutable Artifact、CAS、public Launch Policy / pi-subagents 0.74.0 single-agent RPC / preflight / exact receipt recovery と public Plannotator async Plan API を再利用する。新たな dependency、workflow script、third-party patch/fork/private API はない。#15 material deviation、#20 Codemode、#9 Code Gate correction、#10 non-Git implementation evidence、#5 general Main ownership、#12 full production verification は追加しない。

## Strategy contract

Planner/parser は `Implementation Plan` を必須 recipe として扱わず、次の logical sections を要求する。

- Scope / Requirements
- Architecture / Design（durable Architecture RUN の場合）
- Implementation Approach
- Expected Change Surface
- New Components / New Dependencies（ない場合は explicit none、TBD/N/A等で代替しない）
- Non-goals
- Development Method（durable STANDARD / TDD と一致）
- Test Seams（TDD の場合、従来の explicit seam validation を保持）
- Validation Contract（既存 machine-readable deterministic command checks）

詳細な編集手順は不要。Optional `Do not test` / `Supporting Skills` と exact method / seams / Validation authority は保持する。Coding の bounded Plan summary も strategy sections を消費する。Parser の旧 recipe-only Plan / legacy cycle を自動 upgrade しない。

## Candidate → review → one-shot refinement → mandatory Human Gate

```text
Planner → deterministic validation → immutable plans/plan-vN.md
 → PLAN_CREATED → State (planning / candidateCycleId)
 → read-only plan-simplicity-reviewer intent/launch → State → dispatch
 → immutable plan-reviews/simplicity-vN.json
 → PLAN_SIMPLICITY_REVIEWED → State
 → findings があり budget=0 の場合:
     PLAN_REFINEMENT_REQUESTED → State (automaticRefinementsUsed=1)
     → Planner → new immutable version → fresh review
 → PLAN_REVIEW_READY → State (awaiting-plan-review)
 → Plan open intent → State → public Plannotator plan-review
 → exact reviewId/Plan/version/simplicity binding → State → genuine Human wait
```

`cycleId` / `candidateCycleId` / `automaticRefinementsUsed: 0|1` / `refinementReviewRef` は durable substate。Candidate publication は同じ cycle の cap を reset しない。Human feedback / explicit replan / clarification completion は新しい cycle と新しい Plan を必要とする。Missing legacy cycle/budget/readiness は permission として扱わない。

Review は exact workflow/cycle/Plan ref・version・hash、accumulated input refs、request digest、launch digest、run identity に bind する。Artifact body と current inputs/State、historical attempt/receipt、current public preflight の一致を確認する。Plan 変更時に旧 simplicity を clear し、current Plan と不一致の証拠を relabel しない。

## Evidence-only findings / Human presentation

`agents/plan-simplicity-reviewer.md` は `read/grep/find/ls` のみ、fresh context、explicit empty skills、`inheritSkills:false`、`denyExtensions:true`。編集、command、child、Codemode、State/Artifact write、approval / implementation / Fix authority はない。Post-code Ponytail Reviewer は actual implementation を評価する別 role のまま。

Findings は unique ID、category、summary、exact Plan section、repository citations、narrower alternative を要求する。Categories は unnecessary-abstraction / speculative-flexibility / avoidable-dependency / ignored-pattern / broad-change-surface / duplicated-responsibility。Citations は exact supplied Scout/Diagnosis Artifact refs と repository locations、verbatim excerpts を bindし、current durable body に excerpt/location がない finding は拒否する。Taste-only findings、fabricated/cross-ref evidence、absent sections、duplicate IDs、不正 schema を拒否する。

Evidence は各 input 64000 chars / total 128000 chars、report 64000 chars、20 findings / findingごと8 citations に bounded。限界超過は黙って truncate せず停止する。Architecture は decision evidence と candidate に embedded した design を入力にし、独立 architect/Artifact を追加しない。

Refinement 後に残る全 findings と budget disposition を Human に提示する。Public payload は `{planContent}` のみで、exact immutable Plan body に distinct evidence-only review section を付加する。未解決 finding の本文・全 citations/alternatives は literal JSON fence 内に表示し、Markdown/HTML injection により findings を隠さない。表示用 annotation は approved Plan Artifact を変更しない。

Plan Gate binding/open intent/settled result は exact simplicity ref を含む。Human approval は full immutable Plan（method/seams/Validation を含む）にのみ bindし、simplicity clean / refinement success / confidence / Agent completion は approval にならない。

## Recovery / faults

- Durable candidate/review はそのまま reuseし、completed valid reviewer の status query / redispatch をしない。
- Output-before-State failure は matching historical request/receipt/launch と public full output のみを recoverし、同じ immutable Artifact を idempotently republishする。Artifact existenceだけで成功を推測しない。
- Running exact child は genuine wait。Receipt loss、launch/input drift、ambiguous completion は別 child を起動しない。
- Cap は refinement dispatch前に保存する。Restart後の refined candidate/version increment は cap=1 を維持する。
- Reconciler は未起動 simplicity を開始せず、candidate復元後は同じ normal driver が継続する。Review-ready State保存後・open intent前の中断は safe first open。Persisted open intent/identity があるのに binding がない場合は possible orphan として blockし、reopen/approvalを推測しない。
- Candidate/refinement-budget/open-intent State save failure は次の child/Gate calls 0。Simplicity Artifact/State save failure は Human Gate/implementation authority を付与しない。

## Acceptance coverage

| #14 acceptance criterion | Executable coverage |
| --- | --- |
| Human Plan Gate required | new readiness guards、Gate pending / zero approval、全 coding E2E に both Gates |
| Strategy/boundary-oriented Plan | parser / Planner role、required strategy sections、steps不要、coding summaries |
| Candidate vs review-ready durable State | PLAN_CREATED stays planning、exact simplicity readiness Event / invariants |
| Simplicity before Human Gate | candidate/attempt/review/readiness/open persistence barriers、normal driver、actual smoke |
| Concrete repository evidence | typed citation schema、exact ref/location/excerpt、fabricated/missing/absent-section rejection |
| Automatic refinement ≤1 | durable cap-before-dispatch、restart/version preservation、residual finding case |
| Unresolved findings never hidden | actual public payload test、literal presentation injection test、no second refinement |
| Hash/version-bound / changed Plan stale | exact metadata/input/preflight validation、Plan/review hash tampering、new candidate clears review |
| Human feedback → fresh review | cycle reset、new immutable version and review、existing Plan feedback E2E |
| Resume does not blindly rerun valid work | output-before-State recovery、completed review reuse、running/lost receipt、zero redispatch smoke |
| Advice cannot approve / implement | read-only Launch Policy、authority Events/Gates、absence of approval/implementation refs |

## Validation

- Final `VITEST_MAX_WORKERS=2 pnpm check`: **PASS — typecheck / lint（warningsなし）/ format / 57 files / 780 tests**。
- Final focused simplicity / resume / Plan parser / package validation: **4 files / 44 tests PASS**（recovery-only regression を含む）。
- `git diff --check`: PASS。変更 Markdown の local paths / anchors：**57件 PASS**。
- Real smoke の Plan/input Artifact hashes、raw full reviewer output と immutable finding evidence の一致、public runtime tool-call audit：PASS。Actual child tool callsは0（durable bodiesが直接 supplied contextに含まれる）、effective callable ceiling は read-only。
- 初回全-suite invocationは300-second windowでtimeoutし、PASSに含めない。後続checkは既存fixture 2件の obsolete Agent catalog / absent-open-intent orphan premiseで失敗。必須reviewを省略するのではなくfixtureを更新し、900-second windowのfinal checkで全件PASS。Test timeouts/assertionsを緩和していない。

これは focused implementation evidence であり、full v1 production / release PASSではない。

## Real Pi / Herdr focused smoke

**PASS** — Pi **0.99.1** / pi-subagents **0.74.0** / installed Plannotator **0.27.16** / actual **openai/gpt-6.1-sol**, thinking **medium**。New Herdr tab / pane / Agent: **wF:t2R / wF:p32 / issue14-simplicity-final**。Start **2026-10-03T15:54:01.325Z**、finish **2026-10-03T15:54:56.271Z**。

- Actual read-only simplicity reviewer → evidence-backed unnecessary interface/class/routing finding。
- Durable cap=1 → actual Planner refinement → new Plan v2 → actual fresh reviewer / clean report。
- Actual public Plannotator Plan UI opens once with full exact Plan + simplicity annotation; pending Human Gate。No Human approval is inferred or supplied by an Agent。
- Exact fresh review/body/input/launch/receipt、adapter recreation/public output recovery、normal resume の zero redispatch / zero reopen。
- Three actual children の public process-terminal proof: observed / all exit 0。Effective tools は find/grep/ls/read、skills=[]。Disposable greeting.mjs bytes/file list unchanged、approval/implementation refsなし。
- Machine-local report: `/tmp/issue14-simplicity-final-smoke.json`。Exact output/hash/terminal audit後、作成した2 tabs と temporary auth symlinks のみcleanup済み。tmux / direct Pi spawn / Human代理回答なし。

**Scout / original candidate / stage classifiers は scripted fixture evidence（live classifier calls 0）**。Actual Human approval / Worker / Code Gate / full v1 lifecycle / release PASS は主張しない。Residual-findings presentation は public-contract tests で確認し、この actual final review は clean。最初の別 fixture は candidate Validation JSON escaping の誤りで pre-review停止（actual spawns 0）。それをPASSとせず、JSON.stringifyでfixtureを修正して新しいworkspace/Herdr tabで実行した。Mutation後のblind retryはない。

### Reproduction

`tests/platform/simplicity-fixture.ts` の `simplicityFixture(authFile, repository)` で disposable workspace / isolated settings / temporary auth symlink を用意する。

```sh
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd <fixture-cwd> \
  --label issue14-simplicity --env PI_CODING_AGENT_DIR=<fixture-agentDir> --no-focus
herdr agent start issue14-simplicity --kind pi --pane <returned-pane-id> -- \
  --no-approve --no-extensions --no-skills --no-prompt-templates \
  --no-context-files --no-tools -e <repo>/node_modules/pi-subagents \
  -e <installed-plannotator-package> -e <repo>/tests/platform/simplicity-smoke-extension.ts \
  --model openai/gpt-6.1-sol --thinking medium
herdr agent prompt issue14-simplicity '/simplicity-smoke /tmp/issue14-simplicity-smoke.json'
# Read report/artifacts/public terminal proofs before closing the created tab.
# Plan UI stays pending; do not proxy Human approval or start a Worker.
```

## Limitations / next Issues

Citation provenance is mechanically validated; it is not a universal semantic proof that each concern is correct. Tool ceiling is not an OS sandbox. Review evidence cites durable Scout/Diagnosis repository facts rather than promoting arbitrary live file reads to authority. Oversized evidence and legacy cycle/binding require explicit reconciliation rather than auto-migration. Automatic refinement is mandatory once for valid first-review findings, never a multi-agent loop.

Existing #15 / #20 / #9 / #10 / #5 / #12 remain pending. Release evidence / CHANGELOG、GitHub Issue state / #13 checkboxes は変更しない。
