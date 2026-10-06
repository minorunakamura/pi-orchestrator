# Jev Decision Engine

Version: 2.0 — v1 target contract (Issue #3)

## 1. Role / transport

Jev produces bounded typed probabilistic decision evidence, never Workflow authority。Orchestrator owns evidence assembly, policy, State transitions, freshness, authorization and request accounting。

v1 production baseline: Pi **>=0.99.1**, pi-subagents **>=0.74.0**。Default production classifier is explicitly `typesafe/jev-latest` through Pi native classifier models (#19), not an arbitrary interchangeable evaluator。

```text
Orchestrator evidence + authorized reservation
 -> DecisionClassifierPort (domain types)
 -> Pi classifier adapter
 -> ctx.modelRegistry.findOfType("classifier", "typesafe", "jev-latest")
 -> ctx.modelRegistry.classify(model, { state, questions })
 -> normalized Decision<T>
 -> deterministic policy -> Event -> persisted State
```

Pi owns provider/model/auth transport。core imports no Pi/TypeSafe transport types。Native questions use choice/bool/score with string instructions and typed criteria (unlike TypeSafe direct's richer instruction JSON)。Choice returns probabilities/confidence; Score guarantees score/confidence only; Bool guarantees probability only。

classify() returns stop/error/aborted results for provider failure; require stopReason:stop, matching identities and complete schema-valid answers, not a resolved Promise as proof of success。Pass finite signal/deadline and maxRetries:0; stock System One otherwise internally retries twice, outside workflow reservation。Only Orchestrator explicitly reserved retries are allowed。

#19 implementation uses `PiClassifierDecisionClient` / `DecisionClassifierPort` for all six bounded families; `JevIntegration` is a compatibility export of the same native adapter, not a second transport。Existing Execution/Finding/Round runners use this path; planning family lifecycle integration remains #6/#8/#16。No direct client or automatic transport/classifier/LLM fallback remains。The required Pi 0.99.1 live smoke passed and `pi-typesafe` was removed。See [migration verification](../implementation/native-classifier-migration.md)。

## 2. Deterministic / Human boundaries

Jev must not generate source, Plan, Architecture, review findings, Oracle deep reasoning, or Human-facing question text。It must not answer for Human, mutate State/files, grant implementation/Fix authority, approve Plan/Code, or replace deterministic Validation。

Artifact existence/hash/schema、stateRevision、exit code、budget、required/skip policy、Human approval validity、launch identity、allowlisted paths are deterministic checks。

```ts
export interface Decision<T> {
  value: T;
  confidence: number;
}
export type DecisionResult<T> =
  | { status: "decided"; decision: Decision<T> }
  | { status: "uncertain"; reason: string };
```

Questions judge named bounded state fields independently。Multiple findings use one named item / one question per dimension per finding, not one blended question over a list。

## 3. v1 decision families

| Family | Input / deterministic boundary | Bounded output |
| --- | --- | --- |
| Conditional Stage Routing | playbook policy + accumulated durable Scout/Diagnosis/Research/clarification evidence | RUN / SKIP / ESCALATE |
| Clarification Mode Routing | exact stage decision + bounded fact gaps / unresolved Human decisions / docs needs | SKIP / GRILL_ME / GRILL_WITH_DOCS / ESCALATE |
| Development Method | captured Human request + behavior/change evidence + eligibility | STANDARD / TDD / ESCALATE |
| Coding Entry / Execution Routing | exact Approved Plan strategy/constraints + context + retry/profile floor | ECONOMY / STANDARD / STRONG and LOW / MEDIUM / HIGH |
| Finding Evaluation | each raw finding + approved scope/design + implementation evidence | independent confidence-bearing dimensions → policy ACCEPT / REJECT / ESCALATE |
| Round Decision | validation branch + complete review evidence when passed + retry/history/profile | COMPLETE / RETRY / ESCALATE; bounded reason if ESCALATE |

No decision family includes Human Plan Review / Code Review as conditional stages。

## 4. Conditional Stage Routing (v1)

```text
required    -> deterministic RUN
skip        -> deterministic SKIP
conditional -> Jev RUN / SKIP / ESCALATE
```

Research → Clarification → Architecture are resolved sequentially, after preceding evidence is durable。Scout is always required; Diagnosis is required for bugfix/hotfix。The baseline matrix is [Basic Design §5](./basic-design.md#5-playbook-baseline)。Do not resolve all conditional flags at start from absent transient hints。

Persist stage/policy/input identity + raw result/confidence + effective policy outcome before stage side effects。Low confidence, invalid result, missing critical evidence or contradictory policy → ESCALATE/Human attention or integration block, never silent SKIP。Jev cannot override required/skip。

Research の valid low-confidence RUN/SKIP または explicit ESCALATE は、元の判定を保存してから root Human に RUN / SKIP / HOLD を確認する（#47）。Confidence が閾値と等しい場合は自動採用し、閾値未満を Research 不要と扱わない。Intent → State → public questionnaire → exact answer → State → Human-resolved decision → State の順で保存する。RUN は Research → Clarification 判定、SKIP は Clarification 判定へ継続し、HOLD/cancel/unavailable/pending result loss は停止を維持する。Product questions は後続 Clarification、Plan/Code approval は mandatory Gates の責務。Clarification/Architecture の ESCALATE はこの Research-only selection で解決しない。

Architecture RUN asks Planner for Architecture / Design evidence/content; it does not dispatch an independent mandatory architect or give classifier authority to design。

## 5. Clarification mode

`GRILL_ME` → root/Main Pi Agent + grilling + ask_user_question。
`GRILL_WITH_DOCS` → root/Main + grilling + domain-modeling + Human, narrowly authorized CONTEXT/ADR writes only。
`SKIP` requires sufficient evidence, not a missing answer。`ESCALATE` preserves unresolved Human decision。

Jev routes mode from bounded evidence only。root/Main generates questions and Human answers。Mode selection is not write authority: exact allowlist / intent / before identity must persist separately。domain-modeling is not a standalone Stage。

## 6. Development Method

Apply priority:

1. explicit Human TDD request → deterministic TDD
2. no explicit TDD request and clearly inapplicable behavior-free work → deterministic STANDARD
3. ambiguous eligible behavior change → bounded Jev STANDARD / TDD / ESCALATE
4. low confidence / unresolved Human preference → Human clarification, never invented consent

Method evidence binds exact inputs。TDD Plan must include Human-reviewable Test Seams; Human Plan Approval binds method/seams/Validation Contract。Worker receives explicit `tdd` through #21, optionally supporting `codebase-design`。RED → minimal GREEN is methodology, not validation pass authority。

## 7. Execution Routing

Jev returns logical modelTier `ECONOMY | STANDARD | STRONG` and reasoningTier `LOW | MEDIUM | HIGH`。Configuration resolves physical provider/model/thinking; effective confidence is the minimum of the two dimensions。

At/beyond autoDecisionThreshold use selected profile。Below threshold use explicitly configured safe stronger profile or fail closed; do not silently accept the weak choice。A required stronger retry is a floor and cannot be downgraded by re-evaluation。

The resolved physical launch identity is saved separately through Agent Launch Policy/preflight; a changed default model is not an equivalent attempt。

## 8. Finding Evaluation

Each finding retains raw ID/source/ref and independent dimensions:

```text
evidenceSupported
conflictsWithApprovedPlan
conflictsWithArchitecture
inScope
requiresHumanDecision
```

Where Decision<boolean>.confidence is required, use a bounded Yes/No Choice and normalize to Decision<boolean>。Native Bool probability / transitional Noul probability-of-yes is not a separate confidence field and must not be silently relabelled as one。Human decision / uncertain evidence → ESCALATE。Approved strategy conflict cannot become automatic accepted Fix Authority。Evidence-supported + in-scope + no approved constraint conflict → ACCEPT。Unsupported/out-of-scope evidence → REJECT under deterministic policy。

Only exact-bound Accepted Findings reach Fix Worker。Raw reviewer blocking flags, classifier answers or Oracle advice alone grant no authority。

## 9. Round Decision / policy precedence

Action and required escalation reason retain **separate confidence**。Reasons are `implementation-capability | plan-conflict | human-decision | uncertain`。

Apply this order to every action, including RETRY / ESCALATE:

1. reject invalid/stale/incomplete authority, apply infrastructure stop policy
2. evaluated Human-decision finding → human-decision escalation
3. uncertain/escalated finding, low action confidence, low required reason confidence, unresolved infrastructure → uncertain/Human attention
4. confident ESCALATE reason → deterministic target; confident RETRY or blocked COMPLETE → bounded retry only within approved strategy
5. COMPLETE only if deterministic validation passed, all current review/evaluation/accepted artifacts exist (explicit empty allowed), no blocking/unresolved escalation, sufficiently confident action

Failed validation and accepted blocking findings forbid COMPLETE。COMPLETE emits REVIEW_COMPLETE → Human Code Gate, **not** workflow completion。

| Reason | Deterministic target |
| --- | --- |
| implementation-capability | stronger fresh Worker, both budgets and strongest-profile guard |
| plan-conflict | invalidate approval → Planning → fresh simplicity → Human Plan Gate |
| human-decision | Clarification → Planning → fresh simplicity → Human Plan Gate |
| uncertain | Human clarification / operator attention, no automatic mutation |

Oracle may supply optional bounded read-only advice at hard escalation points。It cannot resolve an authority requirement or replace the selected Human path。Material deviation can stop/replan deterministically without any classifier/Oracle call。

## 10. Evidence assembly and freshness

Runtime reads hash/schema-validated authoritative Artifacts and assembles bounded excerpts with source ref / section / location provenance。Adapter forwards them and normalizes results; it never reads ArtifactStore or invents constraints。

Finding requests include approved Scope/Design/strategy and implementation evidence。Round requests include validation/contract identity, passed/failed/infrastructure branch, accepted/rejected/escalated summaries when required, retry counters/limits/profile and previous decision evidence。Lost previous evidence must not silently become no history。Required constraints that cannot fit without unsafe truncation cause Human attention, not weakened evidence。

Completed Clarificationはtransport/audit envelopeの全文ではなく、Orchestratorが検証したderived evidenceを入力にする（#49）。全confirmed roundsのquestion/options/answer、明示的Human confirmationとsummary、source refsと該当document bindingを保持し、同じ確認文の重複だけを除く。Original Artifact refs/hashは正本のidentityであり、derived contentのhashだと扱わない。Actual assembled input / projection policyをdecision freshnessへbindする。Completed Clarificationのbounded producer契約と、無関係なraw evidenceの制限を区別し、raw-envelopeの12,000/48,000 UTF-16 code-unit制限をそのままClarificationへ適用しない。Bytes/文字数はmodel token capacityの保証ではなく、公開APIでの拒否は別のfail-closed boundary。

Freshness covers decision schema, classifier provider/model, exact input refs/hash/digest, policy/version/configuration digest, relevant Plan version/implementation revision and accumulated evidence。Pre-plan decisions legitimately have no approved Plan; record that absence and stage/input identity rather than synthesizing approval/version。

Relevant method, clarification document evidence, Plan, implementation, counters, classifier/config or launch changes invalidate dependent decisions。Historical evidence remains advisory context, not renewed authority。

## 11. Authorization / accounting

Operator/project grant supplies upper bounds for trusted canonical project, classifier/destination, evidence categories and finite request allowance。After generating workflowId, Orchestrator captures workflow-scoped durable authorization no broader than that grant (#11)。No need to preconfigure a future workflowId。#11 captures `jev.runtimePolicy.grant` into immutable authorization evidence and State at the first authorized classifier boundary. Request/usage records reference that binding; current grant and original consent ceilings are independent. Cached decision reuse validates active consent/accounting but spends no new request. Classifier/grant identity drift or legacy binding ambiguity blocks instead of silently renewing authority. See [implementation / acceptance evidence](../implementation/classifier-authorization.md).

Before each outbound attempt (including per-finding and transport retry), validate active grant/consent and exact project/workflow/classifier scope, then persist immutable reservation → State/counter before calling classifier。Missing/revoked/mismatched consent, exhausted/unknown budget or reservation write failure → zero network calls + blocked/operator attention。

Credentials, model availability, `/typesafe enable`, Plan approval, Jev confidence are not consent。Unknown timeout usage stays reserved; client recreation cannot reset allowance。Persist only non-secret scope/identity/policy/accounting and bounded safe usage, never API key/auth headers/secret URL。

## 12. Failures / budgets

Unavailable classifier/Jev、auth/transport/schema failure → blocked/integration-unavailable, no automatic fallback。Safety/accounting/authority ambiguity fails closed。Corrupt unreconstructable authority may be terminal failed; ordinary low confidence is not terminal failure。

Recommended coding bounds remain automated fix 3 / stronger retry 1。Finite Oracle budgets and one-shot Plan refinement are separate。Retry exhaustion blocks instead of looping。

## 13. Future Scope

Generic Context Routing (`READY | RESEARCH | CLARIFY | RESEARCH_AND_CLARIFY`)、arbitrary escalation target choice、semantic Validation failure classifier、dynamic reviewer routing、multi-Worker scheduling、Virtual Models execution authority remain Future Scope。Conditional Stage Routing, Clarification Mode and Development Method are v1。

Public references: [Pi classifier models](https://github.com/earendil-works/pi/blob/v0.99.1/packages/coding-agent/docs/models.md#use-classifier-models)、[Integrations](./integrations.md)、[Configuration](./configuration.md)、[Persistence](../detailed-design/persistence-recovery.md)。
