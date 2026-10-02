# Bounded Oracle advisory — Issue #17

## Preparation / scope

Issue #17（本文・acceptance criteria 全9項目、comments なし）と tracking #13（本文・全comments）を確認。前提 #3 / #18 / #21 / #4 は CLOSED。#17 は #14 の子ではなく、#21 後に実装できる cross-cutting capability。

Canonical contracts: [Basic Design §10](../basic-design/basic-design.md#10-oracle-advisory)、[Integrations §11](../basic-design/integrations.md#11-oracle--reviewer--main-boundaries)、[Planning](../detailed-design/planning-orchestration.md)、[Runtime](../detailed-design/runtime-design.md)、[Persistence](../detailed-design/persistence-recovery.md)、[Test Strategy](../detailed-design/test-strategy.md)。第三者 package・依存バージョン・Human Gates・classifier policy は変更しない。

## Implemented boundary

- `src/core/oracle.ts`: explicit reason allowlist / decision-point guards、workflow-wide budget **2 attempts**、deadline **300000 ms**。通常 workflow に Oracle を自動追加しない。設定可能な generic routing registry や advisory UI は追加しない。
- `src/runtime/orchestrator/oracle-advisory.ts`: `requestOracleAdvice()` → immutable request Artifact / budget State → shared durable `runPlanningAgent()` → full result Artifact / State。Oracle 自身には State writer / authority port を渡さない。
- `oracle-advisory` request/result は `advisory/` に on demand 保存。Request は workflowId、source State revision / contract digest、reason、exact question、exact current evidence refs/hashes + explicitly supplied refs、ordinal、deadline policy を保存。Result は request ref / body、resolved launch、exact dispatch/receipt/run identity、full returned output を保存。Assumptions / risks / unresolved questions は返された full advice 内で保持し、prose を authority や typed decision に変換しない。
- Launch は既存 `SubagentsIntegration` / pi-subagents **0.74.0** public preflight / capability ceiling / single-agent RPC / lifecycle v3。Builtin `oracle` の source を検査し、`context:fresh`、read/grep/find/ls の ceiling、bash/edit/write/nested execution/Codemode 禁止、extensions/ambient skills の isolation を維持。Builtin をコピー・fork・patch しない。
- `WorkflowState.oracle` は attemptsUsed / pendingRef / latestAdviceRef のみ。Launch ledger は既存 `planning.agentAttempts` を共有し、cross-cutting `oracle-1` / `oracle-2` identity を追加。新しい linear Phase / approval Event はない。
- Normal driver は pending advisory を先に完了・保存してから同じ driver の既存 phase runner へ継続。Oracle wait は Human Gate ではない。既存 Human/operator block 上の相談はその block を解除しない。
- Production composition `createWorkflowCommandRuntime(...).advise(workflowId, question)` は exact workflow identity と current State を lock 下で読み、request/budget を保存してから normal driving。Historical running Oracle の exact run completion notification は wake-up hint として同じ driver を再開し、persisted receipt / public status を再検証する。Unrelated notification は無視し、通知自体では authority を進めない。既存 consumer 向けに `requestOracleAdvice` / `runOracleAdvice` / `freshOracleAdvice` も公開。任意の model-facing child launcher / 新しい `/wf-*` command は追加しない。

```ts
const runtime = createWorkflowCommandRuntime(pi.events, ctx.cwd, hostOptions);
await runtime.advise!(workflowId, {
  reason: "architecture-tradeoff",
  question: "Compare these two approaches and identify missing evidence; advisory only.",
  evidenceRefs: [exactEvidenceRef],
});
```

### Supported escalation points

| Reason | Required current decision point / evidence |
| --- | --- |
| `competing-diagnosis` | gathering-context（その phase からの block を含む）、bugfix/hotfix、persisted Diagnosis |
| `architecture-tradeoff` | planning（block を含む）、persisted Scout |
| `planning-disagreement` | planning（block を含む）、current candidate Plan |
| `material-plan-deviation` | planning（block を含む）、Worker attempt evidence、old approval already invalidated |
| `post-implementation-escalation` | reviewing（block を含む）、current implementation evidence |

Requests は nonempty question / 8000-character cap / 64 refs を検証し、dispatch 前に全 evidence bytes の hash を検査。Adapter の input/output 1 MiB cap と bounded non-secret launch projection をそのまま使用。Budget は State/client recreation/Plan versions で reset/refund しない。Legacy missing budget/launch ledger/project root は新しい相談を拒否する。

## Freshness / recovery / authority

Source contract は workflow/phase、全 current refs、Plan/implementation versions、counters、routing/accounting/external identity 等を bind。State revision/time と dispatch bookkeeping ledger / Oracle ref の更新は source contract の変化としないが、**original revision を request に残す**。Decision-critical State 契約（current evidence refs、phase、versions、counters 等）の変更は stale。Oracle 自身の exact historical attempt/launch は freshness check で別途比較する。Historical advice を current evidence として読むには request identity、exact input bytes、State の historical attempt、current resolved model/thinking/tools/skills/definition/package/launch digest の一致が必要。Stale advice を新しい header で再発行しない。

Planner は fresh advice ref/body を通常の evidence inputs として消費する。Post-code consultation は deterministic Validation、typed Finding/Round decisions、Human Code Gate を変更しない。Diagnosis / Plan refinement / material deviation producer は同じ explicit boundary を使えるが、#7 / #14 / #15 の本体をここで先行実装しない。Material deviation は approved authority 無効化後のみ相談可能。新しい strategy を実装可能にするのは Planner → fresh Plan Simplicity Review (#14) → **Human Plan Gate** の経路だけであり、Advice は承認・Fix authority を作らない。

`/wf-resume` は pending Oracle を exact historical receipt/launch/full output から reconcile し、成功後は通常 driver に戻る。Running は pending、timeout/stop/receipt loss/launch drift/unknown dispatch は blocked、zero replacement dispatch。Output-before-State failure は identical immutable result の republication のみ。Proven not-dispatched は unavailable evidence として消費済み budget を保持して通常 policy に戻れるが、曖昧な attempt は refund/relaunch しない。選択した released single-agent contract に workflow-only `failureKind` はないため、prose failure classification / workflow-script mode は追加しない。

Untrusted project `.pi` settings/prompts/skills/extensions は upstream public trust inheritance / user discovery scope に従って除外。AGENTS.md/CLAUDE.md context discovery は Pi baseline の trust exception であり OS sandbox ではない。Third-party launch contracts を独自に書き換えたり、trust の Boolean を runtime attestation と扱わない。

## Acceptance coverage

| #17 acceptance criterion | Executable coverage |
| --- | --- |
| Conditional/rare, not mandatory Stage | ordinary driver zero Oracle calls、explicit request、durable finite budget |
| Supported bounded reasons only | allowlist / phase / evidence guards、invalid/missing reason boundary tests、all five reason seams |
| Read-only; no State/files/approval/Fix authority | released public Oracle launch/ceiling tests、actual native Oracle read-only tool call/workspace unchanged、Plan/Code Human waits、existing block preserved |
| Exact durable State/evidence/run identity | request/result Artifact / State barriers、full 96k-character output、exact receipt/launch/input binding |
| Stale evidence not current | State/counter/Plan/phase/evidence-byte/launch drift tests、fresh-only Planner input |
| Material Plan changes still need prescribed approval path | material request refuses existing approval、no Oracle authority Event / Worker dispatch; #14/#15 remain owners of their unimplemented producer lifecycle |
| No replacement of Jev/validation | Oracle results never classified as typed routing/validation answers、post-code continuation retains validation/round/Human Gate |
| Released >=0.74.0 builtin public APIs only | unchanged pinned dependency、builtin source/shadow denial contract tests、real 0.74.0 smoke |
| Safe resume/reconciliation or fail closed | running wait、timeout recovery、missing receipt/model drift/stale pending rejection、output-State fault recovery / no redispatch |

## Validation

- Initial focused launch/driver/recovery tests: **PASS — 4 files / 73 tests**。
- Final Oracle / production command / normal-driver focused tests: **PASS — 3 files / 44 tests**（Oracle-specific **15 tests**）。Historical running completion の automatic wake / exact run matching / zero redispatch と wrong workflow identity の zero-dispatch rejection を含む。
- Final `VITEST_MAX_WORKERS=2 pnpm check`: **PASS — typecheck / lint（warnings なし）/ format / 50 files, 667 tests**、226.68 seconds。
- `git diff --check`: **PASS**。Updated documentation local paths: **30 links PASS**。

## Real Pi / Herdr smoke

**PASS** — 2026-10-02T18:39:47.565Z start。Pi **0.99.1** / pi-subagents **0.74.0** / actual **openai/gpt-6.1-sol**, thinking **high**。Production Oracle launch policy を緩和せず、real builtin Oracle を実行。

- New Herdr tab / pane / Agent: **`wF:t2C` / `wF:p2P` / `issue17-oracle`**。tmux / direct Pi spawn なし。Process-terminal proof observed / exit 0 を確認後、作成した tab のみ close。Temporary auth symlink のみ削除。
- Oracle RPC spawn **1**、actual `read` tool call **1**、effective tools `find, grep, ls, read`、builtin source、fresh context、extensions denied / inheritSkills:false / projectTrusted:false。
- Fixture Scout/Diagnosis evidence → actual Oracle full durable Advice → scripted Research SKIP / Clarification RUN + GRILL_ME → genuine Human wait `clarifying`。Approval/implementation refs は存在しない。
- Recreated production adapter `status(runId, receipt)` の full output が Advice output と一致。Receipt / launch digest 一致、workspace evidence.txt / file list unchanged、untrusted project injection marker 不在。
- Run ID: `e4e3a6c6-2917-4d3f-a892-c222f9afc48c`。Launch digest: `54ec101d33e18095776a096d4ca1d9e92540d48c6422e6313d6f5b46075feae3`。
- Public process-terminal proof: observed / exit 0、observedAt **1790966419141**。Raw local report: `/tmp/issue17-oracle-smoke.json`。
- Herdr の slash-command prompt は root lifecycle state が変わらず `agent_prompt_stalled` を返したが、child は実行中だった。再送せず pane/public artifacts を調べ、完成 report と terminal proof を検証した。Stalled UI status を completion/retry authority と扱っていない。

最終 source で同じ smoke を別の new Herdr tab でも再実行し **PASS**：start **2026-10-02T18:56:28.317Z**、tab/pane/Agent **`wF:t2D` / `wF:p2Q` / `issue17-oracle-final`**。Run ID **`9af967d3-2760-4cad-a726-d0e31c525825`**、launch digest **`13fc2bf597a758f8daed9c2347922121ad34f3e1f39cb15e92cc90ad52c08a5b`**、process terminal observed / exit 0（observedAt **1790967413335**）。Raw report **`/tmp/issue17-oracle-final-smoke.json`**。作成した final tab と temporary auth symlink を cleanup 済み。Running completion の composition notification handler は追加後の public-RPC contract test で検証し、この direct-driver live smoke の測定範囲と区別する。

これは live Oracle smoke。Scout/Diagnosis producer は fixture evidence、classifier は scripted（live classify **0**）。Actual Human Gates、live Jev、full redesigned lifecycle、#7/#14/#15 producer behavior はこの smoke の PASS に含めない。#12 の integrated production verification / release evidence / CHANGELOG / Issue status は変更しない。

### Reproduction

`tests/platform/fixtures.ts` の `platformFixture()` で disposable fixture を作り、root を realpath にして personal settings の model を選択し、operator auth.json への temporary symlink を置く。Builtin Oracle 定義はコピーしない。Project injection fixtures は未信頼のまま。

```sh
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd <fixture-cwd> \
  --label issue17-oracle --env PI_CODING_AGENT_DIR=<fixture-agentDir> --no-focus
herdr agent start issue17-oracle --kind pi --pane <returned-pane-id> -- \
  --no-approve --no-session --no-extensions --no-skills --no-prompt-templates \
  --no-context-files --no-tools -e <repo>/node_modules/pi-subagents \
  -e <repo>/tests/platform/oracle-smoke-extension.ts --model openai/gpt-6.1-sol:high
herdr agent prompt issue17-oracle '/oracle-smoke /tmp/issue17-oracle-smoke.json'
# report/status/terminal proof を検査してから、このテストで作った tab のみ close。
```

Smoke workspace は `evidence.txt` に2仮説と未取得の cache timestamps/upstream timings を置く。Selected model/auth は operator environment に必要で、availability/credentials は product classifier consent や implementation authority を意味しない。
