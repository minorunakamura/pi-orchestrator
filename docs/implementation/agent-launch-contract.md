# Issue #21 — Agent Launch Policy / resolved launch contract

## Preparation / scope

GitHub #21 / #13 の本文・acceptance criteria・comments（いずれも comments なし）、前提 #3 / #18（ともに CLOSED）、AGENTS.md、canonical integration/runtime/planning/coding/persistence contracts と既存 caller を確認した。

実装対象は共通 child-launch boundary。normal driver (#4)、TDD method/seam approval (#16)、Oracle escalation/budget (#17)、Codemode enablement (#20)、Main ownership guard (#5)、full production lifecycle (#12) は先行実装しない。Human Plan Gate / Human Code Gate、approved Worker routing authority、immutable Artifacts / State CAS、pi-orchestrator の lifecycle ownership は変更しない。

Subsequent #20: verified Codemode dispatch is now enabled **only for Plan Simplicity Reviewer**。Exact child replacement / models isolation / bounded execution / positive native-child smoke are recorded in [#20 implementation](./readonly-codemode.md)。The inspection-only and default-policy descriptions below record #21's original foundation; its Scout inspection remains unsupported for dispatch. #21 is not reopened.

## Public dependency / execution owner

`pi-subagents` **0.74.0** を dev-only から runtime dependency に変更し、公開 `pi-subagents/preflight` / `pi-subagents/capability-ceiling` subpaths だけを import する。Pi は host peer のまま。第三者 package/private API は変更・使用しない。

Host はこの dependency と同じ released extension を一つだけ load すること。development smoke は `-e ./node_modules/pi-subagents` を明示する。Preflight は package/contract/lifecycle versions を検証し、実行 receipt の canonical launch digest が一致しなければ、known run/receipt を保持して ambiguous にする。Public RPC は execution owner の npm source/version を dispatch 前に attest する API ではないため、別 installed owner の互換性を仮定しない。

## Domain / adapter boundary

- `src/core/agent-launch.ts`: Pi transport に依存しない policy と bounded evidence schema。
- `SubagentExecutor.preflight(request)`: launch-state side effect なしの resolution。recovery の equivalent-attempt comparison にも使用。明示的な Codemode policy は Scout/simplicity/optional post-code reviewers に限定し、read-only repository tools + `codemode` のみ、required `codemode`、effective extension ceiling を検査する。default policies/product Agent definitions は Codemode を有効化しない。
- `run({ onPrepared, onStarted })`: public ceiling → public preflight → Orchestrator の durable evidence/State callback → projection 再検証 → output preparation / RPC spawn → exact receipt → canonical full output。
- Host composition は `sessionId`、`isProjectTrusted()`、available physical models、parent model、scoped-model snapshot、public MCP snapshot host を渡す。missing model、required Agent/skill/tool、unresolved `host-required` capability、unsupported contract は not-dispatched。
- 公開 session-scoped ceiling は other owners と intersect する。read-only roles は repository tools のみ（Research は explicit ketch tools）、Worker は approved profile と builtin mutation tools を持つ。Oracle/reviewer/Worker は builtin source を検証する。
- `modelPolicy: resolved-physical` は role の resolved physical model/API/thinking を証拠化し、RPC の `provider/id:thinking` suffix に pin する。Host の public registry から released physical API または明示登録済み physical transport の model snapshot を選び、Virtual Models / unknown routers を除外する。reasoning が必要な launch は capability が明示 true でなければ拒否する。Worker は approved Execution Profile と一致しなければ dispatch しない。
- `skill`、`reads:false`、`progress:false`、`intercomBridge:{mode:"off"}` を公開 RPC に渡す。inheritance の unsupported per-RPC field を捏造しない。

## Persistence / freshness / recovery

Projection の上限は **32 KiB**、identifier **256 characters**、各 capability/skill list **128 entries**。Task/skill body、credentials、raw settings、raw extension/source paths は含めない。cwd/output/task/source/extensions は hashes、explicit skill は name/source identity/content hash を保存する。

Planning は既存 `planning.agentAttempts[stage]` に launch projection を bind し、State が保存できない場合は spawn しない。current contract と historical projection/receipt/input identity が異なる場合は reuse/replacement を拒否する。

Worker は intent → launch → receipt → received/result observations の append-only chain を保持する。各 record の `previousRef` は predecessor を指す。公開 runId は receipt callback で保存する。success/recovery は historical launch/profile/request/run/receipt digest と repository evidence を検証する。current ambient model へ置換せず、missing legacy launch/receipt は blocked。

Review fanout は parallel のまま。launch/receipt は `agent-runs/review.launch.p<planVersion>.i<implementationRevision>.r<round>.<source>-{launch,receipt}.json` に保存し、State の `external` index にそれぞれの SHA-256 を bind する。callback の State saves は直列化し、fanout の各 child は自分の save 後にのみ spawn する。resume は exact historical launch/receipt と current equivalent contract を確認し、public status/full output から回収する。partial/missing/drifted receipt は redispatch しない。fanout の rejection 時は全 sibling の bounded settlement を待って最新 State を保持する。

Early public status は launch digest / step projection が未確定の場合があるため、公開 receipt の run/request/digest と status の session ownership を先に保存する。success は terminal lifecycle status の exact launch/cwd/agent identity と canonical full output が揃ってからのみ返す。startup race と terminal digest mismatch の回帰テストを追加した。

Preflight / child success / advisory evidence は Workflow authority ではない。default Worker reads/progress、display/truncated output、timeout/stop を authority に昇格しない。

## Role capability coverage / limits

| Requirement | Boundary behavior |
| --- | --- |
| Every production child policy | Scout/Research/Planner/Worker/Correctness/Ponytail request factories と common adapter に接続 |
| Required skills | `WorkerInput.skills` → policy → public `skill`; missing skill blocks。builtin TDD preflight positive test と skill-byte drift test |
| Oracle | builtin source + advisory role + fresh context + ceiling excluding bash/edit/write/nested execution。shadowed Oracle denied |
| Read-only Codemode | public preflight の positive inspection で `codemode` が resolved、mutation tools が unavailable であることを検証。missing tool／mutation／inherited extension denial／tool-definition drift を検証。`run` は #20 の runtime isolation が実装されるまで **not-dispatched** |
| Historical reuse | planning/review は current projection comparison、Worker は historical approved profile/receipt。no blind relaunch / migration defaults |
| Bounded non-secret durability | strict closed schema + identifier/list/byte limits + body/path/settings hashes |

Acceptance status: GitHub #21/#20/#13 の責任分担 clarification に基づき、#21 の common Codemode-aware inspection と positive/negative contract tests を補完し、更新後の #21 acceptance criteria を検証済み。Codemode-enabled child の実行・models-namespace isolation・positive enabled-child smoke は #20 に残す。capability inspection の成功、Agent prose、caller Boolean を dispatch permission にしない。

Public preflight は resolved intent であり、OS sandbox、loaded extension の direct filesystem code、provider authentication、skill instructions の遵守、skill/body bytes の atomic runtime attestation ではない。Role ceilings は model/nested callable tools を制限するが、trusted extension の out-of-band side effects を sandbox 化しない。skill byte hash は persistence 後にも再検証するが、filesystem atomic snapshot を主張しない。

Production defaults は Research 以外 `denyExtensions:true`。custom child model/tool providers がその ceiling と両立しない場合は unsupported/blocked とし、ambient capability を permission に変えない。Read-only roles の supervisor bridge は off。Worker の material-deviation interaction は #15/#17 の後続 contract が接続する。

## Automated validation

| Validation | Final result |
| --- | --- |
| focused launch/core/recovery/failure tests | PASS — 4 files / 81 tests |
| `VITEST_MAX_WORKERS=4 pnpm check` | PASS — typecheck / lint / format / **46 files, 584 tests**（120.54 seconds） |
| `git diff --check` | PASS |

途中の全 suite は parallel reviewers の dispatch 順を固定する既存 assertion で 1 test が失敗した。required Scout → Planner → Worker 順はそのまま検証し、parallel reviewers のみ order-independent に修正した後、全 suite を再実行して PASS。real smoke の startup projection race も producer/recovery boundary を修正し、回帰テストと最終 native smoke で再検証した。未解消の validation failure はない。

## Real Pi / Herdr smoke

Final recorded **2026-10-02T01:32:55.266Z**。new Herdr tab **wF:t28** / pane **wF:p2J** / Agent **issue21-handoff**。成功確認後 tab close。tmux/direct Pi spawn は使用しない。

- Pi host **0.99.1**、explicitly loaded pi-subagents **0.74.0**、launch/lifecycle v3。
- 実 Pi TUI / native background child / public RPC / lifecycle/full-output files / production adapter。model transport だけ public provider API による offline fixture。network/billed model calls なし。
- durable preflight projection の digest と actual receipt digest が一致: `c46091af448f2a22c3517bcf8598203058178c2239fa1696feceb1828d683374`。
- child run: `11f700bf-a905-4bf2-add1-3b18ab2418b1`。
- child tools: **read のみ**。write/edit/bash/codemode/subagent なし。
- child project trust false、explicit selected skill present、ambient/user/extension/project skills absent、untrusted project prompt absent。
- historical receipt/status と canonical full output が一致し、restart-style status recovery PASS。
- actual host に registered Virtual Model の positive control を作り、physical snapshot から除外し、Virtual / unsupported thinking の preflight を dispatch 前に拒否した。
- Codemode inspection は disposable fixture の synthetic `workflow-scout` definition を使い、public preflight が **codemode, read のみ**を返した。declared edit/write/bash は effective ceiling から除外された。bounded projection の ArtifactStore round-trip が一致し、`run` は runtime isolation 未検証として拒否、RPC spawns **0**。Codemode scripts は実行しておらず、#20 の enabled-child smoke の代替ではない。
- Codemode inspection digest: `6fedffac1b825b0e21230c0236ba4af7aa72f1dd8201372533612d34d41fff8f`。
- raw report: `/tmp/pi-orchestrator-issue21-handoff-smoke.json`（machine-local）。

Offline provider を child に load するため、smoke は explicit test policy `denyExtensions:false` を使用する。production role default を緩和する例外ではない。builtin Worker/Oracle preflight と missing skills/role ceilings は automated public-contract tests で検証する。full TDD/Oracle/Codemode stage と actual Human Gates/Git/non-Git lifecycle の live coverage は #12 と後続 Issues。

### Reproduction

```sh
pnpm install --frozen-lockfile
VITEST_MAX_WORKERS=4 pnpm check
node --experimental-strip-types --input-type=module -e \
  'import { platformFixture } from "./tests/platform/fixtures.ts"; console.log(JSON.stringify(await platformFixture()))'
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd "$PWD" \
  --label issue21-launch --env PI_CODING_AGENT_DIR=<returned-agentDir> --no-focus
herdr agent start issue21-launch --kind pi --pane <returned-paneId> -- \
  --no-approve --no-session --no-extensions --no-skills --no-prompt-templates \
  -e ./node_modules/pi-subagents -e ./src/index.ts \
  -e ./tests/platform/probe-provider.ts -e ./tests/platform/launch-smoke-extension.ts \
  --model platform-smoke/probe
herdr agent prompt issue21-launch '/launch-smoke /tmp/issue21-smoke.json'
# report.status と assertion/receipt evidence を確認し、作成した成功 tab のみ close。
herdr tab close <returned-tabId>
```

`tests/platform/launch-smoke-extension.ts` が現在の共通境界用 harness。#18 の旧 harness/report は当時の positive inherited-skill control の historical evidence であり、新 boundary の代替ではない。release evidence / CHANGELOG は更新しない。

## Stage-profile follow-up — missing Scout thinking

Operator-reported `/wf-new` stopped before Scout dispatch with `launch-policy-rejected`: a package `workflow-scout` without explicit thinking resolved an ambient model but no thinking, while the Orchestrator correctly required a resolved thinking identity. This follow-up uses #21's permitted deterministic role-profile policy; it does not relax preflight or modify third-party packages.

- `src/core/configuration.ts` owns eight default logical profiles and validates optional partial `stageProfiles` overrides. Existing `executionProfiles` / `reasoningMapping` resolve physical values; the supported keys/defaults are in [canonical configuration](../basic-design/configuration.md#stage-profiles).
- Request factories carry a logical `profileStage`, distinct from versioned dispatch node IDs. Scout and Diagnosis share `workflow-scout` but select independent profiles. Architecture/refinement/replanning share `planning`.
- Production command composition supplies configuration to the common adapter. The adapter binds the stage to its expected Agent, resolves the profile before preflight/run, and preserves the existing tool/skill/context/extension policy. Explicit launch values win over ambient pi-subagents defaults; unavailable selected capabilities fail before dispatch, without fallback.
- Existing launch evidence persists the resolved profile before dispatch. Historical preflight comparison rejects stage/model/thinking drift without rebinding evidence or redispatching an unresolved child. Worker/Fix Worker retain their approved dynamic routing; Root clarification, classifiers, Validation and Human Gates are unchanged.

Focused validation: **4 files / 110 tests PASS**, plus **16 command tests PASS** covering actual factory wiring through both fake Human Gates. Coverage includes all eight stage bindings, defaults/overrides, strict invalid settings, trusted settings merge, missing capabilities/zero dispatch, Worker isolation, and historical reconciliation drift. Final **`VITEST_MAX_WORKERS=1 pnpm check` PASS — 66 files / 945 tests**, 2026-10-06 03:28:57 JST start, 611.61 seconds, exit 0. Typecheck/lint/format were also rechecked after the smoke/command assertion updates; `git diff --check` PASS. Earlier default/four-worker full-suite attempts timed out; the documented single-worker command passed with the existing test deadlines unchanged.

Real Pi smoke: **PASS**, recorded **2026-10-05T18:30:58.148Z**, new Herdr tab/pane **`wF:t3G` / `wF:p3V`**, Pi **0.99.1** / pi-subagents **0.74.0**. Updated `diagnosis-fixture.ts` supplies concrete Orchestrator profiles but an unavailable ambient subagent model and no `subagents.defaultThinking`. Root was `openai/gpt-6.1-sol:max`; actual product Scout used **low**, Diagnosis used **high**, each dispatched once with matching persisted launch/receipt/full output. A Diagnosis `STRONG/MEDIUM` override resolved through public preflight and rejected historical evidence without redispatch. Both public process-terminal proofs are **observed / exit 0**, workspace bytes unchanged, and resume reused exact evidence. Raw report: `/tmp/pi-orchestrator-stage-profiles-smoke.json` (machine-local). Successful tab closed and temporary auth symlink removed.

Limits: actual Scout/Diagnosis only; other stage bindings and command lifecycle are automated tests. Classifier routing was scripted; no live Jev, implementation Worker or real Human Gates were executed in this smoke. Existing histories/operator settings are not migrated or edited. Release evidence / CHANGELOG are not updated.
