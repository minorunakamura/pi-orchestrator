# Issue #12 — production integration verification

## Scope and prerequisites

Issue #12 / tracking #13 were read in full, including comments. #3–#11 and #14–#21 were CLOSED at preparation; the working base was `86254e2` (#5). No prerequisite was replaced with a fake success. Canonical authority, normal-driver, launch, clarification, workspace, Gate and recovery contracts remain authoritative.

This record separates **connected production smoke**, **focused real-host smoke**, and **automated scenarios**. A fixture-based classifier/approval/Scout is never described as live. No third-party code, private API, runtime dependency, workflow-script lifecycle, version bump or Issue closure is introduced.

## Changes

- `tests/commands/workflow-commands.test.ts`: one actual command-runtime start from Task through Scout, routing, TDD method, simplicity, exact async Plan result, Worker, independent Validation, both reviewers and synchronous Code approval, for Git and filesystem workspaces. Wrong Plan wake does nothing; `resume()` is never called. The older command recovery test is explicitly recovery of a lost driver, not normal progress.
- `tests/platform/released-owner.test.ts`: load the **released owner** through Pi's public resource loader and inspect its registered public tool schema. Model-facing `workflow` is not RPC `script`; removed `workflowScript` / `workflowScriptPath` are absent. Configuration belongs in the documented `extensions/subagent/config.json`, not an invented `subagents.toolActivation` settings field.
- `production-fixture.ts`, `production-smoke-extension.ts`, `production-audit.ts`: disposable workspaces and isolated settings; unchanged production package/ports; actual native classifier, root questionnaire and Plannotator. Read-only audit recursively checks retained Artifact hashes, exact Plan/Worker/Code bindings, regenerated patch/current workspace, Validation and actual TDD transcript. It cannot resume, dispatch, approve or repair. Negative audit tests reject pending Gates and corrupt history without child calls.
- `host-contract-smoke-extension.ts` and the existing offline provider/fixture: actual released RPC/native children, side-effect-free sibling preflight, explicit skill isolation/trust, large full output, cold model-facing delegation, stop and timeout. Real replies, lifecycle files and process proof are not faked.
- Manifest/lockfile coverage explicitly rejects the removed direct client and old Pi 0.87.1 pins.

### Integration mismatch and authorized correction

The first connected Git run stopped before implementation: native Research returned **ESCALATE / confidence 0.65**, with one reserved request and no Worker. The generic instructions did not distinguish unresolved Human product choices from inability to determine Research necessity. After explicit operator permission, the shared routing boundary was corrected for **all** conditional-stage callers, not just a smoke task:

- Research asks whether external facts are needed; downstream Human choices alone are not external research.
- Clarification RUN means answerable unresolved Human choices; those choices are not alone an ESCALATE reason.
- Architecture asks about architectural boundaries/trade-offs rather than implementation readiness.
- Mode selection distinguishes grilling from unsafe/unavailable mode determination and grants no document authority.

`planningRoutingInstructions` is shared by native requests and `policyDigest`. Old instructions cannot reuse otherwise exact decisions. Required/skip policy, confidence thresholds, ESCALATE, consent/accounting, method/skill/Validation and both Human Gates are unchanged. Contract tests preserve low-confidence/ESCALATE evidence; the legacy exact policy digest (only instructions absent) is blocked with zero reclassification/Planner launch. This is not a universal classifier-accuracy guarantee.

## Connected production smoke

Both runs loaded the production package via its public Pi manifest, with the released dependency owner, pinned question package and installed Plannotator. There were **no fake ports**, scripted stage outputs, substituted Gate results or fabricated Human answers. One `/wf-feature --tdd ...` per workspace drove normal progress; questions and actual Plan results continued the same driver. `/wf-resume` was never used for progress.

Versions: **Pi 0.99.1 / pi-subagents 0.74.0 / Plannotator 0.27.16**. Native classifier: **typesafe/jev-latest**. Question source: `0a6ad2c5fd7f79ceccb51bc791c10554789bdbd2`. Root and children: actual **openai/gpt-6.1-sol**; root thinking medium, Worker thinking low from actual routing. Pi-typesafe is absent after #19; its 0.8.1 transition proof remains [historical baseline evidence](./platform-baseline-smoke.md), not a reinstalled direct transport.

The operator explicitly authorized synthetic-workspace evidence only, **40 requests/workflow maximum, transport retry 0**, and answered the questionnaires/confirmations/Plan/Code UI. Credentials remained Pi-owned. Workspaces were untrusted; explicit public skills and package resources were used.

| Path | Herdr tab / pane / Agent | Final State / audit | Observed behavior |
| --- | --- | --- | --- |
| Git / GRILL_ME / TDD | `wF:t38` / `wF:p3K` / `issue12-git-final` | `212b8ec6-d885-4c67-a35b-3978866546cf`, completed, revision 62; audit 2026-10-04T15:58:36.545Z; **41 immutable refs PASS** | Actual Human behavior/input choices and final confirmation; actual full Plan/Test Seams approval; one Worker; `RED → GREEN → RED → GREEN`; independent `node --test greeting.test.mjs`; actual correctness/Ponytail; actual static-patch Code approval |
| Non-Git / GRILL_WITH_DOCS / TDD | `wF:t39` / `wF:p3M` / `issue12-non-git` | `e885dc63-d984-432e-8e17-2890998dc753`, completed, revision 67; audit 2026-10-04T16:12:03.520Z; **42 immutable refs PASS** | Actual grilling/domain-modeling and confirmed **CONTEXT.md only** creation with before/intent/answer/after/scope/checkpoint refs; actual Plan/Test Seams approval; one Worker; two vertical slices; independent Validation/reviews; actual filesystem-patch Code approval |

Each made **6 live reserved native classifier calls**, not 40. Research SKIP / Clarification RUN / GRILL_ME or GRILL_WITH_DOCS were confidence 1.0 after the correction. TDD selection was explicit/deterministic. Workers selected **`tdd` only**, `inheritSkills:false`, with hash-bound skill bytes and approved seams. The resulting application surface was `greeting.mjs` / `greeting.test.mjs`, plus the Human-confirmed non-Git `CONTEXT.md`. No unrelated source/configuration write was admitted. Worker process-terminal proof was observed / exit 0. All Plan/implementation/review/Validation/Gate refs and current patches were retained.

Initial model attempts to use raw root tools or an empty request hash were denied; they did not create answers or writes. The queued durable clarification prompt subsequently supplied the binding and the actual questionnaire opened. The first post-completion audit incorrectly looked for mode on completion rather than the bound request. It was a **failed audit**, not workflow failure/PASS. After fixing the audit, `/reload` replaced the runtime and the **same completed history** was audited without Worker/Gate replay; revisions remained 62/67. Terminal proof and original failures are retained.

Machine-local raw reports:

- Git: `/private/var/folders/04/cs5vwntd34d_fdbtdczbxg000000gn/T/pi-orchestrator-clarification-O3DgMe/final-report.json`
- Non-Git: `/private/var/folders/04/cs5vwntd34d_fdbtdczbxg000000gn/T/pi-orchestrator-clarification-J4r4c8/final-report.json`

## Released host contract smoke

**PASS**, exact Pi 0.99.1 / pi-subagents 0.74.0, deterministic offline model but actual native SDK children and owner. Dedicated new Herdr tabs:

| Activation | Tab / pane / Agent | Time / result |
| --- | --- | --- |
| dynamic | `wF:t3B` / `wF:p3P` / `issue12-dynamic` | 2026-10-04T16:23:14.097Z–16:23:35.319Z, **PASS** |
| eager | `wF:t3C` / `wF:p3Q` / `issue12-eager` | 2026-10-04T16:23:17.139Z–16:23:38.359Z, **PASS** |

- Dynamic started with `subagents_enable` and without `subagent`; eager started with `subagent` and without the loader. Actual RPC still worked with `subagent` inactive; tool activation is not Workflow authority.
- Missing static sibling preflight produced **zero spawns**. Each successful matrix used three read-only children: large output, stop, timeout. Exact public launch receipts were persisted; recreated production adapters did not dispatch children.
- Explicit released **`maxOutput: { bytes:1024, lines:10 }`** was selected only for the contract probe's display projection. It does not alter execution/authority/full output. Actual full output **100,193 characters** was recovered exactly; summary **1,243**, raw inline results **100,435**. The real receipt retained the preflight launch digest. Production intentionally has no default inline cap: the released owner caps the **summary**, not raw `results[].output`; no fake imposes a different shape.
- Parent/child project trust false; selected synthetic skill present; ambient/extension-added/project skills and project settings/prompt/extension injections absent. Mutation/nested/Codemode tools absent in this test-only read-only provider loadout. Production Codemode remains the separately enforced Plan Simplicity Reviewer capability.
- Stop at/around child startup returned ambiguous, never successful terminal proof. The released public stop snapshots retained **processTerminal unknown / writer-close-unverified** despite recorded runner-close metadata; this is intentionally not promoted to terminal proof or repaired. Timeout returned ambiguous/timedOut with the saved receipt. Later exact reconciliation returned unknown (no successful terminal result), **not permission to relaunch**; the timed-out runner's public process-terminal state was observed. Adapter timers/listeners and provider abort handling remain finite.
- `failureKind` is **not applicable** to ordinary single-agent RPC. Tests cover failed single completions both with and without optional workflow-only metadata without granting that metadata Workflow semantics. No script mode or removed script fields are emitted by the product.

Earlier host probes failed due to missing durable launch callbacks and incorrect assumptions about optional summary truncation. All failed reports are preserved. Reading the released documented `maxOutput` contract and observing its real summary/raw-result distinction corrected the harness; no dependency was patched, no required assertion/timeout was weakened and no mutating Worker was retried. Final reports: `/tmp/pi-issue12-prep/dynamic-report.json`, `/tmp/pi-issue12-prep/eager-report.json`. The earlier cold-RPC checkpoint is `/tmp/pi-issue12-prep/host-final-valid-report.json` and is not the dynamic/eager proof.

## Coverage inventory

Automated scenarios exercise real core/State/Artifact/runners with explicit fake external ports; these are behavioral/contract proof, not live model results.

| Requirement / acceptance | Evidence |
| --- | --- |
| Fakes respect public contracts | Released-owner schema/resource loader + public preflight + native RPC/actual UI; `plannotator.test.ts`, `subagents*.test.ts`, `jev.test.ts`; exact Plan async / Code synchronous payloads and annotations, no invented Code fields |
| No repeated-resume happy path | Two connected production starts + command-runtime tests from Task, zero resume; recovery tests retain fault reconciliation/terminal idempotency only |
| Git + non-Git actual Human Gates | Connected runs above; retained baseline/patch/current-workspace checks, independent hashes and actual returned approvals |
| GRILL_ME / GRILL_WITH_DOCS | Actual root grilling/questionnaire/final Human confirmation; domain-modeling and exact Human-confirmed document write; clarification/ownership tests reject source/scope widening |
| TDD skills / approved seams | Both actual Worker transcripts + full immutable Plan approvals; `development-method`, launch/skill-drift, completed-Worker and TDD transcript tests; deterministic Validation remains independent |
| Oracle advisory only | `oracle-advisory.test.ts` plus fresh focused real-host Oracle verification below; no approval/implementation/Fix authority |
| Simplicity/refinement / material deviation end-to-end | `plan-simplicity.test.ts`, `plan-deviation.test.ts`, normal-driver tests through reapproval and completion; fresh focused real-host strategy verification below |
| failureKind/truncation/stop/timeout/trust/isolation/preflight | Explicit selected-mode applicability and released host matrix above; full-output and deadline/late-response/fanout faults; effective Codemode ceiling and #21 mismatch tests |
| Exact baselines / package replacement | Manifest/lock/resource-loader/typecheck; lifecycle v3 and model/skills/tools/definition freshness; completed-history audit after actual `/reload`, zero replay |
| Diagnosis / routing / method / finding / round / stale evidence | Planning/Diagnosis/development-method/decision/recovery suites cover required/skip/conditional, RUN/SKIP/ESCALATE, low-confidence safety, both bugfix/hotfix Diagnosis, candidate/refinement/Plan feedback/Oracle/deviation freshness, reviewer completeness and independent Validation |
| Transitional direct adapter / arbitrary endpoint credential forwarding | [#18 historical transition](./platform-baseline-smoke.md) and [#19 migration/removal](./native-classifier-migration.md); removed direct dependency/endpoints are not revived for #12 |
| Release evidence only after required PASS | Historical v0.1.0 release evidence remains historical. Final verification/release disposition is recorded only after the checks below finish; no automatic Issue #13 closure or version bump |

## Fresh focused strategy/advisory smoke and final validation

Fresh focused probes reuse the existing producer harnesses without altering public authority. They do not replace the two connected production runs.

| Probe | Current-code real-host evidence | Explicit fixture boundary |
| --- | --- | --- |
| Oracle | **PASS**, `wF:t3D` / `wF:p3R` / `issue12-oracle`, recorded 2026-10-04T16:29:46.863Z; builtin Oracle run `38d29c03-b71e-443f-8519-becb9ecca3ff`, one spawn/read, full immutable Advice, recreated exact recovery, workspace unchanged, no Plan/implementation authority; process observed / exit 0 | Scout/Diagnosis and routing are scripted; no live classifier or Human Gates in this probe |
| Simplicity/refinement | **PASS**, `wF:t3E` / `wF:p3S` / `issue12-simplicity`, 2026-10-04T16:33:50.197Z–16:34:51.034Z; actual reviewer → one actual refinement Planner → fresh reviewer → actual pending Plan UI; three children, cap 1, zero redispatch/reopen/mutation; all process proofs observed / exit 0; current child Codemode ceiling present | Scout/original candidate/classifier scripted; pending UI is not approval; no Worker/Code Gate |
| Material deviation and reapproval | **PASS**, `wF:t3F` / `wF:p3T` / `issue12-deviation`; initial run 2026-10-04T16:33:53.257Z–16:35:41.051Z; actual Human Plan v1 approval → actual stopped Worker, no unauthorized public API mutation → actual Planner/fresh simplicity → actual Plan v2 Gate. Continuation 2026-10-04T16:41:27.797Z–16:42:19.262Z recovered **the same actual second Human approval**, then one distinct actual Worker and independent Validation/behavior assertions. Two total Workers; old relaunch 0 / Gate reopen 0 / audit redispatch 0; implementation revision 1, deliberate stop at reviewing; all observed / exit 0 | Scout/original candidate/classifiers scripted; no Code Gate in this focused probe. Automated deviation scenarios cover completion; actual Code Gates are independently exercised by both connected production runs |

Raw reports: `/tmp/pi-issue12-prep/oracle-report.json`, `simplicity-report.json`, `deviation-report.json`, `deviation-continuation.json`. The focused v2 continuation queries the supported public Plan status and validates exact durable approval **before** dispatch; Human chat/prose is not approval. No new Plan open or stopped-Worker revival is performed.

Final `VITEST_MAX_WORKERS=1 pnpm check`: **PASS — typecheck / lint (no warnings) / format / 66 files / 907 tests**, 2026-10-05 02:58:21 JST start, 611.12 seconds. Earlier checkpoints: 65 files / 905 tests; 6 files / 72 focused side-path tests; 3 files / 6 platform/audit tests; final command/audit focused 2 files / 18 tests, all PASS.

The completed-history audit was hardened to reuse the existing ArtifactStore path/kind/hash/symlink boundary, reject unsafe retained paths, and traverse canonical JSON clarification/document/reconciliation/Diagnosis records even when stored as `.md`. A leading bracket in a legitimate task remains plain text, not guessed JSON. Final complete-chain audits **PASS — Git 49 refs / non-Git 58 refs**, unchanged State revisions 62/67, same two completed Workers and no redispatch/Gate reopen. Current reviewer launch/receipt bindings indexed by external digests are also hash-validated; all **six actual children per workflow** have matching public receipts/status and process-terminal proof observed / exit 0. The smaller initial 41/42-ref and intermediate 45/54-ref checkpoints are not substituted for complete document/question/reviewer history. Reports are the same fixture roots' `final-all-evidence-report.json` (both 2026-10-04T18:08:57.656Z). One intermediate validation stopped at a regex lint error; it was not PASS. Standard string/kind handling and the final full check resolved it without weakening validation.

Issue #12 scope/acceptance/required verification has no known blocking or important remainder in this working tree. [Release verification](../release/v1-production-verification.md) and the Unreleased changelog are recorded only after these production checks passed. This does not bump v0.1.0, claim all possible optional-stage combinations were run live, merge/close #12, or close tracking #13.

## Reproduction

From the repository, use `node --experimental-transform-types` to import the fixture (strip-only mode cannot load the project's existing TypeScript parameter properties):

```js
import { productionFixture } from "./tests/platform/production-fixture.ts";
const f = await productionFixture(authFile, pinnedQuestionCheckout, skillsDirectory, nonGit);
// Returns isolated agentDir/cwd/task/reportPath. Never modify operator settings or copy credentials.
```

```sh
# Inside Herdr only; parse returned pane ID and wait for its shell to be available.
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd <fixture-cwd> \
  --env PI_CODING_AGENT_DIR=<fixture-agentDir> --label issue12-production --no-focus
herdr agent start issue12-production --kind pi --pane <returned-pane-id> -- \
  --no-approve --no-session --no-prompt-templates \
  -e <repo>/node_modules/pi-subagents -e <fixture-question-package> \
  -e <installed-plannotator-package> -e <repo>/tests/platform/production-smoke-extension.ts
herdr agent prompt issue12-production '/wf-feature --tdd <returned-task>'
# Human answers actual questionnaire/confirmation and reviews actual Plan/Code. Never proxy answers.
herdr agent prompt issue12-production '/production-audit <returned-reportPath>'
# Audit after runtime replacement is read-only and does not resume the workflow.
```

For released host contracts, use `platformFixture("dynamic")` or `platformFixture("eager")`, set `ISSUE12_ACTIVATION` accordingly, load `probe-provider.ts` / `host-contract-smoke-extension.ts` and the same released owner, then `/host-contract-smoke <reportPath>`. This probe uses no credentials or network. It deliberately permits its own offline provider extension; it does not weaken product role policy. Success requires exact historical output/receipts/process proofs, not Herdr UI status. Never resend a production start against a possibly mutated workspace. Preserve failed reports, and close only created tabs after evidence inspection. Herdr is not a runtime dependency; tmux/direct Pi spawning is not used. Final successful workflow/advisory/strategy child proofs were inspected before cleanup. A cleanup probe that expected all stopped children to have observed proof failed on the released writer-close-unverified status; that expectation was not used as permission. Stop evidence remained unknown, no child was relaunched or repaired, and only test-owned parent tabs/auth symlinks were cleaned up; raw reports/workspaces remain retained.

## Limits

Synthetic UTF-8 text workspaces and explicit public seams, not universal semantic verification, OS isolation, all models/platforms or arbitrary package versions. Hooks are not a sandbox for privileged extension/operator code. Unsupported workspace types/size limits, stale/legacy authority, unknown stopped/timed-out children and lost synchronous Gate results remain fail closed. Classifier credentials, confidence, advice and child success never grant Human authority. Broader load/performance benchmarks and dependency/package rewrites are out of scope.
