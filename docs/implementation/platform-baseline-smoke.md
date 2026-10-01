# Issue #18 — released platform baseline verification

これは **#18 の platform/adapter 検証記録**。v1 runtime 全体、#21 launch authority、#20 Codemode、#12 production lifecycle の完了・release PASS ではない。過去の v0.1.0 release evidence / CHANGELOG は変更しない。

## Prerequisite / selected scope

GitHub #18 / #13 / #3 と各 comments を確認（comments なし）。前提 #3 は CLOSED。#21 / #19 は #18 後、#20 は #21 後の実装であり、本変更では先行実装しない。

- Pi は peer/runtime host のまま、[Pi package の公開契約](https://pi.dev/docs/latest/packages#declare-dependencies)に従い peer range は `"*"`。production minimum `>=0.99.1` は README/canonical requirements に記載し、dev dependency `^0.99.1` / lockfile verification は 0.99.1。
- pi-subagents 0.74.0 は公開契約テスト用 dev dependency。production host は pi-subagents を別途 load する。`preflight` は公開 subpath のみ使用し、現行 product adapter は single-agent async RPC のまま。pnpm が要求する `minimumReleaseAgeExclude` は Issue で指定された released **0.74.0 のみ**に限定（公開 2026-09-30T18:04:26Z、検証時は age cutoff 内）。他の release/provenance/integrity/build policy は緩和しない。
- pi-typesafe 0.8.1 は #19 までの transitional runtime dependency。default TypeSafe backend のみ対応。custom `jev.endpoint` は設定・adapter の双方で client creation/dispatch 前に拒否する。
- Pi/pi-subagents の trust loader は変更・再実装しない。Agent discovery に限り、host `isProjectTrusted()` の結果を公開 `agentScope` に反映する。trusted は `both`、untrusted/unknown は `user`。

### Agent discovery の確認結果

最初の smoke は default `agentScope:both` で untrusted project の `subagents.agentOverrides` を読んで失敗した。native child の resource trust 継承だけでは Agent discovery は制限されない。公開 `agentScope:user` に修正した後、project の model/tool override と trust-gated resources の混入を拒否できた。third-party package は変更していない。

## Automated validation

| Validation | Result |
| --- | --- |
| focused Jev/configuration tests | PASS — 3 files / 33 tests |
| focused platform/package/subagent contracts | PASS — 4 files / 45 tests（composition/failure regressions 追加前） |
| `VITEST_MAX_WORKERS=4 pnpm check` | PASS — typecheck / lint / format / 44 files, 545 tests |
| lockfile versions | Pi 0.99.1 / pi-ai 0.99.1 / pi-subagents 0.74.0 / pi-typesafe 0.8.1 |

Default worker count の `pnpm check` は 120 秒・360 秒の実行 window 内に完了しなかった。test omission や script/config 変更はせず、Vitest の `VITEST_MAX_WORKERS=4` で同じ全 suite を実行し、92.66 秒で PASS。通常 test script は変更していない。

`tests/platform/preflight.test.ts` は released preflight v3 の Agent/source/definition digest、model/thinking、explicit skills、effective tools、inheritance、package/lifecycle identity、model-change digest、missing-skill failure、launch-state side-effect absence を検証する。#21 の product-side persistence/freshness enforcement の代替ではない。

`jev.test.ts` は pi-typesafe 0.8.1 の実 client/ask/choice と injected HTTP transport を使い、default URL、fixture Authorization header、三つの decision families、schema/auth/error/retry/accounting を検証する。custom host/path/HTTP/credential/query/fragment は client/fetch を一度も呼ばず拒否する。

既存 recovery/fault tests と追加 single-agent `failureKind`/stopped/interrupted/detached tests により、truncation・timeout・stop・receipt mismatch が completion/authority に昇格しないことを確認した。workflow-script execution は採用しないため workflow-only `failureKind` を要求・生成しない。

## Real Pi / Herdr smoke

Recorded: **2026-10-01T15:30:43.858Z**。

| Fact | Observed |
| --- | --- |
| Pi host `VERSION` | **0.99.1** |
| pi-subagents public preflight package identity | **0.74.0**（同じ checkout の locked package を明示 load） |
| pi-typesafe package | **0.8.1** |
| Pi process Node | v24.3.0 |
| public launch contract / lifecycle artifact | v3 / v3 |
| Herdr new tab / pane / Agent | `wF:t25` / `wF:p2F` / `issue18-final` |
| raw local report | `/tmp/pi-orchestrator-issue18-final-smoke.json` |
| model | `platform-smoke/probe` — test-only offline provider、network/billed model request なし |

本物の Pi TUI / pi-subagents native background child / public RPC / status / full-output files / orchestrator adapter を使用。model transport だけは公開 provider API による deterministic offline fixture。fake child execution や fake lifecycle artifacts ではない。

| Child assertion | `platform-inherited` | `platform-isolated` |
| --- | --- | --- |
| child `projectTrusted` | false | false |
| explicit private `platform-selected` skill | present | present |
| inherited user skill | present（positive control） | absent |
| extension-added skill | present（positive control） | absent |
| untrusted project skill | absent | absent |
| project SYSTEM/APPEND/template injection | absent | absent |
| untrusted project model/tool override | excluded | excluded |
| registered tools | read, contact_supervisor | read, contact_supervisor |
| edit/write/bash/codemode/subagent | absent | absent |
| canonical output / historical receipt recovery | exact match | exact match |

Project extension canary は存在しなかった。子 task `/project-prompt` も untrusted `.pi/prompts/project-prompt.md` に展開されなかった。explicit skill は残り、`inheritSkills:false` で user/extension-added catalog が除外された。TDD Worker の routing/authority 自体は #16/#21 が実装する。

Public receipt identities:

| Child | Run ID | launchContractDigest |
| --- | --- | --- |
| inherited | `03103cbf-80d2-449a-bbc0-8bf53ea70ad9` | `2820a7850789c4640c694295c3849050b66c9df4fd60505182f38f7a0502b89e` |
| isolated | `a96cdb62-dab9-498a-9494-551d91cc896d` | `494109b9d67e6086e7276da79036751557338d90539e2e4cf47801785cbb7b8e` |

Receipt は `onStarted` で保存し、live acceptance と `status(runId, receipt)` が同じ canonical file を読めることを assert。display text は authority にしない。tmux/direct Pi spawn は使用していない。成功 tab は検証後 close。

## Reproduction

Herdr-managed pane 内で、lockfile dependencies を install 済み、Pi CLI 0.99.1 を選択する。以下の fixture は temporary directory だけを書き、operator の settings/auth/trust は変更しない。

```sh
pnpm install --frozen-lockfile
pnpm test tests/platform/preflight.test.ts tests/runtime/integrations/jev.test.ts
VITEST_MAX_WORKERS=4 pnpm check

node --experimental-strip-types --input-type=module -e \
  'import { platformFixture } from "./tests/platform/fixtures.ts"; console.log(JSON.stringify(await platformFixture()))'

# 上で返された agentDir を使う。tab/pane ID は各 JSON response から取得する。
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd "$PWD" \
  --label issue18-platform --env PI_CODING_AGENT_DIR=<returned-agentDir> --no-focus
herdr agent start issue18-platform --kind pi --pane <returned-paneId> -- \
  --no-approve --no-session --no-extensions --no-skills --no-prompt-templates \
  -e ./node_modules/pi-subagents -e ./src/index.ts \
  -e ./tests/platform/probe-provider.ts -e ./tests/platform/smoke-extension.ts \
  --model platform-smoke/probe
herdr agent prompt issue18-platform '/platform-smoke /tmp/issue18-platform.json'
herdr agent read issue18-platform --source visible --lines 100
```

Command-only work は Herdr の semantic state を変えないことがあるため、`prompt --wait` の stalled/idle 判定を smoke 成否に使わない。report file の `status:passed` と version/assertion/receipt を確認する。成功後、作成した tab のみ `herdr tab close <returned-tabId>` で close。fixture root の片付けは child terminal 確認後に行う。

## Coverage / limitations

#18 の baseline metadata/lockfile、released single-agent RPC/lifecycle v3、#21 public preflight compatibility、trust/skill isolation、Codemode 非先行 enablement、mode-specific failure semantics、fail-closed output/stop/timeout/recovery、transitional direct Jev と credential destination safety、exact-version real Herdr smoke を検証した。

未実施/後続 scope:

- live TypeSafe service/authentication/billed Jev call（本 Issue は実 public client の offline HTTP contract test）。native classifier/live transport 移行は #19。
- every-launch durable preflight/freshness、TDD Worker、Oracle restrictions は #21/#16/#17。
- actual read-only Codemode enablement・models namespace isolation は #20。現行 product Agent definitions で Codemode を有効にしない。
- actual Human Gates、redesigned normal lifecycle、Git/non-Git production scenarios は #12 と前提 child Issues。
- project trust は OS sandbox ではない。AGENTS/CLAUDE context と startup sessionDir の例外は canonical design のまま。
