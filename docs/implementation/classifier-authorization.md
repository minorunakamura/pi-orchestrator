# Issue #11 — Generated-workflow classifier authorization

## Scope / prerequisites

[Issue #11](https://github.com/minorunakamura/pi-orchestrator/issues/11) の6 acceptance criteria と、[tracking #13](https://github.com/minorunakamura/pi-orchestrator/issues/13) の依存順序に従う実装記録。着手時に #11 の全文（comments なし）、#13 の本文・全 comments、AGENTS.md、canonical Configuration / Decision Engine / Runtime / Domain Model / Persistence / Test Strategy と現行 callers を確認した。

前提の #3 / #18 / #19 / #21、および推奨順序上の #4 / #6 / #7 / #8 は **CLOSED**。Pi native classifier transport は #19 の既存公開 API をそのまま使い、第三者 package / dependency / private API は変更していない。#13 / release evidence / CHANGELOG は更新・close しない。

## Implemented contract

### Operator grant vs durable consent

Settings は既存の `piOrchestrator.jev.runtimePolicy` 内の `{ maxRequests, grant }`。grant は `id / policyVersion / active / projectRoot / destination / evidenceCategories` を明示し、workflow ID を含まない。[設定例・trust・移行制限](../basic-design/configuration.md#6-operatorproject-grant-vs-workflow-consent-11) を参照。

- `createWorkflow()` は従来どおり UUID、Task、initial State を生成・保存する。
- 最初の authorized classifier boundary で `JevAuthorization.assertAllowed()` が current operator grant を検証し、immutable `decisions/jev-authorization.json`（kind `jev-request`）を保存する。
- Authorization は grant ID/version、consent ID、exact workflow ID、canonical project `realpath`、classifier provider/model/destination、explicit categories と finite request allowance を bind する。Absolute path の aliases は同じ canonical scope として扱う。
- `jevUsage.authorizationRef` を CAS State に保存した後だけ、各 request の immutable reservation → CAS counter/ref → Pi native classify を許可する。Reservation と usage は authorizationRef / grantId / consentId を記録する。
- State/Artifact authority は Orchestrator 所有。Consent は source mutation、Plan/Code approval、Fix authority を与えない。

### Bounds / freshness / restart

- Actual request categories は **current grant と captured consent の両方**の subset。Attempts は両 maxRequests の小さい方を超えない。設定を拡張しても既存 consent を拡張しない。縮小/revocation は validation 時に適用する。
- `maxRequests` は non-negative safe integer。0 は dispatch 不可。Missing/unknown/exhausted budget、counter/latest reservation/hash の不整合は fail closed。
- Per-finding / explicit transport retry はそれぞれ reservation を必要とし、timeout は charged のまま。Client/runtime recreation と `/wf-resume` は authorizationRef、counters、predecessor reservation を再利用し、reset/refund/rebind しない。
- Cached planning/routing decisions と recovered finding/round decisions は active exact consent/accounting を別途検証する。Reuse は新規 binding を作らず、request を消費しない。Allowance exhaustion だけを理由に zero-request の fresh reuse は拒否しない。
- Classifier provider/model 変更は既存 decision freshness と consent の両境界で拒否する。Grant ID/version / project / destination drift も自動 rebinding しない。
- Credentials、model lookup success、`/typesafe enable`、confidence、Human Plan approval は Product Runtime consent の代替ではない。Pi native `maxRetries: 0`、finite deadline と既存 confidence / deterministic overrides / mandatory Human Gates は維持する。

### Fail-closed migration / persistence

旧 `runtimePolicy.consent` と `grant.workflowId` / wildcard evidence categories は拒否し、future UUID 用の旧設定を暗黙変換しない。Historical spent attempts に authorizationRef がなければ fresh budget を作らない。Missing legacy scope/accounting は permission ではない。

Authorization/reservation の Artifact write、State save/CAS、hash/schema/reference 検証が失敗したら downstream requests は0。Output-before-State や orphan collision を成功と扱わず、immutable authority/accounting を上書き・blind retry しない。自動 migration / orphan repair / consent renewal UI は本 Issue の要求ではなく、明示 operator reconciliation 待ちとして停止する。

## Acceptance criteria coverage

| #11 acceptance criterion | Implementation / executable evidence |
| --- | --- |
| Configure Jev before `/wf-*` without future UUID | `runtimePolicy.grant` に workflowId なし。Generated UUID unit test、production command runtime test（従来の observed ID injection を削除）、real Pi smoke |
| Exact workflow consent before first request | Immutable authorization → CAS authorizationRef → reservation → CAS counter/ref。Native classify 直前に exact binding を assert、保存失敗では0 calls |
| Destination/categories/budget never exceed operator policy | Current grant と captured ceiling の intersection。Mismatch、widening/narrowing、canonical scope、finite safe budget の tests |
| Resume/client recreation cannot reset consent/accounting | StateStore reload、same authorizationRef、per-finding/retry/timeouts、concurrent attempts、orphan/CAS failures。Full fake recovery suite と live recreated adapter の exhaustion |
| Pi native migration preserves workflow consent | Existing native adapter only。Revoked consent は credentials があっても0 calls、reservation-before-classify、no retry/fallback。Live Pi 0.99.1 / typesafe/jev-latest |
| Changed classifier invalidates stale authorization/decision reuse | Provider/model の grant-matched drift、copied/tampered binding、cached planning drift tests。Existing coding freshness/authority tests と explicit reuse authorization validation |

## Automated validation

- Final focused run: **PASS — 5 files / 100 tests**（grant schema/trust、generated consent / scope / bounds / persistence、cached planning consent、production command composition）。Coding / start / recovery の focused run は **4 files / 84 tests PASS**。途中の失敗を PASS と扱わず、canonical path alias（macOS `/var` vs `/private/var`）の取り扱いと、Plan 後の revocation fixture を修正した。Assertions/timeouts は緩めていない。
- `VITEST_MAX_WORKERS=2 pnpm check`: **PASS — typecheck / lint（warnings なし）/ format / 53 files / 724 tests**。
- `git diff --check`: **PASS**。
- Updated Markdown の local paths/anchors: **109件 PASS**。Final `pnpm format:check` / `git diff --check` も **PASS**。

## Real Pi smoke

User が本作業中に **現在の project / typesafe/jev-latest / synthetic task evidence only / 最大1 request / retries なし**を明示許可した。Repository contents、Scout/Worker、Human Gate approval は送信・実行しない。

| Evidence | Result |
| --- | --- |
| Pi / classifier | **0.99.1** / **typesafe/jev-latest**、actual native classify |
| Herdr new tab / pane / Agent | **wF:t2M / wF:p2Y / issue11-classifier** |
| Generated workflow ID | `f729636f-c96d-46bb-83b0-7dad713033e4` |
| Report / observedAt | `/tmp/pi-orchestrator-issue11-live-smoke.json` / **2026-10-03T08:07:35.682Z** |
| Actual requests | **1**、preconfigured grant、`task` only、allowance 1、`maxRetries:0` |
| Decision | SKIP / confidence **0.95**、probabilities RUN 0.03 / SKIP 0.97 / ESCALATE 0 |
| Safe usage | input **619** / output **42** tokens |
| Authorization SHA-256 | `56fe3c52f665f26f52eb1a2dff56d1755f8e0bb070df59382a148712aee35488` |
| Reservation SHA-256 | `a4724e433e1277b6641af8ab31be8e0ade10a7bd6a18ebf24169fd86eadf680d` |
| Result SHA-256 | `3cc8afb6b918ea1f8749ab6f04d63cd22e40dcb0dffed72a2b87600735d49413` |

Grant を UUID 生成前に構築し、production `createWorkflow()` と real StateStore/ArtifactStore/JevAuthorization/native adapter を使用した。Actual classify wrapper は durable consent と reservation の exact workflow/project/destination/category/budget/ref を request 直前に assert。Revoked grant は0 calls、adapter と authorization の再作成後も同じ workflow の exhausted budget は0追加 calls。Full validated probabilities/confidence を durable usage に保存した。

Report の3 Artifact hashes、authorization/reservation/grant/consent links、State counter/ref、approval/implementation authority 不在を別途 audit し **PASS**。Workflow phase は `gathering-context` のまま。Successful smoke 後に作成した tab のみ close。tmux / direct Pi spawn / third-party modifications なし。

Host は project-untrusted のままで `.pi` resources を読み込まない。Explicit operator smoke command の grant を使うため、untrusted project settings から権限を取得した証明ではない。Main chat model は offline `platform-smoke/probe`、classifier は actual live service。これは consent/native integration smoke であり、normal full lifecycle / actual Human Plan・Code Gates / child execution の PASS ではない。

### Reproduction

Live request は別途 explicit operator consent があるときだけ行う。失敗時の reservation を refund したり、元の1件許可で別 workflow の request を追加しない。

```sh
VITEST_MAX_WORKERS=2 pnpm check

herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd "$PWD" \
  --label issue11-classifier --no-focus
# Use returned root_pane.pane_id.
herdr agent start issue11-classifier --kind pi --pane <returned-pane-id> -- \
  --no-approve --no-session --no-extensions --no-skills --no-prompt-templates \
  -e ./tests/platform/probe-provider.ts \
  -e ./tests/platform/classifier-smoke-extension.ts --model platform-smoke/probe
herdr agent prompt issue11-classifier '/classifier-preflight'
# Read /tmp/pi-orchestrator-issue19-preflight.json: modelPresent/authConfigured only.
herdr agent prompt issue11-classifier '/classifier-smoke /tmp/issue11-classifier-report.json'
# Verify report and immutable evidence, not just agent idle status.
herdr tab close <returned-tab-id>
```

## Remaining boundaries

#11 の generated-ID consent と required validation の範囲は上記。Configured grant は command/runtime configuration snapshot であり、settings file を watch して in-flight workflow を即時停止する仕組みは追加していない。変更後の command/recreated runtime または変更された current configuration で再検証する。

Legacy/orphan authority は explicit reconciliation 待ちで停止する仕様上の制限。Grant renewal、budget increase や classifier switch を既存 binding の上書きとして許可しない。

Development Method wiring は #16、Plan simplicity/strategy は #14/#15、general ownership は #5、read-only child Codemode isolation は #20、non-Git / synchronous Code corrections は #10/#9、integrated production lifecycle / actual Human Gates は #12。これらは #11 を満たすための scope 拡張や未所有の残件ではない。Full v1 production readiness / release PASS は主張しない。
