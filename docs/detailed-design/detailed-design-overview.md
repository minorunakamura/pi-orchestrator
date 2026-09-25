# Pi Orchestrator Detailed Design Overview

Version: 1.0

## 1. Purpose

This document defines the detailed design boundary for pi-orchestrator v1.0.

The following Basic Design documents are authoritative and are not changed by this detailed design:

1. [basic-design.md](../basic-design/basic-design.md)
2. [state-machine.md](../basic-design/state-machine.md)
3. [decision-engine.md](../basic-design/decision-engine.md)
4. [artifacts.md](../basic-design/artifacts.md)
5. [integrations.md](../basic-design/integrations.md)
6. [configuration.md](../basic-design/configuration.md)
7. [directory-structure.md](../basic-design/directory-structure.md)

## 2. v1 Design Boundary

The following rules are mandatory:

- Only the Orchestrator mutates Workflow State.
- Jev returns bounded typed decision evidence only.
- Agents generate or inspect work but do not mutate Workflow State.
- Deterministic validation decides test/build/lint/typecheck success or failure.
- Human Plan Approval is required before implementation authority exists.
- Human Code Approval is required before workflow completion.
- Validation failure does not directly transition the workflow.
- Raw review findings are not fix authority; only Accepted Findings are.
- State persistence must succeed before the next stage side effect begins.
- Retry loops are bounded and transition to `blocked` when exhausted.

## 3. v1 Scope Out

The following Basic Design v1.1+ items are intentionally excluded:

- Multiple Coding Orchestrations
- Work Package DAG
- Integration Orchestration
- Jev Context Routing
- Jev Conditional Stage Routing
- Jev Escalation Target selection
- Validation Failure Semantic Classification
- Agent Trace observability decisions
- Dynamic Reviewer selection
- Adaptive multi-stage model routing

## 4. Detailed Design Documents

- [domain-model.md](./domain-model.md)
- [runtime-design.md](./runtime-design.md)
- [planning-orchestration.md](./planning-orchestration.md)
- [coding-orchestration.md](./coding-orchestration.md)
- [persistence-recovery.md](./persistence-recovery.md)
- [test-strategy.md](./test-strategy.md)
- [implementation-plan.md](../implementation/implementation-plan.md)

## 5. Resolved Detailed-Design Interpretations

These interpretations do not change Basic Design v1.0.

### 5.1 `architecture/`

[directory-structure.md](../basic-design/directory-structure.md) shows an `architecture/` runtime directory, while [artifacts.md](../basic-design/artifacts.md) states that a standalone architecture artifact is not required in v1.

Resolution:

- Do not create `architecture/` eagerly.
- Architecture / Design remains part of `plan-vN.md` in v1.
- Create the directory only if a real artifact is introduced later.

### 5.2 Clarification routing evidence

`CLARIFICATION_REQUIRED.reasonRef` may refer to a decision artifact when clarification was triggered by Coding Orchestration.

No new workflow event field is added.

### 5.3 Retry accounting

Automated retry budget and Human Code Feedback are counted separately.

Human Code Feedback does not consume the automated retry budget.

### 5.4 Stronger retry

Stronger retry uses a deterministic monotonic escalation rule defined in `coding-orchestration.md`.

This is not Jev Escalation Target selection and therefore remains within v1.

## 6. Remaining Configuration Values

The following are configuration values rather than architecture decisions:

- Jev `autoDecisionThreshold`
- Jev `escalationThreshold`
- `ECONOMY` execution profile mapping
- `STANDARD` execution profile mapping
- `STRONG` execution profile mapping
- reasoning tier to concrete thinking-level mapping
- Jev transport timeout / transport retry settings
- each Playbook's required / conditional / skip matrix

These values can be finalized without changing the domain architecture.
