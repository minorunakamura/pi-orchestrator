# Issue #21 — Agent Launch Policy / resolved launch contract

## Preparation / scope

GitHub #21 / #13 の本文・acceptance criteria・comments（いずれも comments なし）、前提 #3 / #18（ともに CLOSED）、AGENTS.md、canonical integration/runtime/planning/coding/persistence contracts と既存 caller を確認した。

実装対象は共通 child-launch boundary。normal driver (#4)、TDD method/seam approval (#16)、Oracle escalation/budget (#17)、Codemode enablement (#20)、Main ownership guard (#5)、full production lifecycle (#12) は先行実装しない。Human Plan Gate / Human Code Gate、approved Worker routing authority、immutable Artifacts / State CAS、pi-orchestrator の lifecycle ownership は変更しない。

Subsequent #20: verified Codemode dispatch is now enabled **only for Plan Simplicity Reviewer**。Exact child replacement / models isolation / bounded execution / positive native-child smoke are recorded in [#20 implementation](./readonly-codemode.md)。The inspection-only and default-policy descriptions below record #21's original foundation; its Scout inspection remains unsupported for dispatch. #21 is not reopened.

## Public dependency / execution owner

`pi-subagents` **0.74.0** を dev-only から runtime dependency に変更し、公開 `pi-subagents/preflight` / `pi-subagents/capability-ceiling` subpaths だけを import する。Pi は host peer のまま。第三者 package/private API は変更・使用しない。

Host は supported released pi-subagents extension を一つだけ load すること。通常の `npm:pi-subagents` installation を変更する必要はない。Production preflight は Pi の公開 `getAllTools().sourceInfo` から loaded owner の package root を取得し、その `package.json` の公開 `./preflight` export を使用する。リポジトリ内 dependency と installed execution owner のコピーが同一だとは仮定しない。Standalone inspection/tests だけはローカル public API を直接使用できる。Preflight は package/contract/lifecycle versions を検証し、実行 receipt の canonical launch digest が一致しなければ、known run/receipt を保持して ambiguous にする。Public RPC 単独は source/version attestation ではなく、host provenance と exact receipt checks を保持する。

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

## Persisted-session follow-up — Scout blocked by Main ownership

Operator-reported `/wf-new` persisted a Scout preflight with `denyExtensions:true`, but the actual RPC launch retained ambient extensions and returned a different digest. The inherited Main ownership hook denied Scout `ls`/`find`; the workflow correctly stopped as `agent-execution-ambiguous`. The native completion wake then caused repeated denied Main tool attempts.

Production composition registered the ceiling against `getSessionId()` (UUID), while pi-subagents 0.74.0 RPC uses `getSessionFile() ?? getSessionId()`. `src/index.ts` now supplies that RPC identity to the existing common preflight/ceiling adapter. **Workflow ownership / root clarification retain the UUID**. No guard relaxation, dependency patch/private import, historical evidence rebinding or blind relaunch is added. The dependency's ceiling documentation uses a UUID registration example, but its public lifecycle documentation describes the file-path-first execution identity; this compatibility correction follows the observed released RPC contract.

`tests/runtime/integrations/launch-session.test.ts` first reproduced the persisted-session mismatch (1 failed / 1 passed), then passed for both persisted and ephemeral sessions. It covers production composition, unchanged ownership UUID, intersecting another owner's ceiling, and cleanup without removing that owner's policy. Focused launch/commands/ownership/package validation: **5 files / 81 tests PASS**. Final **`VITEST_MAX_WORKERS=1 pnpm check` PASS — typecheck / lint / format / 67 files / 947 tests**, 2026-10-06 04:03:02 JST test start, 590.91 seconds, exit 0. Typecheck/lint/format were rechecked after the documentation/comment updates; `git diff --check` PASS.

Real Pi smoke **PASS**, recorded **2026-10-05T19:03:18.946Z**, new Herdr tab/pane **`wF:t3H` / `wF:p3W`**, Pi **0.99.1**, pi-subagents **0.74.0**. Actual production `/wf-new` in a **persisted** root session dispatched the product Scout once, read `cache.ts` / `failure.log`, persisted authoritative Scout evidence, and matched preflight/receipt/status digest `d73f038749c587b99311b881f84b7c0549ab106f2fd33aa71218a3dc30e608de`. Public launch status proved `disableAmbientExtensions:true`; terminal proof was observed / exit 0; exact receipt/full-output recovery succeeded with no redispatch. A deliberate root `read` attempt was denied exactly once, preserving Main ownership. Workspace file bytes were unchanged. No classifier grant was provided, so the subsequent `operator-attention-required` block is expected, not a launch failure. Root notification behavior was bounded by fixture instructions; general notification suppression/retry policy is not claimed. Raw report: `/tmp/pi-orchestrator-launch-ownership-smoke.json` (machine-local). Successful tab closed; temporary auth symlink removed.

### Persisted-session reproduction (current harness)

Use the existing `diagnosisFixture(authFile, "openai/gpt-6.1-sol")` with Node's `--experimental-transform-types`; it creates only disposable resources and an auth symlink. Set fixture root defaults to the same physical model / low thinking and disable retry/cache warming. Do not add fixture prompt workarounds, classifier consent or implementation authority. The historical run above used a deliberate Main negative probe; the current audit instead requires **zero** unsolicited Main tools after completion.

```sh
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd <fixture-cwd> \
  --label launch-ownership-regression --env PI_CODING_AGENT_DIR=<fixture-agentDir> --no-focus
herdr agent start launch-ownership-regression --kind pi --pane <returned-paneId> -- \
  --no-approve --no-extensions --no-skills --no-prompt-templates \
  --session-dir <fixture-root>/sessions \
  -e <repo>/node_modules/pi-subagents -e <repo>/src/index.ts \
  -e <repo>/tests/platform/launch-ownership-smoke-extension.ts \
  --model openai/gpt-6.1-sol --thinking low
herdr agent prompt launch-ownership-regression \
  '/wf-new Read-only evidence only: read cache.ts and failure.log, cite contents/lines, no writes/commands/approval, Scout under 1500 characters.'
# Wait for Scout completion / expected classifier authorization block, then:
herdr agent prompt launch-ownership-regression \
  '/launch-ownership-audit /tmp/pi-orchestrator-launch-ownership-smoke.json'
# Verify report.status and exact receipt/terminal evidence, then close only this tab.
herdr tab close <returned-tabId>
```

Unlike earlier ephemeral smoke, **do not pass `--no-session`**: it hides this identity mismatch. This smoke covers Scout/launch/Main ownership only, not full lifecycle, live classifier, Worker, Human Gates, or recovery of the operator's previously mismatched workflow. Existing workflow State/Artifacts and operator settings are untouched; release evidence / CHANGELOG / Issue status are unchanged.

## Installed execution-owner follow-up — normal npm installation

A fresh operator session proved that the UUID/file-path correction worked: Scout reads succeeded with `denyExtensions:true`. It still blocked because local-dependency preflight digest `60f7db6a7b720265e201f944ac94949854c33d1f6ec9006cf8b351a9da7ca6c4` differed from installed-owner receipt `2836a5244258aa90455f676484d302664ca420eef0aeb15510551bc5e445702c`. Side-effect-free public preflight reproduced the historical digest exactly. Runtime extension bytes were identical, but path identities differed: local `sha256:9e79f1b024737c87`, installed `sha256:d7cf1cb3f6d46c4d`. The original smoke forced one local copy and therefore did not cover this normal installation condition.

- `subagent-launch.ts` now uses the actual registered `subagent` / `subagents_enable` owner from public Pi `SourceInfo.path` / `baseDir`, the released package's public `./preflight` export, and its supported **0.74.0** version. Missing/conflicting/synthetic owners or unsupported exports fail before dispatch; production never silently falls back to the local copy. No private import, third-party patch, extra dependency or operator configuration change is used. Reading the declared export is necessary because the bundled Pi host's module resolver did not resolve the installed package self-reference via `createRequire`.
- The same selected public API performs initial and model/thinking-pinned preflight. Existing policy validation, durability-before-dispatch, launch revalidation and exact receipt digest checks remain unchanged. Paths/credentials are not added to durable launch projection.
- Main's public `context` hook now supplies transient current ownership/phase and explicit no-retry/no-takeover guidance for **every** model request, including native completion wakes. Startup checks alone did not convey this state to the wake. This explanation is not permission; `tool_call` / `user_bash` remain the enforcement boundary. Only exact owned clarification requests in `clarifying` may use the existing bridge. No stale restriction is retained after terminal release.
- Existing operator Workflow State/Artifacts, global settings, project settings and Jev grant are untouched. Classifier workspace authorization is a separate later prerequisite, not repaired by inference or silent external-data consent.

Focused validation: **6 files / 117 tests PASS**. New cases cover loaded-owner API selection with the role ceiling/profile intact, standalone inspection, missing/conflicting/synthetic owners and missing exports with zero dispatch, request-local gathering/blocked context and removal after terminal release. Final **`VITEST_MAX_WORKERS=1 pnpm check` PASS — typecheck / lint / format / 67 files / 954 tests**, 2026-10-06 10:22:48 JST test start, 622.57 seconds, exit 0. Typecheck/lint/format and `git diff --check` were also rechecked after the final documentation updates. No test deadline or safety assertion is relaxed.

Real Pi **PASS**, recorded **2026-10-06T01:16:00.889Z**, new Herdr tab/pane **`wF:t3M` / `wF:p3Z`**, Pi **0.99.1** / pi-subagents **0.74.0**. Disposable user settings declared **`npm:pi-subagents`**; a fixture-only installation symlink used the operator's already-installed npm copy without modifying it or global settings. Production `/wf-new` in a persisted session dispatched the real product Scout once, read both canary files, and matched launch/receipt/status digest `aff21b268929c93858db5367aafaaf8adb7249a66e30dfc81af67a79dd27756d`. Ambient extensions were denied; terminal proof was observed / exit 0; exact full-output recovery succeeded without redispatch; workspace source/log bytes were unchanged. Main received ownership context through the native completion wake and used **zero tools**, with **no fixture prompt workaround**. The captured context was `gathering-context` at request time; the driver subsequently persisted the expected no-classifier-grant `operator-attention-required` block. The audit binds context to the exact workflow rather than incorrectly requiring its request-time phase to equal the later final phase. Raw report: `/tmp/pi-orchestrator-installed-owner-verified-smoke.json` (machine-local). Test tabs closed and temporary auth/package symlinks removed.

Initial real-host attempts exposed bundled-host `createRequire` resolution failure (proven **not-dispatched**), a startup-section hint that did not reach the native wake, and an over-strict audit phase expectation. These were not reported as PASS; the final public-export lookup, per-request context and fresh smoke above validate the corrected paths. Recovery of the first disposable non-dispatched attempt used normal `/wf-resume`; no unknown Worker or operator workflow was retried. An interim all-suite run hit the existing 5-second Human Code Feedback E2E timeout (953 passed / 1 failed), followed by a cleanup `ENOTEMPTY` while its timed-out operation was still writing. That run was not counted as PASS. The exact test passed unchanged in focused revalidation (**1 passed / 41 skipped**, 5.08 seconds including startup), and the final complete check passed **954/954** above, without widening that deadline.

### Installed-owner smoke reproduction

Use the same disposable Diagnosis fixture, add `npm:pi-subagents` to its user `packages`, and link the existing installed npm package into `<fixture-agentDir>/npm/node_modules/pi-subagents` only for this isolated installation. Do not copy credentials or add AGENTS/prompt suppression. Keep the persisted-session, model and no-classifier-grant settings above. Start a new Herdr tab as above, but let normal package discovery load pi-subagents:

```sh
herdr agent start installed-owner-verified --kind pi --pane <returned-paneId> -- \
  --no-approve --no-skills --no-prompt-templates --session-dir <fixture-root>/sessions \
  -e <repo>/src/index.ts -e <repo>/tests/platform/launch-ownership-smoke-extension.ts \
  --model openai/gpt-6.1-sol --thinking low
# No --no-extensions and no -e <repo>/node_modules/pi-subagents.
herdr agent prompt installed-owner-verified \
  '/wf-new Read-only evidence only: read cache.ts and failure.log, cite contents/lines, no writes/commands/approval, Scout under 1500 characters.'
# After native Scout completion / Main settlement:
herdr agent prompt installed-owner-verified \
  '/launch-ownership-audit /tmp/pi-orchestrator-installed-owner-verified-smoke.json'
```

Verify `status:passed`, matching digests, terminal proof, `ownerSource.source:npm:pi-subagents`, `mainToolCalls:0` and `fixturePromptWorkaround:false`, then close only this test tab and remove its temporary auth/package symlinks. Full classifier/Worker/Human Gate lifecycle and automatic adoption of old mismatched attempts are not claimed.
