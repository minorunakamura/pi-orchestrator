# Issue #20 — Bounded read-only child Codemode

## Preparation / scope

GitHub #20 の本文・全 acceptance criteria（comments なし）、#13 の本文・全 comments、AGENTS.md、canonical Integrations / Runtime / Planning / Persistence / Test Strategy、#21 public launch boundary と現行 caller を確認した。Prerequisite #18 / #21 / #14 は CLOSED、#14 PR #34 は MERGED。Product `plan-simplicity-reviewer` が存在するため dependency order は満たす。CodeGraph は core launch symbol を収録していなかったため、targeted source/caller inspection で補完した。

初期導入は Issue の **Scout and/or Plan Simplicity Reviewer** に従い **Plan Simplicity Reviewer のみ**。Scout は Diagnosis にも再利用されるため本変更では有効化しない。Correctness / Ponytail の optional expansion、Worker、root/Main、Oracle、Research、Human Gates、Validation、classifier、State/Artifact persistence authority は追加しない。#21 を再実装・reopen せず、既存の normal simplicity runner / driver / recovery を使う。Third-party modification / private API / 新しい dependency / workflow scripts はない。

## Implementation

- Agent definition / `agentLaunchPolicy()` が `read,grep,find,ls,codemode` を明示。`extensions:` 空で ambient discovery を無効化し、`subagentOnlyExtensions` は Orchestrator-owned replacement のみ。Fresh context / explicit empty skills / `inheritSkills:false` を維持。
- `src/runtime/integrations/readonly-codemode.ts` は released public `createCodemodeExtension({ models:false, mode:"on" })` を呼び、public `registerTool` の definition を薄く wrap する。pi-subagents **0.74.0** の native-child replaceable builtin がこの登録に置換される。Parent `src/index.ts` はこの extension を load しない。
- 共通 public preflight は canonical replacement path、ambient exclusion、唯一の configured extension を検証。Tool-extension paths、MCP、nested fanout、internal controls、required-extension additions は拒否。Replacement bytes hash を既存 `extensionsDigest` に含め、persistence 後にも再検証する。Missing/wrong/extra/ambient replacement は dispatch 前に停止。Caller Boolean / prose を isolation proof としない。
- Public `prepareLoadout` は **全 registered tools と callable tools** を検査し、deferred / hidden / MCP / control を含む未知の capability を provider loadout 構築前に拒否。Script execution 時にも `ctx.tools` / `pi.getAllTools()` を再検証し、nested `codemode` や non-read-only `tool_call` は block。
- Model が指定した options を置換し、script は **30000 ms / 4000 output tokens** に固定。Public RPC `toolTimeoutMs:30000`、existing finite child deadline、task/full-output **1 MiB** bounds を併用。Output token ceiling は stock truncation/full-temp-output behaviorであり、巨大な出力を Workflow authority として採用する許可ではない。
- Agent guidance は batched reads ごとの path / line ranges / verbatim excerpts を維持。Simplicity finding は引き続き exact supplied Scout/Diagnosis refs/body に bind される。Scripts / nested results / Codemode stores は evidence のみ。
- Launch → Orchestrator Artifact/State callback → projection recheck → dispatch → exact receipt → canonical full output の順序、immutable review Artifact/hash/schema、current launch freshness、mandatory Human Gates を維持。Recovery は historical receipt/output を使い、script replay は不要。Other Codemode inspection roles は dispatch unsupported のまま。

## Acceptance coverage

| Issue requirement | Implementation / executable evidence |
| --- | --- |
| Scout and/or Simplicity Codemode; read-only ceiling | Simplicity only; product policy/definition、public preflight、actual native child |
| Mutation / equivalent shell / MCP paths unavailable | Effective ceiling、registered/callable checks、official sandbox negative tests、actual ten denied script calls |
| Batched/parallel reads retain provenance | Agent guidance、two-source unit test、actual `Promise.all` reads with path/line/excerpt |
| Independently persisted/hash-validated output | Unchanged `runPlanningAgent` / ArtifactStore / simplicity publication; smoke exact receipt/full-output/hash round-trip |
| Resume without script replay | Current preflight + historical receipt/full output; recreated adapter smoke with 0 additional spawns |
| Tests prove mutation denial | Official factory tests for write/edit/bash/MCP + controls; unknown direct/deferred/codemode/model-only/hidden registry rejection |
| Positive real Pi enabled-child path | New Herdr tab, actual product Plan Simplicity Reviewer / actual Codemode / actual built-in reads |
| Worker remains out of scope | Worker policy still forbids Codemode; package/core tests retain all other roles disabled |
| pi-subagents >=0.74.0 minimum | Existing runtime dependency **0.74.0** / public launch+lifecycle v3 checks / canonical documented baseline |
| Completed #21 boundary / exact binding | Existing public resolver, ceiling, callbacks, receipt, hash/recovery; no parallel launch path |
| Official models-disabled child replacement | Public factory + supported Agent child-only loading + replaceable builtin; actual `typeof models === "undefined"` / failed `models.classify` |
| No classifier consent bypass | Models namespace absent, no classifier tool/provider exposed; unit spy records 0 classifier calls |
| Parent Codemode may remain disabled | Actual parent active tools exclude Codemode while child executes it |
| Nested subagent/supervisor/structured output denied | Actual script calls fail; `ALL_TOOLS` contains only read/grep/find/ls; model-only Codemode cannot recursively call itself |
| Tool/definition changes invalidate reuse | Existing projection comparison + adopted-role tool/definition drift tests; replacement content joins extension freshness |

## Validation

- Focused tests: **PASS — 6 files / 83 tests** (`agent-launch`, `readonly-codemode`, core policy, Plan Simplicity, Agent definition, package).
- Final `VITEST_MAX_WORKERS=2 pnpm check`: **PASS — typecheck / lint（warnings なし）/ format / 58 files / 806 tests**。Initial full run failed **1 obsolete Agent-definition assertion**, with 803 other tests passing; expected tools were updated to the explicitly adopted Codemode ceiling, without weakening mutation/authority assertions.
- `git diff --check` / final format: PASS。Changed Markdown local links/anchors: **44件 PASS**。

## Real Pi / Herdr enabled-child smoke

**PASS — 2026-10-03T17:05:01.108Z → 17:05:19.561Z**。New tab **wF:t2S** / pane **wF:p33** / Agent **issue20-codemode**。Pi **0.99.1** / pi-subagents **0.74.0** / actual child **openai/gpt-6.1-sol**, thinking **medium**。tmux / direct Pi spawn はない。

- Product package Agent source、exact child-only extension、real public preflight/capability ceiling / native async single-agent RPC / lifecycle v3 / actual full-output recovery を使用。Synthetic two-file workspace only。
- Actual child spawns **1**、model turns **2**、top-level Codemode calls **1**、nested built-in reads **2**（both ok）。`Promise.all` source evidence は `greeting.mjs:1-1` と `facts.txt:1-1`、verbatim excerpts 一致。
- Callable tools は **read/grep/find/ls**。`write/edit/bash/codemode/subagent/subagents_enable/subagent_supervisor/contact_supervisor/structured_output/mcp__fs__write` の actual script calls は全て拒否。`models` は undefined、actual `models.classify` access は失敗。Unreserved live classifier request は行わない。
- Effective registered ceiling は **codemode/find/grep/ls/read**、skills=[]。Parent Codemode disabled、project trust false。Workspace bytes unchanged、forbidden mutation file absent、approval/implementation refs absent。
- Exact launch/receipt digest: `1543f9016fdb2178606702ddbeb568ca6a2c823d8a3d1f5b69f04a4fecb4e9c7`。Full output Artifact SHA-256: `b5664c6ff41d2a313065124cd7796a6ebb488fad44f6c7d08f3c1e094f48a226`。
- Recreated adapter / historical planning attempt recovery: identical full output、**0 redispatch / 0 script replay**。Public process-terminal proof **observed / exit 0**。
- `herdr agent prompt --wait` returned `agent_prompt_stalled` because this extension command did not change the root Agent lifecycle state during its first 5 seconds。It was **not retried/relaunched**: subsequent report/transcript/terminal inspection confirmed the same command and single child completed successfully。CLI wait alone is not smoke evidence。
- Machine-local raw report: `/tmp/issue20-smoke.json`。Harness: `tests/platform/codemode-smoke-extension.ts`。Independent raw State/receipt/hash/output/two-file workspace/terminal audit PASS。Actual final output は schemaVersion=1 / findings=[] の valid JSON と別途確認。Its first Node strip-only audit could not import a pre-existing TypeScript parameter property; it was not counted as PASS, and a stdlib-only audit verified the same persisted evidence without relaunch。
- 成功後、作成した tab のみ close、temporary auth symlink のみ remove。Report / durable evidence は保持。

### Evaluation / limits

Two independent reads fit in one top-level call instead of two direct calls; this proves batching, **not fewer underlying reads or a measured model-turn speedup**。Filtered fact payload was **181 bytes**。The diagnostic script also returned its callable catalog, so total context reduction / broad performance gain is not claimed. Source completeness/correctness is checked for the two synthetic files, not arbitrary repositories.

Parent/root model is the offline probe; child is actual live model。Human Gates / live Jev / complete v1 lifecycle were not executed. This is the focused #20 isolation/enablement/output/recovery proof, not #12 integrated production/release PASS。No release evidence / CHANGELOG / GitHub issue state changes。

This is a callable-tool ceiling, **not an OS sandbox** for arbitrary trusted extension filesystem code or repository read scope。Only the canonical trusted replacement loads; unknown extension configurations fail closed。Legacy non-Codemode simplicity launch/definition evidence is stale after adoption and is not silently migrated/rebound. Full-output recovery never reconstructs authority from script state.

### Reproduction

Create disposable fixture resources with the existing `simplicityFixture(authFile, repository)` and add `facts.txt` containing `source provenance canary\n`; do not change operator settings or third-party packages. The fixture uses only a temporary auth symlink.

```sh
node --experimental-strip-types --input-type=module -e '
  import { simplicityFixture } from "./tests/platform/simplicity-fixture.ts";
  import { writeFile } from "node:fs/promises";
  import { join } from "node:path";
  const f = await simplicityFixture(`${process.env.HOME}/.pi/agent/auth.json`, process.cwd());
  await writeFile(join(f.cwd, "facts.txt"), "source provenance canary\n");
  console.log(JSON.stringify(f));
'
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd <returned-cwd> \
  --label issue20-codemode --env PI_CODING_AGENT_DIR=<returned-agentDir> --no-focus
herdr agent start issue20-codemode --kind pi --pane <returned-paneId> -- \
  --no-approve --no-session --no-extensions --no-skills --no-prompt-templates \
  -e <repository>/node_modules/pi-subagents \
  -e <repository>/tests/platform/probe-provider.ts \
  -e <repository>/tests/platform/codemode-smoke-extension.ts --model platform-smoke/probe
herdr agent prompt issue20-codemode '/codemode-smoke /tmp/issue20-smoke.json'
# Wait for report, inspect exact assertions/transcript/terminal proof; no blind retry.
# After successful audit, close only the created tab and remove the temporary auth symlink.
```
