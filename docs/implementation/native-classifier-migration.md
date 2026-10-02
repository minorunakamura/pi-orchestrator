# Issue #19 — Pi native classifier migration

これは #19 の transport / authorization / freshness / live classifier 検証記録。v1 lifecycle 全体や #12 の production readiness / release PASS ではない。CHANGELOG と過去の release evidence は変更しない。

## Preparation / scope

- GitHub #19・#13 の本文、acceptance criteria、comments を確認。#19 に comments はない。#13 の recommended order に従う。
- 前提 #3・#18 は CLOSED。並行 foundation #21 も CLOSED。#11 は OPEN であり、生成 UUID 後の operator grant → workflow durable consent は今回実装しない。
- AGENTS.md、Decision Engine、Configuration、Integrations、Runtime / coding / planning design、implementation plan と現行呼び出し経路を確認。
- 既存 production Jev families は Execution Routing / Finding Evaluation / Round Decision。Stage / Clarification Mode / Development Method は native port を提供し、通常 lifecycle 接続と deterministic stage/method policy は #6 / #8 / #16 が所有する。#4 の normal driver も先行実装しない。

## Implemented boundary

```text
runtime-assembled evidence
 -> exact workflow/project/provider-model consent
 -> immutable request reservation + CAS State/counter
 -> DecisionClassifierPort / PiClassifierDecisionClient
 -> active ctx.modelRegistry.findOfType("classifier", provider, model)
 -> ctx.modelRegistry.classify(model, request, { signal, maxRetries: 0 })
 -> exact response identity / stopReason / complete Choice schema
 -> immutable result probabilities/confidence + safe optional usage
 -> normalized domain decisions
 -> existing deterministic core policy / mandatory Human Gates
```

`JevIntegration` は同じ native class の compatibility export。旧 client factory、direct endpoint/backend/fetch rewrite、別 evaluator への fallback はない。Pi が provider/auth transport を所有し、adapter は State / ArtifactStore を読んで判断入力を推測しない。

| Family | Native contract / integration |
| --- | --- |
| Conditional Stage | conditional のみ RUN / SKIP / ESCALATE。required / skip は classifier 呼び出し前に拒否。lifecycle policy は #6 |
| Clarification Mode | SKIP / GRILL_ME / GRILL_WITH_DOCS / ESCALATE。質問・回答・write authority を生成しない。bridge は #8 |
| Development Method | STANDARD / TDD / ESCALATE。明示 Human TDD / eligibility の deterministic precedence と Worker skill wiring は #16 |
| Execution Routing | modelTier と reasoningTier を個別 Choice。既存 production runner 接続 |
| Finding Evaluation | finding ごとの5個の boolean Choice、source ref / exact evidence を保持。既存 production runner 接続 |
| Round Decision | action と escalation reason を別 Choice / confidence として保持。既存 production runner 接続 |

Native Bool probability を confidence に変換しない。Classifier の confidence と選択肢 probability は異なる値でも、そのまま別々に保存する。既存 confidence thresholds、stronger retry floor、Validation / finding completeness / Human decision precedence は変更しない。

## Authorization / freshness / accounting

- `jev.classifier` は `{ provider, model }`、default は明示的に `typesafe/jev-latest`。
- `runtimePolicy.consent.destination` は exact `provider/model`。現行の exact workflow ID / canonical project / active consent / category allowlist / finite maxRequests を維持する。
- Pi authentication/model availability、Human Plan approval、confidence は consent の代替にならない。
- 許可カテゴリに planning evidence 名を追加するが、既存 allowlist は自動拡張しない。
- 各 finding / retry ごとに Artifact → State reservation を先に保存。失敗・timeout の reservation は返却しない。CAS failure / orphan / unknown predecessor / consent または allowance drift は dispatch を拒否する。
- 予約と結果は classifier provider/model、decision schema version、exact request digest（questions / evidence refs を含む）、transport configuration digest に binding。結果に完全な検証済み Choice probabilities/confidence と、provider が返した場合のみ非負の token usage を保存する。
- Execution / Finding（empty findings を含む）/ Round freshness は classifier identity、exact refs/input digest、policy/config digest、Plan version / implementation revision を含む。Finding の freshness verification は Round と reconciliation にも適用する。
- consent はその都度独立に revalidate。credential や grant active 状態を semantic decision confidence と混同しない。旧 classifier identity 欠落 evidence は current authority として再利用しない。
- native `stopReason:error` は retry reason の typed transport code を提供しないため、自動 retry しない。明示 `maxTransportRetries` がある timeout/aborted のみ新規 reservation で同一 classifier を再試行する。Pi 内部 retry は必ず `maxRetries:0`。
- positive finite deadline は signal abort に加え Promise deadline で enforce。provider が signal を無視しても待ち続けず、late result は usage / decision authority に昇格しない。

## Operator configuration migration

旧 `jev.endpoint` と URL destination consent は reject。旧 authorization を新 transport に黙って転用しない。operator が native identity に対する新しい consent を明示設定する。

```json
{
  "jev": {
    "classifier": { "provider": "typesafe", "model": "jev-latest" },
    "timeoutMs": 15000,
    "maxTransportRetries": 0,
    "runtimePolicy": {
      "maxRequests": 10,
      "consent": {
        "id": "operator-issued-consent-id",
        "policyVersion": "project-policy-1",
        "active": true,
        "workflowId": "exact-existing-workflow-id",
        "projectRoot": "/canonical/project/path",
        "destination": "typesafe/jev-latest",
        "evidenceCategories": ["plan", "context", "implementation", "review", "validation", "history"]
      }
    }
  }
}
```

上は `piOrchestrator` settings 内の Jev 部分のみ。credentials は Pi `/login` または provider environment へ設定し、この configuration / Artifact / report に API key を保存しない。生成 workflow ID を事前設定せずに grant できる最終 product UX は #11 が残る。

## Automated validation

| Check | Result |
| --- | --- |
| focused native adapter / durable policy / Phase C E2E | PASS — 3 files / 72 tests（追加 freshness/lookup regressions 前） |
| dependency removal 前の `VITEST_MAX_WORKERS=4 pnpm check` | PASS — typecheck / lint / format / 46 files, 594 tests |
| dependency removal 後の `pnpm install --frozen-lockfile` | PASS |
| final `VITEST_MAX_WORKERS=4 pnpm check` | PASS — typecheck / lint / format / 46 files, 595 tests |
| `git diff --check` | PASS |

Native tests は6 family の public request shape、plain string instructions、個別 Choice / confidence、exact state/ref forwarding、reservation-before-classify、`maxRetries:0`、deadline / late result、missing/partial/wrong Bool/schema/provider/model/API、usage persistence failure、missing usage、auth/lookup failure normalization を検証する。

Durable policy tests は missing/revoked/wrong workflow/project/classifier/categories / exhausted budget のゼロ呼び出し、finding/retry の個別会計、reload/client recreation、CAS race/orphan/save failure、persisted full probabilities/identity/digest を検証する。既存 E2E/Human Gate/Validation/stronger retry regression と追加 classifier/config drift tests も全 suite に含む。

`package.json` / lockfile から pi-typesafe と direct SDK を削除。source/test imports、direct TypeSafe client/endpoint config と pi-typesafe-specific fixtures は残らない。Pi/third-party package の source、private API、patch/fork は変更していない。

## Real Pi / Herdr smoke

| Fact | Observation |
| --- | --- |
| host VERSION | **0.99.1** |
| classifier | **typesafe / jev-latest**, actual live TypeSafe request through Pi ModelRegistry |
| Herdr new tab / pane / Agent | `wF:t29` / `wF:p2K` / `issue19-classifier` |
| first successful live report | `/tmp/pi-orchestrator-issue19-live-smoke.json`, 2026-10-02T02:51:56.734Z |
| post-dependency-removal live report | `/tmp/pi-orchestrator-issue19-post-removal-smoke.json`, **2026-10-02T02:54:54.988Z** |
| post-removal decision | SKIP, **confidence 0.98**, probabilities SKIP 0.99 / RUN 0.01 / ESCALATE 0 |
| safe reported usage | input 616 / output 42 tokens |
| per smoke workflow allowance | 1 request; explicit command consent, no refund/reset |
| post-removal request digest | `968de4baf5cf5031bb4c99e8b8e691c3d9f291bb65533c256e8793beea2e8397` |
| post-removal reservation SHA-256 | `8443ce5587b3f4eb1d175e7881ab797e356c4ba4eba8b4a33a416e355982713b` |
| post-removal result SHA-256 | `da206070789c751d44a83ecfa176d9ea41422d42e018d7004a7283407afee293` |

最初の試行は Pi native authConfigured:false で失敗。report `/tmp/pi-orchestrator-issue19-smoke.json` と reservation を保持し、refund / fallback はしなかった。operator に確認し、operator が Pi stored credential を設定した後、別の明示1件 smoke authorization で成功した。dependency removal は成功を確認した後にのみ実行。その後 reload と別 workflow ID / evidence root の post-removal live smoke も成功。各 smoke workflow 内の authorization context recreation / exhausted allowance は必ずゼロ追加呼び出し。Adapter client 自体の再作成後の budget 維持は automated durable policy test で検証した。

Smoke は synthetic な非機密 task evidence の Conditional Research decision を1件だけ送る。wrapper が actual classify 開始直前に durable reservation / State counter を assert し、戻り値の complete schema/identity と full probabilities/confidence の durable result を検証する。revoked consent は zero classify、同じ workflow に再作成した authorization context も budget exhaustion で zero classify。phase は planning のままであり、Human approval、Worker / filesystem mutation authority は生成しない。

本物の Pi TUI / native registry / request-time stored authentication / provider transport を使用。メイン chat model のみ offline platform probe（command-only smoke なので chat request はしない）。classifier は fake provider/HTTP response ではない。tmux / direct Pi spawn は使わない。検証成功後、作成した tab のみ close。

### Reproduction

```sh
pnpm install --frozen-lockfile
VITEST_MAX_WORKERS=4 pnpm check

# Herdr-managed pane 内。Pi 0.99.1 の TypeSafe credential を事前設定。
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd "$PWD" \
  --label issue19-classifier --no-focus
# returned root_pane.pane_id を使う。
herdr agent start issue19-classifier --kind pi --pane <returned-pane-id> -- \
  --no-approve --no-session --no-extensions --no-skills --no-prompt-templates \
  -e ./tests/platform/probe-provider.ts \
  -e ./tests/platform/classifier-smoke-extension.ts --model platform-smoke/probe
herdr agent prompt issue19-classifier '/classifier-preflight'
# /tmp/pi-orchestrator-issue19-preflight.json で modelPresent/authConfigured を確認。
herdr agent prompt issue19-classifier '/classifier-smoke /tmp/issue19-classifier-report.json'
# command-only idle detection ではなく report status:passed と durable evidence を確認。
herdr tab close <returned-tab-id>
```

`/classifier-smoke` invocation は1件の harmless live request に対する operator consent。credential はチャット/logへ貼らない。each smoke は別 workflow ID / root を作り、失敗履歴・usage は後続 workflow に転用/返却しない。

## Acceptance criteria / remaining boundaries

| #19 criterion | Coverage |
| --- | --- |
| Required Jev families use Pi native | all six port methods; all existing three production callers migrated。Future lifecycle callers #6/#8/#16 use the same port, not another transport |
| Explicit Jev production default | typesafe/jev-latest configuration, registry lookup and live report |
| Existing thresholds / deterministic overrides | unchanged core policies; retained complete regression suite; required/skip classifier dispatch rejected |
| Pi auth cannot bypass workflow consent | exact native destination/project/workflow/category/budget enforcement; live revoked-consent zero-call assertion |
| Reservation before side effects | immutable Artifact → CAS State before every classify/finding/retry; live pre-dispatch assertion |
| Stale classifier/config/evidence rejection | explicit classifier freshness, request/input/policy/config digests/refs/revisions; Finding verification in Round and reconciler |
| No automatic fallback | single adapter; missing registry/provider/auth/schema fail closed; no LLM/direct evaluator path |
| pi-typesafe removed without required behavior loss | dependency/SDK/fixtures removed after live PASS; final whole-suite and post-removal live smoke |
| Real Pi >=0.99.1 live classifier | exact 0.99.1 host, typesafe/jev-latest live decision in new Herdr tab |

残る #4/#6/#8/#11/#16/#12 は transport 移行の欠落を補う新規 scope ではなく、Issue #13 に定義済みの lifecycle / generated authorization / integrated verification。特に #11 完了前に生成 workflow 用 consent UX を production-ready と主張しない。この smoke は full lifecycle・全6 family の live calibration・実 Human Gates の production smoke の代替ではない。
