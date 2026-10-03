# Development Method / TDD implementation (#16)

## Scope / preparation

Issue #16 の本文・10 acceptance criteria（commentsなし）、tracking #13の本文・comments、AGENTS.md、Planning / Coding / decision / artifact / persistence / launch契約を確認した。前提 #3 / #18 / #21 / #19 / #4 / #6 / #7 / #8 / #11 はCLOSED。推奨順序の次は #16。

既存の `PlanningRouting`、native classifier method port、immutable Artifact / State CAS、exact Plan Gate、builtin Worker Launch Policy / public pi-subagents preflightを再利用した。新しいphase、workflow script、classifier transport、runtime dependency、第三者package/skillの変更・fork・private APIは追加していない。

Parserの既存 `Implementation Plan` を保持する。Lightweight strategy sections / Plan Simplicity readinessは #14、material deviationの停止・再計画本体は #15、full production verificationは #12。Release evidence / CHANGELOG / GitHub Issue status / tracking checkboxesは変更しない。

## Captured intent / deterministic policy

```text
/wf-feature --tdd <task>           # 全start commandsで利用可
/wf-chore --behavior-free <task>   # 明示的なbehavior-free scope
```

APIは `StartWorkflowInput.developmentIntent: AUTO | TDD | BEHAVIOR_FREE`。未指定の新規workflowはAUTO。Task内の独立した `Development Method: TDD` 宣言もcaptureし、BEHAVIOR_FREE指定よりTDDを優先する。State初回保存はcapture済みintentとTask refを含み、child/classifierより前に完了する。

1. Captured explicit TDD → deterministic TDD / classifier method calls 0。
2. Explicit behavior-free scope、TDD宣言なし → deterministic STANDARD / method calls 0。
3. AUTO → eligible/ambiguous evidenceからbounded native STANDARD / TDD / ESCALATE。
4. Low confidence / ESCALATE → decisionをdurableに残しoperator attention。Human answer / approvalを捏造しない。

Free-form proseの意味をregex/classifierでHuman choiceと推定する機能は追加していない。明示的なintentは上記flag/API/declarationでcaptureする。Choreというplaybook名だけからbehavior-freeとは推定しない。Missing legacy intentはAUTOにmigrationせずfail closed。

## Routing / persistence / freshness

Scout / required Diagnosis / Research / confirmed clarification・authorized documents / Architectureのexact evidence frontierを検証した後、Plannerより前にmethodを解決する。Development Methodはstrategy attributeであり、新しいlong-running Stage / WorkflowPhaseではない。

```text
exact refs/hashes + captured intent + bounded evidence/policy
 -> grant/consent validation
 -> immutable reservation -> CAS accounting -> native method call (when conditional)
 -> immutable development-method Artifact -> DEVELOPMENT_METHOD_RESOLVED.methodRef -> CAS State
 -> Planner
```

Artifactは既存decision headerを使う `family: method` / `stage: development-method`。Workflow/playbook、absent Plan authority、exact input refs/input digest、policy/configuration digest、called classifier identity、raw decision/confidence/effective outcomeとreservation/usage refsをbindする。Native usage Artifactがprobabilitiesを保存する。

Inputは既存limits（artifact 12000 chars / total 48000 chars）を使い、decision-critical constraintsをtruncateしない。既存finite consent budget / deadline / explicit reserved retriesを適用し、hidden retry / evaluator fallback / budget refundはない。

Fresh reuseは現在のinput/policy/configuration/classifierとactive consent/accountingを再検証し、新しいrequestやbindingを作らない。Fresh decisionはclient再作成・classifier capabilityなしでもreuse可能。Stale/missing/corrupt method、legacy intent、revoked grantは新しいmethodを黙って選び直さず停止する。

Clarification completion / Plan feedback / replanはArchitectureとmethod refを明示invalidateする。新しいcandidate Plan / mandatory Human Gateを経るまでimplementation authorityはない。Oracle adviceはexact-State freshnessを維持し、相談後にmethod frontierが変わればstaleのまま（freshとrelabelしない）。

## Plan / Human approval

全Planに `Development Method` section（exact STANDARDまたはTDD）を要求し、durable decisionとの不一致を拒否する。TDDではnonempty explicit `Test Seams`が必須。Missing/empty/none/N/A/TBD seams、duplicate sections、不正method / Supporting Skillsはpublication / Human Gateより前に拒否する。

```markdown
## Development Method
TDD
## Test Seams
- UserService public behavior: observable outcome, controllable dependency boundary and regression assertion.
## Do not test
- private helpers / internal collaborator calls
## Supporting Skills
codebase-design
```

`Supporting Skills`はoptionalで、TDDのseam/interface shapeに必要な場合だけcodebase-designを選ぶ。Omitted / noneなら追加しない。任意のskill名やSTANDARDへのTDD注入は許可しない。

Human Plan Gateへは既存public `plan-review`にfull Plan contentを渡す。Exact immutable Plan ref/version/hashにmethod・Test Seams・supporting selection・Validation Contractが含まれ、保存済みHuman approvalはその全体へbindする。Open/reconcile/apply時にcurrent Plan / method authorityを検証する。Notification、Agent prose、method choiceだけではapprovalにならない。

## Worker / implementation evidence / resume

Worker inputはambient hintsではなくexact approved Planからmethod / seams / supporting skillsを抽出する。Method Artifact refもdurable attempt inputRefsに含める。

- TDD → public launch `skill: ["tdd"]`、必要時のみcodebase-designを追加。
- STANDARD → explicit empty skill selection。
- Builtin identity / `inheritSkills:false` / exact required skillsをreleased pi-subagents **0.74.0** preflightで検証し、missingまたはextra resolved skillsはdispatch前に拒否。
- Upstream skillをreadし、confirmed public seamsだけをtestする。One failing test → observed RED → minimal implementation → observed GREEN → next vertical sliceを指示し、horizontal bulk testingを禁止。
- 各sliceのseam/test/RED・GREEN commands/resultsをWorker reportに要求し、既存immutable Implementation Artifactのfull outputとして保存する。Skill/instructions/reportはevidenceであり、deterministic Validationのpass authorityではない。
- Approved Validation Contractは変更せず、Implementation completionの次は必ずvalidating。TDDのGREENやWorkerの主張でValidationを省略しない。

Resume / next Fixではhistorical method ref、exact Plan/seams、selected skills、launch/receiptを検証し、supported public preflightを再構成してskill bytes / model / tools / Agent definition / full launch driftを拒否する。Current capability driftはoperator-attention blockであり、保存済みのvalid historical implementationをcorruptとしてterminal failにしない。Unresolved/maybe-mutating Workerは既存reconciliation barrierを維持し、blind redispatchしない。Method/seam変更には新しいPlanとHuman approvalが必要。

## Acceptance criteria coverage

| #16 criterion | Executable evidence |
| --- | --- |
| Explicit Human TDD is deterministic | command/API/declaration capture、TDD precedence、zero method calls |
| Inapplicable work is not forced to TDD | behavior-free STANDARD precedence、STANDARD explicit empty skills |
| Ambiguous routing is bounded/persisted | native choice / reservation before call / probabilities / limits / low-confidence ESCALATE / save-fault tests |
| Missing TDD Test Seams blocks Human Gate | parser / candidate publication / zero Gate calls |
| Approval binds exact method/seams | immutable full Plan hash/version / review-result binding / changed-seam rejection / actual Human review |
| Explicit released Worker skills | public preflight positive/negative/missing/skill-byte drift、actual builtin child reads tdd + codebase-design |
| No third-party patch/fork/private API | existing released RPC/preflight/ceiling / public skill parameter only; package/lockfile unchanged |
| Vertical red/green rather than bulk tests | Worker instructions / full report、actual public calls + exit codes + test/source mutation order |
| TDD does not replace Validation | unchanged parsed contract / required executor call、real post-Worker deterministic Validation |
| Resume preserves method/approved seams | exact current/historical evidence checks、stale intent/ref/config/skill rejection、zero method rerouting/duplicate Worker |

## Validation

- Focused routing / Worker strategy / Oracle frontier / coding E2E: **4 files / 123 tests PASS**。
- Additional focused core schema / commands / Worker strategy / transcript audit: **4 files / 32 tests PASS**。
- Completed-Worker / current skill-drift / recovery fault focused run: **3 files / 54 tests PASS**。
- Final `VITEST_MAX_WORKERS=2 pnpm check`: **PASS — typecheck / lint（warningsなし）/ format / 55 files / 753 tests**。Current skill-drift block補強後に全suiteを再実行した結果。
- `git diff --check`: **PASS**。Changed Markdown local links / anchors: **61件 PASS**。Final `pnpm format:check`: **PASS**。

Initial all-suite run failed on an obsolete request ordinal and an Oracle fixture whose new method resolution legitimately invalidated exact-State advice. Updated those fixtures without weakening assertions/freshness. Initial focused failure on a behavior-free fixture producing a contradictory TDD Plan was corrected in the fixture, not by allowing the reversed Plan.

## Real Pi / actual Human Plan Gate / TDD Worker

**PASS** — Pi **0.99.1**, pi-subagents **0.74.0**, Plannotator **0.27.16**, actual builtin Worker **openai/gpt-6.1-sol**, thinking **medium**。New Herdr tab / pane / Agent: **wF:t2P / wF:p20 / issue16-tdd-final**。Start **2026-10-03T09:40:40.531Z**、completed historical audit/Validation **2026-10-03T09:49:23.514Z**。

Actual HumanがPlannotator browserでexact TDD / two public greet(name) cases / supporting skill / Validation Contractを承認した。その保存前のWorker dispatchは0。Disposable Git fixtureのgreeting.mjs / greeting.test.mjsだけを変更し、product repository / operator settings / third-party skillsは変更していない。Upstream skill checkoutはclean **3cca18b368ae95cdbdebbff572ccafa662551015**をexplicit pathsで選択した。

- Actual Worker spawn **1**、builtin / exact selected skills / inheritance isolation / launch intent→State→receiptの順序を確認。
- Childがactual tdd / codebase-design SKILL.mdをread。
- Public tool arguments / structured exit codes / mutationsで `TEST → RED(1) → SOURCE → GREEN(0) → TEST → RED(1) → SOURCE → GREEN(0)`を検証。Worker自身の追加final checkもGREEN。
- Full immutable implementation report / exact receipt / recreated adapter public full-output recovery一致。
- Orchestrator ValidationRunnerがapproved `node --test greeting.test.mjs`を別途実行しPASS。Phaseはreviewingで停止し、Code approval / workflow completedは主張しない。
- Run ID **e847e86b-9ed8-4d8a-a20c-9911ecd16052**、launch digest **163768642a7e6ebe20d6ae2e32ee11937cb8ebb80647f7dabdcd7705040af450**。Public runner terminal proof **observed / exit 0**。
- Report: `/tmp/issue16-tdd-final-smoke.json`（machine-local）。Historical auditのWorker redispatchは **0**。Public terminal proofを確認後、作成したtabとtemporary auth symlinkのみcleanup済み。

最初の別fixture（wF:t2N / wF:p2Z）はscripted Execution Routing応答の未設定でHuman approval後に停止した。Worker dispatch 0 / source unchangedを確認してから、新しいworkspace/tabで修正済みfixtureを実行した。これをPASSには含めない。

Final childの実行後、最初のsmoke集計はNodeのTAP textを仮定して失敗した。Actual childはすでに2 vertical slicesを完了していたため再実行せず、public structured exit codesによるreporter-independent auditへ修正した。同じdurable resultをauditし、残りのdeterministic Validationのみを実行してPASS。FailureはreportのpreviousFailureと本記録に保持し、Workerをblind retryしていない。

**Scout / Planner / stage classifiers / execution routingはscripted fixture evidence（live classify 0）**。Actual Human Plan Gateとactual Worker/skills/test commands/Validation/recoveryのfocused proofであり、actual Code Gate / live Jev / full v1 lifecycle / simplicity / deviation / release PASSではない。

### Reproduction

`tests/platform/tdd-fixture.ts`のtddFixture(authFile, cleanSkillsCheckout, repository)でisolated settings、explicit upstream paths、temporary auth symlink、disposable Git workspaceを作る。Operator settings/auth/skillsを変更しない。

```sh
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd <fixture-cwd> \
  --label issue16-tdd --env PI_CODING_AGENT_DIR=<fixture-agentDir> --no-focus
herdr agent start issue16-tdd --kind pi --pane <returned-pane-id> -- \
  --no-approve --no-extensions --no-skills --no-prompt-templates \
  --no-context-files --no-tools -e <repo>/node_modules/pi-subagents \
  -e <installed-plannotator-package> -e <repo>/tests/platform/tdd-smoke-extension.ts \
  --model openai/gpt-6.1-sol --thinking medium
herdr agent prompt issue16-tdd '/tdd-smoke /tmp/issue16-tdd-smoke.json'
# Actual Human approves exact Plan/Test Seams in the browser; no proxy answer.
# Check report / exact artifacts / public terminal proof before closing the created tab.
```

A post-Worker audit interruption permits `/tdd-smoke-audit <same-report-path>` only when State is validating and a completed exact attempt / durable Human approval exist。This command has no Worker launch/relaunch API。Never resend `/tdd-smoke` against a possibly mutated fixture to hide a failure。

## Completion boundary / limitations

Intent capture uses explicit controls, not arbitrary prose interpretation。Clearly behavior-free scope is explicitly declared rather than guessed from playbook。Legacy missing intent/evidence is not auto-migrated。Seams are Human-reviewable textual strategy, not a semantic proof that every test is public。Skill selection/instructions and saved reports do not form an OS sandbox or a universal mechanical TDD verifier。

#14 owns lightweight strategy sections / Plan Simplicity readiness、#15 owns material deviation本体、#5 owns general Main/workspace ownership、#20 owns read-only Codemode、#9/#10 own synchronous Code / non-Git、#12 owns integrated production verification。These are existing pending Issues, not new #16 residual work or permission to bypass mandatory Human Gates。
