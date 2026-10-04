# Issue #5 — Active workflow ownership / Main mutation boundary

## Preparation / scope

Issue #5 の本文・全acceptance criteria（commentsなし）とtracking #13 の本文・comments・recommended orderを確認した。Prerequisite #3 / #18 / #19 / #21 / #4 / #6 / #7 / #8 / #11 / #16 / #14 / #17 / #15 / #20 / #9 / #10 はCLOSED。AGENTS.md、canonical Basic Design / runtime / domain / persistence / integrations・test契約、現行commands / driver / clarification / Worker / workspace観測を確認してから実装した。

State / lifecycle / Artifact / policy / Human Gates のauthorityはOrchestratorに残す。WorkerはHuman Plan approval後の唯一のautomated implementation executor。Classifier / Oracle / read-only children / Main / document exceptionへauthorityを移さない。Third-party modification/private API/new dependency/workflow-script lifecycleは追加しない。#12の統合production verification、#13のcompletion checklist、release evidence / CHANGELOGは完了扱いにしない。

## Implementation

- Production `src/index.ts` がpublic host hooks (`session_start`, `before_agent_start`, `tool_call`, `user_bash`) とowned clarification bridgeを接続する。毎callでcurrent/ancestor workspaceのdurable active Stateを読み、別session・reload・nested cwdでもownerを隠さない。Corrupt/unsafe/unobservable dataはexecution permissionにならない。
- Workspace-wide existing `WorkflowLock` → single-owner確認 → task/initial State → immutable reconciliation-kind `ownershipRef` → CAS State → normal driver。Identityはcanonical root / exact root session / workflow / Gitまたはfilesystem観測。Public `pi.appendEntry()` / SessionManager historyにもdeny-only breadcrumbをState binding前に保存する。Known workflowのState/runtime-directory消失はowner解放ではなくunsupportedで、reload/branch navigation後もnew start/raw writeを拒否する。Breadcrumbはpermission/approvalを与えず、current State/Artifactsがauthorityのまま。Blockedはownershipを保持する。Terminal completed/failedのみ通常のowner解放対象。Nested Git rootで独立ownerを作らない。
- Active ownership中のMainはraw toolsをすべて拒否する。Tool annotations・project trust・CONTEXT path指定でも例外にならない。Raw readも許可せず、Human chat / status / supplied evidenceでの説明を保持する。Missing factsはOrchestrator-owned evidence待ちであり、raw shell/child investigationを推定許可しない。
- Clarifyingの例外はowned `wf_clarification_round` / `wf_clarification_complete` のみ。Later hookによるinput変更をpermissionにせず、owned executeで実際のworkflow/request/session/skills/workspace/path/contentを再検証する。GRILL_MEのdocsは拒否。GRILL_WITH_DOCSは既存の実Human final confirmation / durable question-answer / document before-intent-afterを再利用する。
- Normal driverの各action前、resume/reconciliation entry、Oracle request、Worker baseline直前にownershipとcurrent workspaceを検証する。Unexpected mutationは新しいbaselineにせずimmutable `ownership-denied-*` evidence → block。Standalone command runtimeにinstalled host boundaryがなければexternal dispatch前にblockする。
- `workspaceCheckpointRef` はexact succeeded/deviated Workerのowned-before / observed-after、またはcompleted document intent/result/answer/clarification/full-workspace/scopeからだけ更新する。Initial ownerは変更しない。Owned docsで正当に変わったworkspaceは次Workerのチェックにも使えるが、approval/routing/Worker launchの検証は省略しない。Unresolved mutationはexisting exact historical reconcilerに渡し、Workerをblind retryしない。

## Document scope / persistence

Canonical candidatesはroot `CONTEXT.md` / `CONTEXT-MAP.md`、nested `CONTEXT.md`、root/nested `docs/adr/*.md` のcreate/updateのみ。Case-sensitive exact POSIX relative path。Absolute/backslash/control bytes、非normalized path、`.`/`..`/`.git`/`.pi`/`node_modules` component、nested CONTEXT-MAP、ADR subdirectory placement、symlink parent/target、hardlink/非regular targetを拒否する。Public root toolsのpath checkをpermissionにせず、owned writerでeffective inputを検証する。

Exact Human answer State → document intent（before full content/absence/hash・request/source revision/answer・full workspace before・exact target filesだけを除外したscope before）→ State → `O_NOFOLLOW` / exclusive create / before bytes再確認 / fsync → full workspace/scope after・result → State → clarification completion → accepted checkpoint。Parentディレクトリ全体を除外しない。Filesystemで許容するnew directory entriesはexact targetのancestorのみで、他のcontents/modesは同一を要求する。新規design docsのmodeはworkspace providerが観測できる0644（existing filesのmodeは変更しない）。Workspace/scope本体は別のreconciliation Artifactsに保存し、document intent/resultにはhash-bound refsだけを含める。Design categoryでclassifierへwhole-workspace sourceを送らず、downstreamはsupporting refsのhash/identityも検証する。

既存の最大4docs・8KiB/proposed content・64KiB/before content・question boundsを維持する。Human待ちにworkspaceが変わった場合はdocument write前に停止する。Partial write / missing after / publication failureはintentをbarrierに残し、replay/rollback/adoptionしない。Ownership checkpointだけの更新はclarification semantic source digestを変えず、owner identity自体はbindingから外さない。

## Trust / safety boundaries

Project trustはPiのpublic `ctx.isProjectTrusted()`だけをproduction compositionで受け取り、既存public launch policy / pi-subagents 0.74.0 child inheritanceを再利用する。Ownershipはtrustと独立で、trustを推測・変更・resource loaderを再実装しない。Trusted project resources/readOnlyHintもMain implementation authorityを増やさない。

Hooksはmodel-issued / nested `ctx.executeTool()` / MCP callsの境界であり、trusted extensionのdirect filesystem / `pi.exec` やoperatorへのOS sandboxではない。その変更をnext authoritative action前にworkspace driftとして拒否する。Double observationはatomic filesystem snapshotではない。Gitは既存tracked/non-ignored untracked observation、filesystemは既存bounded UTF-8/type/mode/link policyを再利用する。Observation outside that provider workloadや、同時のarbitrary privileged codeに対する隔離を主張しない。

Legacy/unbound owner、別root sessionへのadoption、ownership conflicts、provider/root/observation drift、ambiguous mutationはexplicit operator reconciliation待ち。Automatic trust/adoption/migration/rebaseline/Worker relaunchは追加しない。

## Acceptance coverage

| Issue #5 criterion | Evidence |
| --- | --- |
| Root return cannot authorize pre-Worker implementation | Every-call durable owner scan / root-session binding / all-raw-tool denial; real top-level write denial |
| Unexpected implementation mutation detected before authority | Driver/resume/Oracle/pre-Worker checks; durable drift block / zero child / unchanged baseline tests; real trusted-extension direct-FS drift stop |
| GRILL_ME read/interaction-only | Existing mode/document denial + owned mode/root-session tests; no implementation/approval refs |
| GRILL_WITH_DOCS exact design-document scope only | Existing traversal/link/hardlink tests + control-byte rejection + owned Git/non-Git positive CONTEXT/ADR tests + actual Human CONTEXT creation |
| Authorized changes durable and State-bound | Request / Human answer / before / intent / after / completion / owner checkpoint hashes and exact links; publication-fault tests |
| Docs authority cannot become implementation | No Plan/Code approval or implementation Event from docs; checkpoint is observation only; approved Worker/fix lifecycle still requires gates |
| Clarification usable without implementation | Actual public questionnaire / actual Human confirmation / owned root tool → planning, while raw tools denied |
| Normalization/symlink cannot widen scope | Exact POSIX allowlist, unsafe runtime/document paths and parent/target links rejected; only exact target exclusions / other-workspace contents unchanged |
| Real Pi denies implementation and permits docs | Trusted-project root/nested tool denial + actual Human authorized document update + drift stop; Herdr evidence below |
| Trust never inferred; untrusted child excludes project resources | Existing public trust-aware launch contracts + actual 0.74.0 native child evidence/settings/prompt/skills/extensions canaries; trusted project mutation tool still denied |

## Validation

Focused commands / ownership / clarification / normal-driver: **4 files / 77 tests PASS**。Production Oracle / child trust composition: **2 files / 33 tests PASS**。Final `VITEST_MAX_WORKERS=1 pnpm check`: **PASS — typecheck / lint（warningsなし）/ format / 64 files / 896 tests**、2026-10-04T12:09:44Z開始。`git diff --check`: PASS。Changed Markdown local pathsは**7 files / 87 links PASS**。

最初のall-suiteのobsolete package handler expectation 2件、host boundary未注入 / 同じworkspaceへのparallel startを前提にした旧fixture 5件は修正・再検証した。既存block上のOracle pending continuationはownership checkによって誤停止しないよう修正し、Human/operator block自体は解除しない。次のall-suiteの既存Human Code Feedback E2E 1件（5秒timeout）はPASSにせず、assertion / timeoutを緩めずfocused（1 PASS / 41 skipped）と最終全体checkを再実行し、上記全件PASS。Missing-boundary / conflicts / source drift / mutation retryのsafety assertionsを弱めていない。

## Real Pi / Herdr evidence

### Active ownership / Human documents — PASS

- Pi **0.99.1**、pinned questionnaire commit **`0a6ad2c5fd7f79ceccb51bc791c10554789bdbd2`**、real underlying grilling/domain-modeling skill bytes。
- Final new Herdr tab / pane / Agent **`wF:t35` / `wF:p3G` / `issue5-production-final`**。Started **2026-10-04T12:22:07.371Z**、finished **2026-10-04T12:23:26.946Z**。Full check後の最終コードを使用した。
- Actual trusted project APPEND_SYSTEM / project tool loaded。Nested `write` / `edit` / `bash` / misleading readOnlyHint `project_mutate` は各isErrorで拒否。Actual root model-issued `write source.ts` も公開transcriptで拒否を確認。
- **Actual HumanがTUIでexact CONTEXT.md creationをConfirm**。Question/answer/document intent/result/completion/accepted checkpointを保存、source unchanged、Plan/implementation refsなし。
- 続いてtest-owned trusted-extension direct-FS mutationを明示注入。Next normal-driver actionがdurable operator-attention block、additional child/Worker **0**。これはOS sandboxの主張ではなくout-of-band authority rejectionの検証。
- Raw machine-local report: `/tmp/issue5-production-final-smoke.json`。Final independent audit `/tmp/issue5-final-independent-audit.json`: **22 immutable refs/hashes、exact before/intent/answer/after/completion/checkpoint links、CONTEXT.mdだけのauthorized change、sourceをdesign payloadに含めないこと、drift block、approval/implementation refsなしをPASS**（2026-10-04T12:27:36.429Z）。Offline deterministic root provider、Scout/classifierはfixtures（network calls 0）。Actual Worker / Human Plan・Code approval / full v1 PASSとは区別する。

First probe **`wF:t20` / `wF:p3B`** は`--no-approve`によりproject-untrustedでsetup停止し、PASSではない。Disposable fixture以外へのmutationはない。Second probeの最初の集計は「blocked top-level callでもtool_result hookが必ず発火する」という誤った仮定で失敗した。Public transcript auditに修正し、**同じdurable Human/document resultを監査**してPASS。Question/document/Workerの再実行はしていない。Previous audit failureはreportに保持した。このcheckpointの後にworkspace/scope bodiesをseparate reconciliation refsへ分離し、最終版は上記new fixture/new tabで再検証した。Intermediate **`wF:t34` / `wF:p3F`** はHuman deadline 15分で`human-gate-unavailable` / pending evidenceを残してblock、document write **0**。Questionが既に消えていたためユーザーが回答できなかったことを確認し、PASSにせず、同じworkflowをreplayしなかった。Final runの実Human回答は成功している。

### Untrusted native child — PASS

- Pi **0.99.1** / pi-subagents **0.74.0**、final new Herdr tab / pane / Agent **`wF:t36` / `wF:p3H` / `issue5-trust-final`**。Earlier modern checkpoint **`wF:t33` / `wF:p3E`** もPASSだったが、最終コードで別fixture/tabを再実行した。
- Final report recordedAt **2026-10-04T12:22:04.271Z**。Modern existing [launch smoke](../../tests/platform/launch-smoke-extension.ts) をactual native childで再実行した。
- Parent/child projectTrusted **false**、project skill/prompt/settings injection absent、project extension loading marker absent、explicit selected skill only、callable tools **read only**。Exact preflight/intent/receipt/full output/recovery一致。Public process-terminal **observed / exit 0**。
- Raw final report: `/tmp/issue5-trust-final-smoke.json`。Offline providerが必要なためtest-only policyはdenyExtensions:false、production ceilingを緩めていない。
- Initial historical platform-smoke invocation **`wF:t32` / `wF:p3D`** は#21以降のrequired host snapshotを渡していない旧harnessのためpreflightで停止。PASS扱いせず、modern launch harness/new fixture/tabに切り替えた。Third-party patch / unverified dispatch / Worker retryはない。

全real runsはnew Herdr tab。tmux / direct Pi spawn / AgentによるHuman代理回答 / live classifier送信 / operator auth・settings変更はない。Fixtureはquestion sourceをclean archiveで固定し、credentialsをloadしない。Reportsとimmutable evidence / child terminal確認後、作成したsuccessful/failed probe tabsのみcleanup済み。Temporary evidenceはmachine-local audit用に保持し、operatorの既存tabsは変更していない。

## Reproduction

```sh
# No credentials/network model needed; pinned questionnaire checkout + installed real skills.
node --experimental-strip-types --input-type=module -e '
  import { ownershipFixture } from "./tests/platform/ownership-fixture.ts";
  console.log(JSON.stringify(await ownershipFixture(
    process.env.HOME + "/.pi/agent/git/github.com/minorunakamura/pi-ask-user-question",
    process.env.HOME + "/.pi/agent/skills"))));
'
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd <fixture-cwd> \
  --label issue5-ownership --env PI_CODING_AGENT_DIR=<fixture-agentDir> --no-focus
herdr agent start issue5-ownership --kind pi --pane <returned-pane-id> -- \
  --no-session --no-prompt-templates -e <fixture-questionPackage> \
  -e <repo>/tests/platform/ownership-smoke-extension.ts --model ownership-smoke/probe
herdr agent prompt issue5-ownership '/ownership-smoke /tmp/issue5-ownership-smoke.json'
# Actual Human reviews/responds to the TUI questionnaire. Never proxy the answer.
# The optional /ownership-audit audits the same completed evidence only; never repeat the write.
```

The smoke's explicit project_trust handler selects **yes / remember:false for the disposable fixture only**。Do not use `--no-approve` for this trusted-resource positive probe。Untrusted verification uses existing platformFixture + modern launch-smoke-extension with public host snapshot（[launch reproduction](./agent-launch-contract.md)）。
