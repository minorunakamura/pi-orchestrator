# Orchestrator Configuration

Version: 2.0 — v1 target contract (Issue #3)

## 1. Ownership / baseline

Configuration is execution policy / threshold / mapping, not Workflow progress or authority。v1 target requires Pi >=0.99.1 and pi-subagents >=0.74.0; pi-typesafe >=0.8.1 is transitional only until #19。#18 updates package/lockfile verification to Pi 0.99.1 / pi-subagents 0.74.0 / pi-typesafe 0.8.1; the remaining policy groups below are target contracts, not implemented settings。

Safety invariants cannot be disabled by configuration: both Human Gates, deterministic validation, freshness, intent-before-side-effect, finite budgets and active ownership are mandatory。

## 2. Source / trust

Read Pi's public settings boundary:

```text
<agent-dir>/settings.json      piOrchestrator
<project>/.pi/settings.json    piOrchestrator (trusted project only)
```

Use host precedence (trusted project deep override), not a custom trust loader。Unknown/invalid required settings fail closed; untrusted trust-gated settings/.pi prompts/skills/extensions cannot inject child policy。Pi reads sessionDir before trust and loads AGENTS.md/CLAUDE.md context independently of trust; exclude context via explicit inheritProjectContext policy when required, not a fictitious trust guarantee。

Do not persist credentials/raw host settings。Effective non-secret policy snapshot/digest is required for workflow authority/decision/launch freshness。

## 3. v1 policy groups (logical contract)

These groups define ownership, not an already-implemented JSON schema。Child Issues finalize minimal runtime field shapes without weakening these boundaries。

| Group | Required policy |
| --- | --- |
| decision | autoDecisionThreshold / escalationThreshold, evidence size limits, schema/policy identity |
| classifier | explicit provider/model, default typesafe/jev-latest; Pi native transport (#19) |
| executionProfiles | ECONOMY / STANDARD / STRONG → concrete provider/model |
| reasoningMapping | LOW / MEDIUM / HIGH → supported thinking |
| agentLaunch | evidence/review/advisory role-profile policy, explicit skills/tools/forbidden ceiling/inheritance; public preflight (#21) |
| stage policy | canonical required/conditional/skip matrix; sequential evidence-driven conditional evaluation |
| development method | explicit Human TDD precedence; deterministic behavior-free STANDARD; bounded eligible routing |
| plan simplicity | required for every candidate review-ready Plan, max automatic refinement = 1 per cycle |
| oracle | rare explicit triggers, finite attempt budget/deadline and read-only ceiling |
| read-only Codemode | permitted roles, verified effective callable tools, finite execution/output limits; disabled if unverifiable |
| retries | maxAutomatedFixRounds / maxStrongerRetries |
| validation | stopOnInfrastructureFailure; task-specific WHAT remains Approved Plan |
| workspace | canonical root, Git/filesystem observation policy, exclusions/unsupported entries/finite limits |
| authorization | operator/project grant upper bounds → durable workflow consent and finite request reservations |

Human Gates are not configurable conditional stages。Stage matrix is fixed by [Basic Design §5](./basic-design.md#5-playbook-baseline); do not silently override required/skip with Jev。Stage decisions bind policy digest and accumulated evidence; changes require explicit reconciliation, not recomputation to skip。

## 4. Execution profile / launch identity

```text
Jev STANDARD + HIGH
 -> configuration provider/model/thinking
 -> Agent Launch Policy
 -> public preflight / exact physical launch evidence
```

All child roles have explicit execution-relevant policy。Ambient default model change (including Pi's Codex default), selected skills/tools or Agent definition drift invalidates equivalent-attempt reuse even if task/refs are unchanged。Only resolved non-secret projection is durable; no credential or unbounded prompt dump。

Worker uses current approved Execution Profile; stronger retries cannot be downgraded。TDD Worker explicitly selects tdd through public skill selection with inheritSkills:false; optional codebase-design must be explicitly selected if required, never assumed inherited。

## 5. Budgets / confidence

Recommended coding defaults:

```text
maxAutomatedFixRounds = 3
maxStrongerRetries    = 1
```

Human Code Feedback has a separate counter。Automatic refinement hard cap is one per planning cycle; automatic Plan versions cannot reset it。Oracle and classifier have separate finite budgets。All cap exhaustion stops automatic continuation for Human/operator attention。

Confidence thresholds require project eval; do not treat arbitrary numeric confidence as permission。Low conditional/mode/method confidence never silently skips or invents a Human choice。Execution routing may select an explicitly configured safe stronger fallback profile, not another evaluator transport。

## 6. Operator/project grant vs workflow consent (#11)

Operator authorizes a trusted canonical project, explicit classifier/destination, permitted evidence categories and finite allowance。After workflowId generation, Orchestrator binds a workflow-scoped consent no broader than that active grant。

Durable consent/accounting includes grant ID / consent ID / policy version、workflowId、projectRoot、classifier provider/model/destination、allowed evidence categories、finite maxRequests、attemptsReserved、predecessor reservation refs。Mode families need task/scout/diagnosis/research/clarification/design evidence categories where transmitted; allow only explicitly permitted categories, not a wildcard expansion from old consent。

No requirement to configure a not-yet-generated exact workflowId in project settings。The durable workflow binding still requires exact identity on every call。New/revoked/narrower grant is revalidated; absence, scope mismatch, unknown/exhausted budget or reservation failure makes zero outbound calls and blocks。

Reserve every actual request including per-finding and retries before dispatch。Timeout remains charged; restart/client recreation cannot refund/reset allowance。API key/model availability, Plan approval and `/typesafe enable` are not Product Runtime consent。

## 7. Native classifier and transitional endpoint

Target config selects native classifier provider/model via Pi registry; provider/auth plumbing belongs to Pi。Explicit maxRetries:0 disables hidden provider retries; each Orchestrator retry needs a new durable reservation。Use finite signal/deadline and require stopReason:stop plus valid complete answers (classify errors/aborts are returned results, not necessarily exceptions)。No silent classifier/LLM fallback。Classifier identity and bounded request/policy/config digests are required for freshness。

#18 chooses **default TypeSafe backend only** until #19 removes direct transport。`jev.endpoint` may be omitted or set to `https://api.typesafe.ai` (trailing slash accepted); custom host/path, HTTP, credentials, query and fragment are rejected by configuration and the adapter before client creation/dispatch。Existing custom-endpoint configurations must be removed or changed to the default, with matching consent destination。No backend registry/custom credential configuration is added。Never rewrite an authenticated TypeSafe fetch to arbitrary host; remove obsolete direct endpoint config after #19 migration/smoke。

## 8. Validation / Human review / ownership

Approved Plan owns commands/cwd/required checks/timeout/Test Seams, configuration only infrastructure HOW。No silent task-specific requirement addition/removal。TDD does not imply Validation pass。

Plan Gate async request acquisition may have a finite infrastructure deadline。Code Gate is synchronous Human interaction: Human review duration is not an integration timeout, no five-second cap or invented polling。Persist exact local Code attempt/source before request and verify source still current on settlement。

Active workspace ownership guard cannot be disabled。GRILL_WITH_DOCS allowlist is restricted to exact authorized CONTEXT/ADR paths with clarification-bound before/after evidence, not configurable source access。

## 9. Future Scope

Generic Context Routing、arbitrary escalation target allowlist、semantic validation classifier、multiple coding concurrency / work package scheduling、Virtual Models authority remain deferred。Conditional Stage / mode / method / read-only Codemode policy are v1, with no speculative placeholder settings。
