# Directory Structure

Version: 1.1

## 1. 目的

pi-orchestrator package のソースコード、Agent、Test、Document、Runtime Artifact の配置と依存方向を定義する。

---

## 2. 推奨構成

```text
pi-orchestrator/
├── src/
│   ├── index.ts
│   │
│   ├── commands/
│   │   ├── index.ts
│   │   ├── wf-new.ts
│   │   ├── wf-feature.ts
│   │   ├── wf-bugfix.ts
│   │   ├── wf-hotfix.ts
│   │   ├── wf-chore.ts
│   │   ├── wf-resume.ts
│   │   └── wf-status.ts
│   │
│   ├── tools/
│   │   └── index.ts
│   │
│   ├── events/
│   │   ├── index.ts
│   │   ├── session-start.ts
│   │   └── session-shutdown.ts
│   │
│   ├── ui/
│   │   ├── index.ts
│   │   └── workflow-status.ts
│   │
│   ├── runtime/
│   │   ├── orchestrator/
│   │   │   ├── start-workflow.ts
│   │   │   ├── resume-workflow.ts
│   │   │   ├── run-planning.ts
│   │   │   ├── run-coding.ts
│   │   │   └── advance-workflow.ts
│   │   │
│   │   ├── integrations/
│   │   │   ├── subagents.ts
│   │   │   ├── plannotator.ts
│   │   │   ├── ask-user-question.ts
│   │   │   └── jev.ts
│   │   │
│   │   ├── configuration/
│   │   │   └── load-configuration.ts
│   │   │
│   │   └── persistence/
│   │       ├── load-state.ts
│   │       ├── save-state.ts
│   │       └── artifacts.ts
│   │
│   ├── core/
│   │   ├── workflow/
│   │   │   ├── state.ts
│   │   │   ├── transition.ts
│   │   │   ├── phase.ts
│   │   │   └── errors.ts
│   │   │
│   │   ├── decisions/
│   │   │   ├── types.ts
│   │   │   ├── confidence-policy.ts
│   │   │   ├── execution-routing.ts
│   │   │   ├── finding-evaluation.ts
│   │   │   ├── round-decision.ts
│   │   │   └── escalation-policy.ts
│   │   │
│   │   ├── playbooks/
│   │   │   ├── new-project.ts
│   │   │   ├── feature.ts
│   │   │   ├── bugfix.ts
│   │   │   ├── hotfix.ts
│   │   │   └── chore.ts
│   │   │
│   │   ├── planning/
│   │   │   └── policy.ts
│   │   │
│   │   ├── coding/
│   │   │   ├── review-policy.ts
│   │   │   └── finding.ts
│   │   │
│   │   └── artifacts/
│   │       └── references.ts
│   │
│   └── types.ts
│
├── agents/
│   ├── workflow-scout.md
│   ├── planner.md
│   └── ponytail-reviewer.md
│
├── skills/
│   └── ...
│
├── tests/
│   ├── core/
│   │   ├── workflow/
│   │   ├── decisions/
│   │   ├── playbooks/
│   │   └── coding/
│   ├── runtime/
│   ├── commands/
│   ├── events/
│   └── agents/
│
├── docs/
│   ├── basic-design.md
│   ├── state-machine.md
│   ├── decision-engine.md
│   ├── configuration.md
│   ├── directory-structure.md
│   ├── artifacts.md
│   └── integrations.md
│
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── README.md
└── LICENSE
```

不要な directory は先行して作らない。

---

## 3. 依存方向

```text
commands / tools / events / ui
              ↓
           runtime
              ↓
             core
```

Jev integration:

```text
core/decisions/*
       ↑
normalized decision
       │
runtime/integrations/jev.ts
       ↑
TypeSafe / Jev API
```

禁止:

```text
core → runtime
core → Pi API
core → TypeSafe API SDK
core → Plannotator API
core → pi-subagents API
```

---

## 4. `runtime/integrations/jev.ts`

責務:

- Jev/System One request の構築
- API authentication / transport
- Noul / Choice / Score response の normalization
- confidence の normalization
- schema / API error normalization
- usage metadata 取得（必要時）

持たない責務:

- Workflow State mutation
- ACCEPT/REJECT policy の business rule
- concrete State Transition
- Human Gate decision

---

## 5. `core/decisions/`

Jev 非依存の Decision Domain。

### `types.ts`

- `Decision<T>`
- execution profile types
- finding decision types
- round decision types
- escalation reason types

### `confidence-policy.ts`

- auto decision threshold
- uncertain threshold
- fail-safe rule

### `execution-routing.ts`

Jev normalized result から logical execution profile を確定する pure logic。

### `finding-evaluation.ts`

Noul / Choice result を:

```text
ACCEPT
REJECT
ESCALATE
```

へ変換する policy。

### `round-decision.ts`

```text
COMPLETE
RETRY
ESCALATE
```

の hard invariant / override rule。

### `escalation-policy.ts`

Initial Scope:

```text
reason
→ deterministic target
```

Future Scope では Jev-selected target へ拡張可能。

---

## 6. Configuration

### `core/configuration.ts`

Pi / filesystem 非依存の Configuration schema / defaults / validation を定義する。

所有する値:

- Jev confidence thresholds
- logical execution tier mapping key
- max automated Fix rounds
- max stronger retries
- validation execution policy

### `runtime/configuration/load-configuration.ts`

Pi settings / package settings / environment から runtime configuration を読み込む。

Secret は domain configuration object に永続化しない。

詳細は [configuration.md](./configuration.md)。

---

## 7. Agent Definitions

Initial Scope custom Agent:

```text
workflow-scout
planner
ponytail-reviewer
```

これらは pi-orchestrator package が提供する **product custom Agent definition** であり、実装開始前から development environment に登録済みであることを前提にしない。

Development-time の repository 調査や correctness review では、その時点で利用可能な pi-subagents builtin agent を使用してよい。ただし builtin agent は上記 custom Agent の実装物ではなく、product runtime の Agent Mapping を満たしたことにはならない。

特に generic reviewer を `ponytail-reviewer` と同一視してはならない。代替レビューを行った場合は、その事実を development evidence として明示する。

各 custom Agent definition を導入する Story は [Implementation Plan](../implementation/implementation-plan.md) を正本とする。

Finding evaluator Agent は作成しない。

Finding Evaluation は Jev + core policy が担当する。

---

## 8. Runtime Artifact Directory

```text
.pi/
└── orchestrator/
    └── runs/
        └── <workflow-id>/
            ├── state.json
            ├── context/
            ├── architecture/
            ├── plans/
            ├── plan-reviews/
            ├── decisions/
            │   └── execution-routing-*.json
            ├── implementation/
            ├── validation/
            ├── reviews/
            │   ├── correctness-*.json
            │   ├── ponytail-*.json
            │   ├── finding-evaluation-*.json
            │   ├── accepted-findings-*.json
            │   └── round-decision-*.json
            └── code-reviews/
```

詳細は [artifacts.md](./artifacts.md)。

---

## 9. Tests

`tests/core/decisions/` を Initial Scope の重点 area とする。

Test 対象:

- Jev normalized decision → policy result
- confidence threshold
- hard rule override
- validation failure で COMPLETE 禁止
- blocking finding で COMPLETE 禁止
- escalation reason mapping
- stale decision detection

`runtime/integrations/jev.ts` は API mock / fixture を利用して test する。

---

## 10. Documentation

```text
basic-design.md
    WHAT / WHY

state-machine.md
    WHEN / TRANSITION

decision-engine.md
    JEV DECISION CONTRACT

configuration.md
    CONFIG / RETRY / MODEL MAPPING

directory-structure.md
    WHERE

artifacts.md
    DATA / AUTHORITY

integrations.md
    EXTERNAL CONNECTION
```

---

## 11. Future Scope Directory Extension

必要性が明確になった時点で追加候補:

```text
core/decisions/
├── context-routing.ts
├── conditional-stage.ts
├── escalation-target.ts
└── validation-failure.ts
```

Initial Scope では空 file / Future Scope placeholder を作成しない。
