# Integrations

Version: 1.0

## 1. 目的

pi-orchestrator と外部 component の接続境界を定義する。

対象:

- Pi
- pi-subagents
- Jev / TypeSafe System One
- Plannotator
- pi-ketch
- pi-ask-user-question
- grilling
- Ponytail

---

## 2. Integration Principles

```text
External Component
        ↕
runtime/integrations/*
        ↕
Orchestrator
```

- 外部 API schema を core に漏らさない
- External result を domain decision/event/artifact に正規化する
- State に live object / callback を保存しない
- silent fallback を避ける

---

## 3. Pi

Host Runtime。

- Extension lifecycle
- Command / Tool / Event
- Main Agent
- TUI

`core/` は Pi API に依存しない。

---

## 4. pi-subagents

Agent Execution Plane。

利用:

- child agent launch
- parallel review
- status / resume
- retained child（可能時）
- worktree（将来）

Agent Mapping:

```text
scout                   workflow-scout
researcher              pi-ketch.researcher
planner                 planner
worker                  worker
reviewer                reviewer
simplicity-reviewer     ponytail-reviewer
```

Jev は Agent として起動しない。

---

## 5. Jev / TypeSafe System One

### Role

Decision Plane。

API adapter:

```text
runtime/integrations/jev.ts
```

TypeSafe System One は typed decision を返す external decision service として扱う。

v1 use:

```text
Coding Entry Routing
Finding Evaluation
Post-Implementation Round Decision
```

### API Boundary

External API 固有:

- authentication
- endpoint
- Noul / Choice / Score schema
- response probabilities/confidence
- usage metadata

は adapter 内に閉じ込める。

Core へは normalized decision のみ渡す。

### Failure

v1 は required integration。

Default:

```text
Jev unavailable
invalid response
schema mismatch
    ↓
fail closed
    ↓
integration-unavailable
    ↓
BLOCK
    ↓
blocked
```

一時的 integration failure を terminal `failed` としない。

LLM evaluator への automatic fallback は行わない。

復旧後 `/wf-resume` により reconciliation して再開する。

### Security

API key / secret を State / Artifact / task text に保存しない。

Pi / Extension secret configuration から runtime に供給する。

詳細は [decision-engine.md](./decision-engine.md)。

---

## 6. pi-ketch

External Research。

```text
pi-ketch.researcher
```

Tools:

- ketch_docs
- ketch_code
- ketch_search
- ketch_scrape

Boundary:

```text
workflow-scout
    → local facts

pi-ketch.researcher
    → external facts
```

v1.1 Context Routing で `RESEARCH` が選ばれた場合の executor 候補。

---

## 7. grilling

Human clarification methodology。

Main Pi Agent 側で利用。

```text
Orchestrator
    ↓
Clarification
    ↓
Main Agent
    ↓
grilling
    ↓
ask_user_question
```

Jev は Human-facing question text を生成しない。

v1.1 Context Routing で `CLARIFY` が選ばれた場合も、実際の clarification は grilling が担当する。

---

## 8. pi-ask-user-question

Structured Human Question UI。

通常 Grilling:

```text
Main Agent
→ ask_user_question tool
```

Orchestrator 自身の workflow control question が必要な場合のみ Extension-to-Extension API を利用する。

---

## 9. Plannotator

Human Approval Gate。

### Plan Review

```text
Plan
→ Plannotator
↔ Human
```

Approve:

```text
PLAN_APPROVED
```

Feedback:

```text
PLAN_FEEDBACK
```

### Code Review

```text
Implementation
→ Plannotator
↔ Human
```

Approve:

```text
CODE_APPROVED
```

Feedback:

```text
CODE_FEEDBACK
```

Jev は Plannotator Approval を代替しない。

---

## 10. Ponytail

Over-engineering review methodology。

```text
ponytail-reviewer
+
ponytail-review Skill
```

Structured finding を生成し、Jev Finding Evaluation へ渡す。

Ponytail 自身は Fix / Authority を持たない。

---

## 11. Main Pi Agent

責務:

- Human interaction
- Grilling
- clarification
- user-facing explanation

Persistent Workflow State の正本にはしない。

---

## 12. Error Normalization

例:

```text
pi-subagents temporary infrastructure error
    → integration-unavailable → blocked

pi-subagents child task failure
    → agent-failed（domain handling）

Jev unavailable
    → integration-unavailable → blocked

Jev schema mismatch
    → integration-unavailable / artifact-invalid

Plannotator identity mismatch
    → human-gate-error

ask_user_question unavailable
    → integration-unavailable
```

External error class を core に漏らさない。

---

## 13. Configuration Boundary

以下は external integration adapter ではなく Orchestrator Configuration が所有する。

- Jev confidence threshold
- logical execution tier → concrete provider/model mapping
- reasoning tier mapping
- max automated Fix rounds
- max stronger retries
- Jev endpoint / non-secret integration options

Secret / API key は State / Artifact に保存しない。

詳細は [configuration.md](./configuration.md)。

---

## 14. Resume

```text
State load
→ Artifact validation
→ External identity reconcile
→ Jev decision artifact freshness check
→ normal event/transition
```

Jev call を resume のたびに再実行しない。

---

## 15. v1.1+

### Jev

追加 candidate:

- Context Routing
- Conditional Stage Routing
- Escalation Target
- Validation Failure Classification

### Other

- multiple Coding Orchestration
- worktree provider
- Integration Orchestration
- CI gate

Human Gate authority は維持する。
