# Artifact Model

Version: 1.0

## 1. 目的

Workflow State、Agent output、Human Review、Jev Decision を durable contract / evidence として保存する方式を定義する。

---

## 2. Runtime Directory

```text
.pi/
└── orchestrator/
    └── runs/
        └── <workflow-id>/
            ├── state.json
            ├── context/
            │   ├── scout.md
            │   ├── research.md
            │   └── clarification.md
            ├── plans/
            │   ├── plan-v1.md
            │   └── ...
            ├── plan-reviews/
            ├── decisions/
            │   ├── execution-routing-1.json
            │   └── ...
            ├── implementation/
            ├── validation/
            ├── reviews/
            │   ├── correctness-1.json
            │   ├── ponytail-1.json
            │   ├── finding-evaluation-1.json
            │   ├── accepted-findings-1.json
            │   └── round-decision-1.json
            └── code-reviews/
```

---

## 3. State と Artifact

State:

- current phase
- authoritative refs
- plan version
- implementation revision
- review round
- external identities
- blockedFrom / blockedReason（blocked時）

Artifact:

- content
- evidence
- decision
- review
- validation

State に長文を入れない。

---

## 4. Jev Decision Artifact

Jev output は durable artifact として保存する。

Jev decision は Workflow State そのものではない。

```text
Jev
 ↓
Decision Artifact
 ↓
Artifact validation
 ↓
core policy
 ↓
Workflow Event
```

---

## 5. Execution Routing Artifact

```text
decisions/execution-routing-N.json
```

例:

```json
{
  "schemaVersion": 1,
  "planVersion": 3,
  "attempt": 1,
  "modelTier": "STANDARD",
  "reasoningTier": "HIGH",
  "confidence": 0.94
}
```

Concrete model/provider は runtime configuration で解決するため、この Artifact に固定名を保存しなくてもよい。

必要なら resolved execution profile を implementation evidence 側に保存する。

---

## 6. Structured Review Finding

Correctness / Ponytail は Jev Evaluation 用の共通 finding schema を返す。

例:

```json
{
  "schemaVersion": 1,
  "round": 1,
  "source": "correctness",
  "findings": [
    {
      "id": "C1",
      "category": "regression",
      "location": "src/auth.ts:42",
      "summary": "Refresh token expiry is not checked",
      "evidence": "The path accepts an expired token without an expiry guard.",
      "blocking": true
    }
  ]
}
```

Human-readable text を併記してもよいが、Decision Engine の入力正本は structured data とする。

---

## 7. Finding Evaluation Artifact

```text
reviews/finding-evaluation-N.json
```

例:

```json
{
  "schemaVersion": 1,
  "round": 1,
  "planVersion": 3,
  "implementationRevision": 2,
  "findings": [
    {
      "id": "P1",
      "evidenceSupported": {
        "value": true,
        "confidence": 0.97
      },
      "conflictsWithApprovedPlan": {
        "value": true,
        "confidence": 0.98
      },
      "inScope": {
        "value": true,
        "confidence": 0.99
      },
      "decision": "REJECT",
      "reasonCode": "approved-plan-conflict"
    }
  ]
}
```

---

## 8. Accepted Findings Artifact

```text
reviews/accepted-findings-N.json
```

例:

```json
{
  "round": 1,
  "accepted": [
    {
      "id": "C1",
      "source": "correctness"
    }
  ],
  "rejected": [
    {
      "id": "P1",
      "source": "ponytail",
      "reason": "approved-plan-conflict"
    }
  ],
  "escalated": []
}
```

Worker に Fix Authority として渡すのは `accepted` のみ。

---

## 9. Round Decision Artifact

```text
reviews/round-decision-N.json
```

例:

```json
{
  "schemaVersion": 1,
  "round": 1,
  "implementationRevision": 2,
  "decision": "RETRY",
  "confidence": 0.96,
  "reason": "accepted-blocking-findings"
}
```

ESCALATE 例:

```json
{
  "schemaVersion": 1,
  "round": 2,
  "implementationRevision": 3,
  "decision": "ESCALATE",
  "confidence": 0.91,
  "escalationReason": "plan-conflict"
}
```

---

## 10. Validation Artifact

Validation pass/fail は deterministic。

```json
{
  "revision": 2,
  "status": "failed",
  "checks": [
    {
      "name": "test",
      "status": "failed",
      "evidence": "..."
    },
    {
      "name": "typecheck",
      "status": "passed"
    }
  ]
}
```

Jev は `status` 自体を決めない。

この Artifact を Round Decision evidence として利用する。

---

## 11. Plan Artifact / Validation Contract

Initial Scope では Architecture / Design と Validation Contract は Planner が Plan 内に持つ。

Plan の推奨構造:

```text
plans/plan-vN.md
    ├─ Scope / Requirements
    ├─ Architecture / Design（必要時）
    ├─ Implementation Plan
    └─ Validation Contract
```

Validation Contract は Implementation 後の deterministic validation の正本。

例:

```text
- project test command
- typecheck
- lint
- build
- task-specific regression / focused verification
```

独立した `architecture.md` は Initial Scope の必須 Artifact としない。

---

## 12. Plan / Human Review

Plan proposal と approved authority を分離する。

```text
currentPlanRef
approvedPlanRef
```

Human Plan Approval 後のみ `approvedPlanRef` を設定する。

Human Code Approval は current implementation revision と結びつける。

---

## 13. Producer / Consumer Matrix

| Artifact | Producer | Consumer |
|---|---|---|
| scout | workflow-scout | planner |
| research | pi-ketch.researcher | planner |
| clarification | Main Agent + Human | planner |
| plan + Architecture/Design + Validation Contract | planner | Plannotator / worker / validation / Jev routing |
| execution routing | Jev + policy | worker |
| implementation evidence | worker/pi-subagents | validation/review |
| validation | deterministic tools | Jev round decision |
| correctness findings | reviewer | Jev finding evaluation |
| ponytail findings | ponytail-reviewer | Jev finding evaluation |
| finding evaluation | Jev + policy | Orchestrator |
| accepted findings | Orchestrator policy | worker |
| round decision | Jev + policy | Orchestrator |
| code review | Plannotator + Human | Orchestrator |

---

## 14. Decision Artifact Freshness

Decision artifact 再利用条件:

- schemaVersion 一致
- planVersion 一致
- implementationRevision 一致
- input refs 一致
- relevant policy version 一致

いずれかが変わった場合 stale。

---

## 15. Authority Rules

### AR-001

Agent output は evidence であり State Transition Authority ではない。

### AR-002

Jev output は decision evidence であり State Transition Authority ではない。

### AR-003

Orchestrator policy が valid decision artifact を Workflow Event に変換する。

### AR-004

Human Plan Approval のみが Plan に Implementation Authority を与える。

### AR-005

Human Code Approval のみが Workflow Completion Authority を与える。

### AR-006

Raw Finding は Fix Authority を持たない。

### AR-007

Accepted Findings のみ Fix Authority を持つ。

---

## 16. Persistence Ordering

原則:

```text
1. input artifact validation
2. external execution / Jev decision
3. output artifact validation
4. output artifact persistence
5. State reference update
6. State persistence
7. next side effect
```

---

## 17. Resume

Resume 正本:

```text
State
+
Authoritative Artifacts
+
Decision Artifacts
+
External Identities
```

Valid decision artifact が current input と一致する場合は再利用可能。

一致しなければ Jev 再評価。

---

## 18. Future Scope

追加 candidate artifact:

```text
decisions/context-routing-*.json
decisions/conditional-stage-*.json
decisions/escalation-target-*.json
decisions/validation-failure-*.json
```

必要になるまで directory/file placeholder は作成しない。
