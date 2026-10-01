# Dependency Public Contract Review

対象: Issue #3 の v1 target design。これは **依存仕様の静的レビュー結果**であり、release evidence / runtime contract test / real Pi smoke の PASS ではない。

## 1. Method / exact sources

設計で利用・保証を前提にする API、resource loading、trust、capability、output/recovery を、下記の immutable released package docs / exported declarations と照合した。必要な場合は同じ公開 release に同梱された実装を読み、default behavior を確認したが、runtime が内部 module を import する設計にはしていない。

npm tarballs は npm dist metadata の SHA-512 integrity と照合してから一時 directory に展開した。インストール、dependency 改変、Pi 起動、billable classifier call は行っていない。

| Source ID | Reviewed source | Status |
| --- | --- | --- |
| P | [@earendil-works/pi-coding-agent 0.99.1](https://unpkg.com/@earendil-works/pi-coding-agent@0.99.1/package.json), packaged docs and root-exported declarations | released / integrity verified |
| A | [@earendil-works/pi-ai 0.99.1](https://unpkg.com/@earendil-works/pi-ai@0.99.1/package.json), exported classifier/model options | released / integrity verified; Pi's dependency range allows newer versions, production must record actual resolved version |
| S | [pi-subagents 0.74.0](https://unpkg.com/pi-subagents@0.74.0/package.json), public preflight/capability/API/docs | released / integrity verified |
| T | [pi-typesafe 0.8.1](https://unpkg.com/pi-typesafe@0.8.1/package.json), library/backend exports | released / integrity verified; transitional only |
| L | [@plannotator/pi-extension 0.27.23](https://unpkg.com/@plannotator/pi-extension@0.27.23/package.json), public event API | released / integrity verified; reviewed reference, not a silently raised minimum |
| K | [minorunakamura/pi-ketch e49fd9ea48b675eef2ede729c9f13f7e12d44c20](https://github.com/minorunakamura/pi-ketch/tree/e49fd9ea48b675eef2ede729c9f13f7e12d44c20) | public Git snapshot only; no tag/release confirmed at review time |
| Q | [minorunakamura/pi-ask-user-question 0a6ad2c5fd7f79ceccb51bc791c10554789bdbd2](https://github.com/minorunakamura/pi-ask-user-question/tree/0a6ad2c5fd7f79ceccb51bc791c10554789bdbd2) | public Git snapshot only; no tag/release confirmed at review time |
| M | [mattpocock/skills v1.2.3](https://github.com/mattpocock/skills/tree/v1.2.3), commit 6acc160e4e0cd062dbbbd7a1b26ae92855edf07e | released skill definitions |

K/Q の package.json の version は両方 1.0.0 だが、それだけでは同名 npm package / compatible release の identity を証明しない。Pi は pinned Git commit を public package source としてサポートするが、今回の診断用 snapshot を黙って production source に選定したわけではない。Release/tag または明示承認された immutable Git distribution を確認し、selected contract/source を固定するまで released-baseline 適合を PASS としない。

比較のため npm pi-ketch 0.1.6 / pi-ask-user-question 1.0.0 の tarball も integrity 検証して読んだが、**想定 GitHub package の代替ではない**。前者は別 repository の CLI tool package、後者は skidvis の askUserQuestion（camelCase、別 schema/取消 semantics/legacy peers）である。名前だけで依存を resolve しない。

## 2. Contract matrix

判定: **確認** = reviewed release に public seam がある。**条件付き** = Orchestrator enforcement/host evidence が必要。**公開版未確定** = snapshot は読めるが intended production publication/source は未確定。いずれも実行互換性の PASS ではない。

| ID | Design assumption / released fact | Evidence | Result / implementation obligation |
| --- | --- | --- | --- |
| C01 | Native classifier is accessible from extensions without Codemode | P model-registry.d.ts: findOfType / classify; P models.md | 確認。Default typesafe/jev-latest。Missing model/auth must normalize safely |
| C02 | Native choice/bool/score shapes | A types.d.ts: ClassifierQuestion/Answer/Result | 修正済み。Choice probabilities/confidence、Score score/confidence only、Bool probability only; instructions are strings. Use Yes/No Choice for domain Boolean confidence |
| C03 | Classifier service failure is not necessarily a rejected Promise | P ModelRegistry.classify declares Never rejects; A stopReason stop/error/aborted | 修正済み。Require stop + complete valid answers; error/aborted never authorizes a decision |
| C04 | One native call need not equal one outbound attempt by default | A ProviderRequestOptions.maxRetries; released System One transport uses default 2 retries | 修正済み。Pass maxRetries:0 + finite signal/deadline; explicit Orchestrator retries reserve separately (#19/#11). Don't rely on catch alone |
| C05 | Pi supplies host SDK/typebox and package roots are separate | P packages.md / package exports | 確認。Host peer only; separate installed Pi package is not an automatically resolvable dependency/shared module instance |
| C06 | Settings/trust inheritance is not complete resource isolation | P security.md/configuration.md; S 0.74.0 CHANGELOG | 修正済み。Trust-gated .pi resources skipped when untrusted; sessionDir read before trust; AGENTS/CLAUDE context is not trust-gated. Explicit inheritProjectContext policy handles context |
| C07 | Model-mediated direct/nested/MCP tool calls pass hooks | P extensions.md: tool_call / ctx.executeTool; MCP permissions | 条件付き。active tools != callable tools. tool_call handlers can mutate inputs in registration order without automatic revalidation; check effective execution inputs, not an earlier allowance. Direct trusted extension pi.exec/fs is not universally hooked/OS-sandboxed; deny unknown mutation providers, detect drift (#5) |
| C08 | Public async single-agent RPC remains available | S extension-api.md: spawn; public request/reply/ping/events | 確認。agent/task single-child path async-only; removed workflowScript fields are not used. Lifecycle stays Orchestrator-owned |
| C09 | Public preflight resolves ordinary launch without launch-state writes | S public preflight declarations / extension-api.md; version 3 | 確認。Bind actual selected Agent/model/thinking/skills/tools/inheritance/versions/digests; no child session/temp prompt/run artifacts during resolution |
| C10 | ok:true is not full runtime attestation | S contract diagnostics/tools; documented host_required and digest exclusions | 修正済み。Need real host snapshots/capability comparison/provider startup checks. No projectTrusted input; no guaranteed skill-body/input-file hash. definition/launch digest ≠ complete external evidence hash |
| C11 | Dispatch thinking differs from preflight/delegation thinking | S tool-reference.md model field; public preflight/delegation declarations | 修正済み。Single-agent RPC uses provider/id:level suffix. Model-facing thinking field is ignored on dispatch. Supply consistent scopedModelIds/parentModel/availableModels/bridge inputs |
| C12 | Capability ceiling can narrow builtin/extension/MCP and nesting | S capability-ceiling public export / extension-api.md | 条件付き。Session-scoped intersection, monotonic inheritance, denyExtensions. Not a sandbox for malicious loaded code; don't trust acceptanceRole/prompts as permission enforcement |
| C13 | Builtin Worker isolates skills, explicit selection is supported | S agents/worker.md; agents.md skills/skill and inheritSkills:false | 確認。tdd explicitly selected via public skill; required missing skills deny. Builtin defaultReads context.md/plan.md and defaultProgress must also be disabled or scope-bound through supported contracts, not become extra authority. Catalog presence is not proof skill instructions were followed (#16/#21) |
| C14 | Builtin Oracle is advisory but includes bash/default fork | S agents/oracle.md: tools/defaultContext/inheritSkills | 修正済み。Narrow tools via public ceiling/overrides; deny unrestricted bash. Explicit fresh + supplied durable inputs/finite consultation. No builtin-file patch or authority handoff (#17) |
| C15 | Native child Codemode exists when allowed | S agents.md / 0.74.0 CHANGELOG; P createCodemodeExtension public export | 条件付き。denyExtensions:true prevents automatic Codemode registration. Initial #20 roles Scout/simplicity only, optional correctness/ponytail; no Oracle/Research/Worker expansion |
| C16 | Codemode model-only controls are not script-callable | S 0.74.0 CHANGELOG; P exposure contract | 確認。subagent/supervisor/structured_output controls cannot be re-exposed through scripts; callable deferred tools still need ceiling |
| C17 | Codemode models namespace is separate from tool allowlist | P createCodemodeExtension options.models default true, official SDK replacement contract | 修正済み・条件付き。models.classify otherwise bypasses workflow reservations. Disable via official factory models:false in an Orchestrator-owned child extension using public loading/replacement; prove isolation/actual loading or keep Codemode disabled (#20/#21) |
| C18 | Codemode does not have a trusted default hard script deadline | P cli.md: timeout_ms unset; max_output_tokens defaults 10000 and can be supplied by model | 修正済み。Finite public child/toolTimeoutMs and output-acceptance bounds outside model hints; full-output provenance required |
| C19 | Completion/status/display/process termination are distinct | S observability.md public lifecycle and process-terminal proof | 確認。Status/receipt/output identity required; display truncation, stop request, timeout, PID disappearance/result existence not terminal proof. Private process-terminal-candidate is not authority |
| C20 | Workflow failureKind is mode-specific | S 0.73/0.74 CHANGELOG and workflow contracts | 確認。Use only when selected mode exposes it, don't fabricate workflow fields for single-agent results |
| C21 | Plan Gate async, Code Gate synchronous with callback envelope | L plannotator-events.ts / README | 確認。Plan pending/reviewId + result/status; Code settled approved/feedback/annotations (+ optional agentSwitch), no external Code polling; local pre-request attempt/source binds result (#9) |
| C22 | Static non-Git patchFile is public and mutually exclusive with prUrl | L CodeReviewPayload / README | 確認。Relative path resolved from cwd; Orchestrator owns immutable patch/baseline/content/hash before call (#10) |
| C23 | Shared plan-review differs from native Plannotator execution mode | L public event handler / README external execution handoff | 修正済み。Shared event path review-only; executionMode:external applies when integrating native plan-mode/submit-plan handoff. SavedPath/switch/permission metadata is not authority |
| C24 | Transitional library API, backend-specific credentials, no default retry | T client/ask/backends public declarations / README | 確認。createTypeSafe/ask/choice/noul/score public; ask returns ok:false; client evaluate may throw. BackendEndpoint requires own keyEnv (not TYPESAFE_API_KEY). Preserve own reservations; no rewritten-host credential forwarding (#18) |
| C25 | Research Agent/source/CLI tool providers | K README/package/agents/researcher.md; S package-agent discovery | 公開版未確定。GitHub package supplies pi-ketch.researcher + subagentOnlyExtensions for ketch tools; external ketch executable/config/backend capabilities are separate requirements. Same-name npm lacks that contract |
| C26 | Root structured Human UI and cancellation | Q README / public src/api.ts | 公開版未確定。Same-process request/reply/cancel, TUI-only; answered vs user-cancelled/caller-aborted/shutdown; duplicate normalized question rejected. No guessed answer on missing UI/cancel or same-name npm fallback (#8) |
| C27 | Wrapper/direct skills preserve intended product semantics | M grill-me/grill-with-docs/grilling/domain-modeling/tdd/codebase-design SKILL.md | 確認。Wrappers disable-model-invocation:true; underlying skills may be selected. Grilling requires final Human shared-understanding confirmation; docs-write allowlist imposed by Orchestrator; TDD tests only confirmed seams, vertical RED/minimal GREEN |

## 3. Important corrections / follow-up ownership

- **#19/#11**: hidden native retries were not explicit in design. maxRetries:0 / stopReason validation are now canonical; every explicit retry reserved before dispatch。
- **#21**: preflight means resolved intent, not child runtime/trust/skill-byte attestation. Public import must resolve to compatible execution owner/version, actual receipt/provider checks still required. Avoid unsupported per-RPC thinking/inheritance fields。
- **#17**: builtin Oracle bash/fork defaults are not an enforced read-only fresh launch. Narrow publicly, retain builtin identity, supply bounded inputs。
- **#20**: tool ceiling alone cannot prevent models.classify. Official factory models:false + supported replacement exists, but its actual child loading/provenance/enforcement must be proven before enablement. No silent adoption for roles outside #20。
- **#5/#8**: trust/context and tool-hook/OS boundaries are explicit. Grilling completion includes Human confirmation; root UI capability/cancel cannot become invented consent。
- **#9/#10**: released Plannotator confirms async Plan/sync Code/static patch. Correct distinction between shared review-only event path and external native handoff。
- **K/Q production prerequisites**: intended repository/source identity, compatible immutable published distribution and runtime provider availability remain unresolved. Existing Research/#8/platform/production integration work must settle them; no new alternate package or third-party modifications were introduced。

## 4. Verification performed / not performed

Performed:

- Five primary released npm packages (P/A/S/T/L) plus two rejected same-name npm comparisons downloaded/read with SHA-512 integrity verification; selected Git snapshots and released skill tag inspected。
- Public export/signature/field/version evidence checks and manual contract-by-contract comparison; document fixes above。
- Internal document link/anchor/State/Event/Artifact/matrix checks; git diff --check; existing pnpm check (results reported with the review delivery)。

Not performed / not proven:

- No Pi process/Herdr smoke, actual browser/Human Gate or billed native classifier invocation。
- No execution of dependency code to prove runtime replacement, trust/isolation/provider registration or shutdown/recovery race behavior。
- Existing pnpm check still runs the existing code/dependency lock, not v1 target platform; static reference checks are not contract tests。
- K/Q released-baseline selection remains incomplete. A no-findings / full dependency-conformance PASS or redesigned-runtime completion is **not** claimed。

## 5. Reproducible public references

Release-specific sources (not moving main):

- [P exported API](https://unpkg.com/@earendil-works/pi-coding-agent@0.99.1/dist/index.d.ts), [ModelRegistry](https://unpkg.com/@earendil-works/pi-coding-agent@0.99.1/dist/core/model-registry.d.ts), [Codemode options](https://unpkg.com/@earendil-works/pi-coding-agent@0.99.1/dist/extensions/codemode/index.d.ts)
- [P Security](https://unpkg.com/@earendil-works/pi-coding-agent@0.99.1/docs/security.md), [Extensions](https://unpkg.com/@earendil-works/pi-coding-agent@0.99.1/docs/extensions.md), [Packages](https://unpkg.com/@earendil-works/pi-coding-agent@0.99.1/docs/packages.md), [SDK](https://unpkg.com/@earendil-works/pi-coding-agent@0.99.1/docs/sdk.md), [CLI](https://unpkg.com/@earendil-works/pi-coding-agent@0.99.1/docs/cli.md)
- [A classifier/transport declarations](https://unpkg.com/@earendil-works/pi-ai@0.99.1/dist/types.d.ts), [A Models options](https://unpkg.com/@earendil-works/pi-ai@0.99.1/dist/models.d.ts)
- [S public Extension API](https://unpkg.com/pi-subagents@0.74.0/docs/extension-api.md), [preflight declarations](https://unpkg.com/pi-subagents@0.74.0/src/api/preflight.d.ts), [Agent contracts](https://unpkg.com/pi-subagents@0.74.0/docs/agents.md), [Tool reference](https://unpkg.com/pi-subagents@0.74.0/docs/tool-reference.md), [Observability](https://unpkg.com/pi-subagents@0.74.0/docs/observability.md), [CHANGELOG](https://unpkg.com/pi-subagents@0.74.0/CHANGELOG.md)
- [T client](https://unpkg.com/pi-typesafe@0.8.1/dist/client.d.ts), [ask](https://unpkg.com/pi-typesafe@0.8.1/dist/ask.d.ts), [backends](https://unpkg.com/pi-typesafe@0.8.1/dist/backends.d.ts), [README](https://unpkg.com/pi-typesafe@0.8.1/README.md)
- [L public event contract](https://unpkg.com/@plannotator/pi-extension@0.27.23/plannotator-events.ts), [README](https://unpkg.com/@plannotator/pi-extension@0.27.23/README.md)
- [Q public API snapshot](https://github.com/minorunakamura/pi-ask-user-question/blob/0a6ad2c5fd7f79ceccb51bc791c10554789bdbd2/src/api.ts), [K Agent snapshot](https://github.com/minorunakamura/pi-ketch/blob/e49fd9ea48b675eef2ede729c9f13f7e12d44c20/agents/researcher.md)
- [M grilling](https://github.com/mattpocock/skills/blob/v1.2.3/skills/productivity/grilling/SKILL.md), [M TDD](https://github.com/mattpocock/skills/blob/v1.2.3/skills/engineering/tdd/SKILL.md), [M domain-modeling](https://github.com/mattpocock/skills/blob/v1.2.3/skills/engineering/domain-modeling/SKILL.md)

`npm view <package>@<version> dist --json` provides tarball/integrity metadata; `gh api repos/<owner>/<repo>/tags` and `.../releases` establish publication rather than inferring it from package.json version。Paths in npm contents above are review citations, not permission to import private subpaths; runtime imports use published package exports only。
