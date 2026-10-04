# v1 production verification — Issue #12

## Disposition

**PASS for the required Issue #12 verification matrix**, on the working tree based on `86254e2` with the #12 changes. This is verification evidence, **not a package release, version bump, PR merge, or closure of tracking Issue #13**. Package version remains `0.1.0`; [historical v0.1.0 evidence](./v0.1.0.md) is unchanged.

[Detailed implementation, acceptance coverage, failures, fixture boundaries and reproduction](../implementation/production-verification.md) is the source for this verification. All prerequisite producer Issues were CLOSED before testing.

## Required production paths

- **Git and non-Git connected production: PASS.** One `/wf-feature --tdd` per workspace; actual root grilling/ask_user_question and final Human confirmation; actual Human Plan/Test Seams and Code approvals; native typesafe/jev-latest; one actual TDD Worker per workspace; independent deterministic Validation; actual Correctness/Ponytail; completion with zero normal-path resume. GRILL_WITH_DOCS writes only the Human-confirmed `CONTEXT.md`.
- **Supported explicit TDD selection: PASS.** `inheritSkills:false`, `tdd` only, full approved Plan/seams and hash-bound launch; actual `RED → GREEN → RED → GREEN` in both Workers. Worker prose does not decide Validation or approval.
- **Released host contracts: PASS.** Exact **Pi 0.99.1 / pi-subagents 0.74.0**, actual native children and public RPC; both dynamic and eager activation; explicit maxOutput summary truncation with full output retained; stop/timeout remain uncertain; missing sibling preflight has zero child dispatch; project-trust inheritance and explicit skill isolation. Ordinary single RPC does not require workflow-only failureKind.
- **Focused real strategy/advisory probes: PASS.** Actual builtin read-only Oracle; actual simplicity → bounded refinement → fresh simplicity → pending Human UI; actual approved stop-only Worker → material deviation → fresh Planner/simplicity → actual Plan v2 Human reapproval → distinct Worker continuation and independent Validation. Their scripted Scout/original-candidate/classifier setup is explicitly recorded, not relabeled as a connected full lifecycle.
- **Recovery/authority regressions: PASS.** Automated full scenarios, publication faults, stale Plan/simplicity/method/advice/deviation/launch evidence, exact payloads, narrow document authority, Main bypass denial, native consent/accounting, and completed-history audit after actual `/reload`. Same completed histories are read-only audited; no blind Worker/Gate reuse or replay.

Real tests used **new Herdr tabs only**, never tmux/direct Pi spawning, never proxy Human answers. Actual Plannotator was **0.27.16**; reviewed later contract references are not silently imposed as a raised minimum. Pi-typesafe was removed by #19; historical **0.8.1** direct-path/credential-boundary verification is retained rather than reinstalling a removed transport. No third-party package modification/private API or new runtime dependency was needed.

## Validation

Final `VITEST_MAX_WORKERS=1 pnpm check`: **PASS — typecheck, lint (no warnings), format, 66 test files / 907 tests**. Focused command/audit: **2 files / 18 tests PASS**; focused side-path contracts: **6 files / 72 tests PASS**. Git/non-Git complete-chain audits validate **49 / 58 immutable refs**, including externally indexed reviewer launch/receipt bindings, exact authority, current regenerated patches and actual TDD transcripts, with unchanged final State revisions **62 / 67**. All six actual children in each workflow have public terminal proof observed / exit 0.

The initial native Research ESCALATE and failed audit/host assumptions/lint attempt were preserved as failures. The authorized shared routing correction binds instructions into policy freshness; the final checks, not earlier incomplete checkpoints, support PASS.

## Boundary

Representative connected workflows plus explicitly layered focused/automated coverage, not every optional-stage combination in one live workflow, arbitrary models/versions/platforms, semantic correctness guarantees, performance benchmarks or an OS sandbox. Unsupported workspace types/size limits, ambiguous/legacy authority and stopped/timed-out children remain fail closed. Classifier confidence, credentials, Oracle advice and child success never replace either Human Gate.

No known blocking/important #12 implementation or required-validation remainder. Commit/PR/merge/Issue/release operations and tracking #13's close condition remain separate operator actions.
