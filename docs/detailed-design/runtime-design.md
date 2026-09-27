# Pi Orchestrator Runtime Design

Version: 1.7

## 1. Purpose

This document defines runtime responsibility boundaries and external integration ports for pi-orchestrator v1.0.

## 2. Dependency Direction

```text
commands / tools / events / ui
              ↓
           runtime
              ↓
             core
```

Forbidden dependencies:

```text
core → runtime
core → Pi API
core → TypeSafe API SDK
core → Plannotator API
core → pi-subagents API
```

## 3. Runtime Components

Recommended runtime split:

```text
src/runtime/orchestrator/
  workflow-controller.ts
  advance-workflow.ts
  planning-orchestrator.ts
  coding-orchestrator.ts
  validation-runner.ts
  review-runner.ts
  resume-workflow.ts
  reconciler.ts
```

## 4. Workflow Controller

The Workflow Controller is the single top-level runtime controller.

```ts
export interface WorkflowController {
  start(input: StartWorkflowInput): Promise<void>;
  advance(workflowId: WorkflowId): Promise<void>;
  resume(workflowId: WorkflowId): Promise<void>;
}
```

Responsibilities:

1. Load persisted state.
2. Inspect current phase.
3. Invoke the phase runner.
4. Receive evidence or integration results.
5. Produce a domain `WorkflowEvent`.
6. Call pure `transition()`.
7. Persist the resulting state.
8. Begin the next side effect only after persistence succeeds.

The controller must not contain Jev business policy, transition tables, or reviewer evaluation rules.

## 5. Runtime Ports

External capabilities are accessed through interfaces.

```ts
export interface SubagentExecutor {
  run(input: AgentRunRequest): Promise<AgentRunResult>;
  runParallel(inputs: AgentRunRequest[]): Promise<AgentRunResult[]>;
  status(runId: SubagentRunId): Promise<AgentRunStatus>;
  resume(runId: SubagentRunId, task: string): Promise<AgentRunResult>;
}

export interface ExecutionRoutingPlanSectionEvidence {
  title: PlanSection;
  content: string;
}

export interface ExecutionRoutingPlanEvidence {
  summary: string;
  relevantSections: readonly ExecutionRoutingPlanSectionEvidence[];
}

export interface ExecutionRoutingContextEvidence {
  ref: ArtifactRef;
  content: string;
}

export interface ExecutionRoutingInput {
  approvedPlanRef: ArtifactRef<"plan">;
  planEvidence: ExecutionRoutingPlanEvidence;
  playbook: PlaybookKind;
  changeScope: string;
  contextRefs: readonly ArtifactRef[];
  contextEvidence: readonly ExecutionRoutingContextEvidence[];
  priorRetryCount: number;
}

export interface JevDecisionClient {
  routeExecution(input: ExecutionRoutingInput): Promise<ExecutionRoutingRawDecision>;
  evaluateFindings(input: FindingEvaluationInput): Promise<FindingEvaluationRawDecision[]>;
  decideRound(input: RoundDecisionInput): Promise<RoundDecisionRawDecision>;
}

export interface PlannotatorGate {
  openPlanReview(input: PlanReviewRequest): Promise<PlanReviewHandle>;
  getPlanReview(reviewId: PlannotatorReviewId, persistedBinding?: PlanReviewBinding): Promise<PlanReviewStatus>;
  openCodeReview(input: CodeReviewRequest): Promise<CodeReviewHandle>;
  getCodeReview(reviewId: PlannotatorReviewId, persistedBinding?: CodeReviewBinding): Promise<CodeReviewStatus>;
}

export interface ValidationExecutionResult {
  status: "passed" | "failed" | "infrastructure-error";
  checks: ValidationCheckResult[];
}

export interface ValidationExecutor {
  execute(contract: ValidationContract): Promise<ValidationExecutionResult>;
}

export interface ClarificationPort {
  request(input: ClarificationRequest): Promise<ClarificationResult>;
}
```

`ValidationExecutor` is intentionally unaware of Workflow State and implementation revision. It owns deterministic execution of the Validation Contract only. `ValidationRunner` obtains that contract exclusively by reading/hash-validating the current Approved Plan Artifact and parsing its machine-readable block; callers cannot substitute a contract (B2). The runner validates result coverage/aggregation and binds `ValidationResult` to exact Plan/implementation refs, versions, and contract digest before persistence.

```text
ValidationExecutor
    → ValidationExecutionResult (status / checks)

ValidationRunner + current WorkflowState + Approved Plan Artifact
    → parsed authoritative Validation Contract → ValidationExecutor
    → ValidationResult (Plan/implementation binding / contract digest / status / checks)
```

This prevents hidden State access or fabricated revision values inside the execution port.

## 6. pi-subagents Integration

Agent mapping remains identical to Basic Design:

```text
scout                workflow-scout
researcher           pi-ketch.researcher
planner              planner
worker               worker
reviewer             reviewer
simplicity-reviewer  ponytail-reviewer
```

Jev must not be launched as an agent.

### Product custom Agent vs development-time agent

`workflow-scout`, `planner`, and `ponytail-reviewer` are product custom Agent definitions supplied by pi-orchestrator under `agents/`. They are not assumed to exist before the Story that introduces each definition.

During development, a new Pi session may use currently available pi-subagents builtin agents as development-time helpers, for example:

```text
builtin scout
    → read-only repository investigation

builtin reviewer
    → read-only correctness review
```

This development-time usage does not satisfy or replace the product custom Agent definitions. A generic reviewer may be used as an explicitly labeled advisory fallback, but it must not be reported as execution of `ponytail-reviewer`.

The product runtime must use the configured Agent Mapping only after the corresponding custom Agent definition exists.

### Product runtime fresh-context policy

Default policy:

- Scout: fresh child
- Researcher: fresh child
- Planner: fresh child
- Correctness Reviewer: fresh child
- Ponytail Reviewer: fresh child
- Initial Worker: fresh child
- Ordinary same-profile Fix: fresh child by default; retained resume is allowed only when the exact child identity and contract are known safe
- Stronger Retry: always fresh child

A retained child must never be used when escalation requires a stronger execution profile.

### Durable Dispatch and Bounded Wait (I2 / I4)

The orchestrator-side dispatch boundary persists [Worker attempt intent](./persistence-recovery.md#61-worker-attempt-evidence-i2) and State before emitting a public request. The adapter exposes the request correlation identity to that boundary before dispatch and reports actual runId as soon as available through the existing public API. This may require an orchestrator-owned wrapper/port lifecycle notification; it does not require new third-party events or early run IDs.

Every adapter request has a positive finite response deadline, including when no subscriber responds. Passing a child timeout in the request alone is insufficient. On response, error, or expiry, the adapter settles once and releases its timer/listener. Mismatched identities cannot settle the request; late results cannot silently authorize work after timeout.

A proven pre-dispatch failure maps to `agent-infrastructure-unavailable`. Once dispatch may have happened, no response, timeout, or ambiguous completion preserves correlation/run identity and maps to `agent-execution-ambiguous`; timeout does not prove cancellation or absence of repository mutation. The runtime persists evidence and `BLOCK` before any subsequent Worker. There is no automatic redispatch of an unresolved mutating attempt. Public status/resume capability gaps remain blocked/unsupported, not patched dependencies.

Phase C owns evidence production and these bounded failure paths; full reconciliation and late/orphan-result recovery remain ORCH-018.

## 7. Plannotator Integration

`runtime/integrations/plannotator.ts` translates Plannotator events / statuses into domain results.

The adapter must not mutate Workflow State.

`getPlanReview` may use the handle it opened, or an exact persisted binding validated by the Orchestrator. The optional second argument includes `reviewId`, `planRef`, and `planVersion`; it is not a current-Plan expectation to attach to arbitrary external results. Missing bindings yield `unknown`, and conflicting bindings are rejected. Both runtime reconciliation and direct result application require the durable binding to match State before using adapter evidence.

`PlannotatorGate.openPlanReview` is the adapter port: it returns an external handle and does not persist Workflow State. `PlanningOrchestrator.openPlanReview` owns the persistence barrier: it persists that exact handle as `planning.planReview` together with the versioned external identity before reporting an opened handle to its caller. If a current binding or external identity already exists, the Orchestrator reconciles it or fails closed rather than making another external open or overwriting it. A reconciled outcome may be pending, settled, unknown, or blocked.

Duplicate settled-result handling uses current persisted State and never a cached State snapshot. These are orchestrator-side contracts; they do not add fields or persistence responsibilities to the third-party Plannotator API.

Human review result must first be persisted as an artifact. Only then may the runtime emit `PLAN_APPROVED`, `PLAN_FEEDBACK`, `CODE_APPROVED`, or `CODE_FEEDBACK`.

For Code Review, `coding.codeReview` durably binds `reviewId + exact implementationRef + implementationRevision` together with the versioned external index (B5). `getCodeReview` accepts that validated persisted tuple, not a synthesized current-implementation expectation. Missing/mismatched bindings fail closed, including after restart and for direct apply. An external result without implementation metadata may use only the original durable binding; no third-party field is required. Existing identities are reconciled without unconditional reopen. See [Human Code Gate](./coding-orchestration.md#15-human-code-gate) for persistence, duplicate handling, and invalidation.

## 8. Jev Integration

### Selected client package

v1 uses [`DevMortimer/pi-typesafe`](https://github.com/DevMortimer/pi-typesafe) as the Jev client package.

The product runtime uses the package's **public library API** from `runtime/integrations/jev.ts`; it does not route decisions through the `typesafe_evaluate` Pi agent tool. Consequently, `/typesafe enable` is not a prerequisite for pi-orchestrator's runtime decision calls.

```text
JevDecisionClient port
        ↓
runtime/integrations/jev.ts
        ↓
pi-typesafe public API
        ↓
TypeSafe / Jev
```

`runtime/integrations/jev.ts` owns:

- `pi-typesafe` client creation / public-API calls
- authentication / availability normalization
- backend / transport options permitted by v1 configuration
- Choice / Score / Noul external schema handling
- confidence normalization
- response validation
- budget / transport / auth error normalization
- optional usage metadata

Where the domain requires `Decision<T>.confidence`, use a confidence-bearing bounded primitive (normally Choice) rather than letting an external primitive shape weaken the domain contract.

The adapter converts `pi-typesafe` success/failure results into the existing `JevDecisionClient` contract and domain integration errors. `pi-typesafe` result/error types must not escape into `core/`.

### Product Runtime Consent and Budget (I5)

pi-orchestrator owns and enforces the permission to send evidence and incur Jev requests. The package's agent-tool opt-in state is not Workflow authority. Neither `/typesafe enable`, an available API key, a Plan approval, nor model confidence constitutes Product Runtime consent.

Minimum v1 contract:

- Before any network request, runtime requires explicit operator-authorized Product Runtime consent scoped to the project/workflow, destination/backend, and permitted evidence categories. Record a non-secret consent identity/scope and policy version; missing, revoked, or mismatched consent denies dispatch. No new Human Gate bypass or consent UI is implied.
- Product configuration supplies a finite per-workflow outbound-request allowance. Runtime durably reserves an attempt before each dispatch, including per-finding requests and transport retries. The persisted counter survives client recreation/restart; library defaults or an in-memory counter are not the budget authority.
- Exhausted/unknown budget or consent denial makes no network call and produces `BLOCK` for `operator-attention-required` with non-secret diagnostic evidence. A reservation save failure also prevents dispatch. An uncertain timed-out request remains charged to the allowance; automatic refunds/retries cannot reset the cap.
- The adapter's transport retry loop must obtain permission/reservation for every attempt through the orchestrator-owned boundary; public library budget checks can add restrictions but cannot replace that boundary. Provider/auth/transport failures still normalize to the integration failure path, with no LLM fallback.
- Retain consent/policy identity, allowance/attempt count, and available usage metadata as bounded durable runtime evidence. Never persist API keys, auth headers, or secret-bearing URLs. Full accounting recovery belongs to ORCH-018; conservative denial on ambiguity is required now.

These are orchestrator-side policy and persistence contracts. They require no change to `pi-typesafe`, no dependency on `/typesafe enable`, and no v1.1 decision family.

### Runtime Policy Configuration and Accounting

The concrete permission boundary is `jev.runtimePolicy`: a finite `maxRequests` and `consent` with `id`, `policyVersion`, `active`, exact `workflowId`, `projectRoot`, `destination`, and allowed `evidenceCategories` (`plan`, `context`, `implementation`, `review`, `validation`, `history`). Absence is denial, not an implicit grant. Configuration is operator-supplied; this adds no new approval UI or command.

Workflow start persists `projectRoot` and `jevUsage.attemptsReserved = 0`. Each runner creates an orchestrator-owned authorization context; the adapter awaits its reservation callback before each library request, including each finding and retry. Reservation Artifact → State CAS must complete before outbound execution. The runner continues from the authorization context's updated State revision, not its old snapshot.

Immutable `jev-request` evidence under `decisions/` distinguishes reservation and available numeric usage records. It records ordinal, request family/finding/retry identity, consent/policy scope, allowance, predecessor, and timestamp; it is accounting evidence, never decision or Human authority. Missing/inconsistent accounting and orphan reservation collisions deny dispatch. Client recreation cannot reset the counter, and uncertain timeouts are not refunded. Credential-bearing destination URLs are rejected; no auth secrets are stored. Full recovery of these records remains ORCH-018.

### Runtime Evidence / Adapter Policy Boundary

For Coding Entry Routing, the Orchestrator/runtime assembles bounded `planEvidence` and `contextEvidence` after reading and validating the referenced immutable artifacts. The `JevDecisionClient` input carries both the authoritative refs and those excerpts. `runtime/integrations/jev.ts` only forwards the supplied evidence; it never reads `ArtifactStore`, resolves refs, or invents missing context.

The same boundary applies to Finding Evaluation and Round Decision (B3): runtime assembles Approved Plan/Architecture/Scope constraints, provenance-bearing implementation/finding/validation evidence, retry State, and previous decision evidence as defined in [Runtime Evidence Assembly](./coding-orchestration.md#runtime-evidence-assembly-b3). Missing evidence is not delegated to Jev to infer. The adapter preserves action and escalation-reason confidence separately for [core precedence policy](./coding-orchestration.md#policy-precedence-b4) (B4).

It does not own:

- State mutation
- ACCEPT / REJECT policy
- Round hard rules
- concrete Workflow transition
- Human Gate behavior

## 9. Error Normalization

External errors are converted into domain categories.

Examples:

```text
Jev unavailable
    → integration-unavailable

pi-subagents infrastructure error
    → agent-infrastructure-unavailable

child result ambiguous
    → agent-execution-ambiguous

Plannotator unavailable
    → human-gate-unavailable

validation process spawn failure
    → validation-infrastructure-error
```

External SDK error classes must not escape into `core/`.

ValidationRunner persists infrastructure evidence separately from ordinary check failure and applies `stopOnInfrastructureFailure` (I3): `true` blocks with `validation-infrastructure-error` before Jev/review/Worker; `false` may feed Round Decision only for deterministic Human/uncertain escalation, never automated retry or completion while unresolved. See [Validation Infrastructure Policy](./coding-orchestration.md#validation-infrastructure-policy-i3).

## 10. Concurrency

v1 allows concurrency only where it does not violate the single Coding Orchestration model.

Allowed:

- Scout and Researcher in parallel when Playbook policy requires both.
- Correctness Reviewer and Ponytail Reviewer in parallel.

Not allowed in v1:

- multiple Worker branches
- Work Package parallel execution
- multiple Coding Orchestrations

## 11. Third-Party Dependency Boundary

Third-party libraries and packages are read-only dependencies of pi-orchestrator v1.

This includes, but is not limited to:

- Pi / pi-coding-agent
- pi-subagents
- Plannotator
- pi-ketch
- pi-ask-user-question
- `pi-typesafe` / Jev / TypeSafe client libraries
- other npm or external dependencies

Forbidden approaches include direct source edits, `node_modules` edits, required package patches, and forks that add orchestrator-specific behavior.

This rule has no exception in v1. A temporary local patch, development-only fork, or modified installed package must not become part of the implementation or test prerequisite.

All adaptation must remain on the pi-orchestrator side of the integration boundary. If a public contract is insufficient and no safe wrapper is possible, the runtime must use a safe blocked/unsupported path rather than mutate the dependency.

Capability gaps are handled in this order:

```text
1. published API / Tool / Event / Extension contract
2. pi-orchestrator-side adapter or wrapper
3. safe blocked / unsupported behavior
4. upstream fix/release, without depending on a local fork or patch
```

## 12. Development / Test Process Boundary

Herdr is not a pi-orchestrator runtime integration. It is the development/test terminal harness used when a test must start a real Pi process.

For Integration / Smoke Tests:

```text
current Herdr workspace
    ↓
new tab
    ↓
root pane
    ↓
Pi
```

The test harness must create a new Herdr tab in `HERDR_WORKSPACE_ID`, use the repository as the tab working directory, obtain the root pane ID, and start Pi in that pane with Herdr's agent lifecycle command.

The runtime source tree must not add `runtime/integrations/herdr.ts` for v1. Herdr-specific automation belongs to the test/development harness only.

`tmux` is not part of the supported development/test process topology.

