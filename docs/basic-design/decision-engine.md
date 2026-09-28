# Jev Decision Engine

Version: 1.0

## 1. 目的

本書は pi-orchestrator における Jev の責務、Decision Contract、Initial Scope の利用箇所、Policy Boundary、Failure Handling、Future Scope の拡張方針を定義する。

Jev は Workflow の生成主体ではない。

```text
Unstructured / Structured Evidence
              ↓
             Jev
              ↓
Typed probabilistic decisions
              ↓
Deterministic Orchestrator Policy
              ↓
Routing / State Event
```

---

## 2. 基本原則

### DE-001: Decisions, not generation

Jev は以下を生成しない。

- source code
- Plan
- Architecture document
- Review本文
- Human-facing clarification text

### DE-002: Deterministic first

コードで確定できるものはコードで判定する。

例:

```text
exitCode == 0
Artifact exists
planVersion matches
reviewRevision matches
```

### DE-003: Human Gate is not replaceable

Jev は以下を代替しない。

- Plan Approval
- Final Code Approval
- Product Decision

### DE-004: Jev does not mutate State

Jev output は Decision Evidence。

State mutation は Orchestrator が行う。

### DE-005: Bounded output

Jev に free-form action を生成させない。

Noul / Choice / Score 等の事前定義された typed decision を利用する。

---

## 3. Core Decision Contract

Jev API 固有型を `core/` に持ち込まない。

概念:

```ts
export interface Decision<T> {
  value: T;
  confidence: number;
}

export type DecisionResult<T> =
  | {
      status: "decided";
      decision: Decision<T>;
    }
  | {
      status: "uncertain";
      reason: string;
    };
```

Jev response normalization は `runtime/integrations/jev.ts` が担当する。

---

## 4. Initial Scope Decision Point A: Coding Entry Routing

### Goal

Approved Plan に対して適切な execution profile を選ぶ。

### Input

最低限:

- approved plan summary / relevant sections
- change scope
- repository context / Approved Plan の Architecture・Design section
- playbook
- prior retry count（Fix時）

### Output

例:

```ts
type ModelTier =
  | "ECONOMY"
  | "STANDARD"
  | "STRONG";

type ReasoningTier =
  | "LOW"
  | "MEDIUM"
  | "HIGH";
```

Decision artifact:

```json
{
  "modelTier": "STANDARD",
  "reasoningTier": "HIGH",
  "confidence": 0.94
}
```

### Concrete Model Mapping

core decision は provider/model 名を知らない。

```text
STANDARD + HIGH
    ↓
Configuration
    ↓
actual provider/model/thinking
```

Model catalog の変更で Decision Contract を変更しない。

### Low Confidence

Initial Scope の default policy:

```text
low confidence
    → safe stronger profile
```

または operator configuration により fail-closed にできる。

---

## 5. Initial Scope Decision Point B: Finding Evaluation

### Goal

Reviewer finding が実際の Fix Authority を持つべきか評価する。

### Input Finding Contract

例:

```ts
interface ReviewFinding {
  id: string;
  source: "correctness" | "ponytail";
  category: string;
  location?: string;
  summary: string;
  evidence: string;
  blocking: boolean;
}
```

### Narrow Decisions

Finding ごとに以下のような判断を行う。

```text
evidenceSupported?
conflictsWithApprovedPlan?
conflictsWithApprovedArchitectureDecision?
inScope?
requiresHumanDecision?
```

### Final Policy

最終 `ACCEPT / REJECT / ESCALATE` は code policy が決定する。

例:

```text
plan conflict
    → REJECT または ESCALATE

human decision required
    → ESCALATE

evidence supported
AND in scope
AND no approved-plan conflict
    → ACCEPT

insufficient confidence
    → ESCALATE
```

### Output Artifact

```json
{
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
      "decision": "REJECT",
      "reasonCode": "approved-plan-conflict"
    }
  ]
}
```

---

## 6. Initial Scope Decision Point C: Post-Implementation Round Decision

### Goal

現在の Coding round をどう扱うか決める。

Choice:

```text
COMPLETE
RETRY
ESCALATE
```

### Input

- deterministic validation result
- accepted/rejected/escalated finding summary
- approved plan reference / relevant constraints
- current implementation revision
- retry count
- previous decision evidence

### Hard Rules

以下は Jev より優先する。

```text
validation failed
    → COMPLETE forbidden

accepted blocking finding exists
    → COMPLETE forbidden

Human approval missing
    → Workflow completed forbidden
```

### COMPLETE

Automated Coding Stage が clean。

次:

```text
awaiting-code-review
```

### RETRY

現在の Approved Plan の範囲内で修正可能。

次:

```text
fixing
```

### ESCALATE

現在の execution loop だけでは安全に解決できない。

Initial Scope は reason classification + deterministic target mapping を使用する。

---

## 7. Initial Scope Escalation Reason

例:

```ts
type EscalationReason =
  | "implementation-capability"
  | "plan-conflict"
  | "human-decision"
  | "uncertain";
```

Initial Scope mapping:

| Reason | Target |
|---|---|
| `implementation-capability` | stronger execution profile + Fix |
| `plan-conflict` | Planning |
| `human-decision` | Clarification → Planning |
| `uncertain` | Clarification / Human attention |

`plan-conflict` で Planning に戻る際は current `approvedPlanRef` を Implementation Authority として無効化し、新 Plan を Human Plan Gate に通す。

---

## 8. Decision Pipeline

```text
Worker
  ↓
Deterministic Validation
  │
  ├─ fail
  │    ↓
  │  Jev Round Decision
  │    ├─ RETRY
  │    └─ ESCALATE
  │
  └─ pass
       ↓
    Parallel Review
       ↓
  Structured Findings
       ↓
  Jev Finding Evaluation
       ↓
 accepted/rejected/escalated
       ↓
  Jev Round Decision
       ├─ RETRY
       ├─ ESCALATE
       └─ COMPLETE
```

Validation が失敗している round では expensive reviewer fanout を skip して Round Decision に進むことを許可する。

---

## 9. Confidence Policy

Jev confidence は State Transition そのものではない。

core policy が threshold を適用する。

例:

```ts
interface ConfidencePolicy {
  autoDecisionThreshold: number;
  escalationThreshold: number;
}
```

Threshold は configuration で管理可能とする。

Initial Scope では conservative default を採用する。

Low-confidence decision を silent accept しない。

---

## 10. Jev Failure Handling

Initial Scope では Jev は required integration。

以下を silent fallback しない。

```text
Jev unavailable
invalid response
schema mismatch
unsupported model/API response
```

Default:

```text
fail closed
→ integration-unavailable
→ BLOCK
→ blocked
```

terminal `failed` にはしない。

Workflow は Jev 復旧後 `/wf-resume` により reconciliation し、元の Phase から再開可能とする。

LLM evaluator への自動 fallback は Initial Scope では行わない。

将来 configuration により explicit fallback policy を追加可能とする。

---

## 11. Persistence

Jev decision は durable artifact とする。

Decision reuse 条件:

- input artifact refs が一致
- plan version が一致
- implementation revision が一致
- decision schema version が一致

一致しない場合は stale decision として再利用しない。

---

## 12. Retry / Configuration Policy

Decision Engine が自動 loop を無制限に継続させてはならない。

Initial Scope recommended defaults:

```text
maxAutomatedFixRounds = 3
maxStrongerRetries    = 1
```

値は [configuration.md](./configuration.md) の Orchestrator Configuration が所有する。

上限到達時:

```text
retry budget exhausted
    ↓
BLOCK
    ↓
blocked
```

Jev confidence threshold、modelTier mapping、reasoningTier mapping も Configuration が所有する。

---

## 13. Future Scope: Context Routing

Candidate:

```text
READY
RESEARCH
CLARIFY
RESEARCH_AND_CLARIFY
```

Input:

- Scout context
- unresolved factual gaps
- external dependency signals

Jev は Research 内容を生成しない。

`RESEARCH` の場合、実際の調査は `pi-ketch.researcher` が行う。

---

## 14. Future Scope: Conditional Stage Decision

Playbook:

```text
required
conditional
skip
```

Rule:

```text
required
    → code: RUN

skip
    → code: SKIP

conditional
    → Jev: RUN / SKIP / ESCALATE
```

Candidate stages:

- Research
- Clarification
- Architecture
- Human Plan Review（Playbook が conditional の場合のみ）

Human Gate の「Approve」は Jev に代替させない。

---

## 15. Future Scope: Escalation Target

Initial Scope は reason → target を code で mapping する。

Future Scope candidate:

```text
STRONGER_WORKER
PLANNING
HUMAN
```

Jev に bounded Choice として target を選択させる。

Orchestrator policy が allowed target を制限する。

---

## 16. Future Scope: Validation Failure Classification

deterministic result:

```text
test failed
```

意味分類:

```text
IMPLEMENTATION_BUG
TEST_EXPECTATION_STALE
ENVIRONMENT_FAILURE
PLAN_CONFLICT
UNCERTAIN
```

exit code 自体の判定は code。

failure log の意味分類のみ Jev。

---

## 17. Future Scope Candidate

### Agent Trace Observability

Agent run summary / tool activity / result を評価し:

```text
AUTO_CONTINUE
HUMAN_REVIEW
PRIORITY_REVIEW
```

等へ route。

### Dynamic Reviewer Routing

変更内容に応じて Reviewer set を選択。

### Adaptive Model Routing

Coding Entry 以外にも model tier / reasoning tier を適用。

### Multiple Coding Orchestration

Work Package priority、risk、parallelism candidate の decision support。

---

## 18. Jevを使わない場所

| Area | Reason |
|---|---|
| Scout | exploration / evidence generation |
| Research | search / source retrieval |
| Grilling | Human interaction |
| Planning | long-form generation |
| Coding | code generation |
| Correctness Review | finding generation |
| Ponytail Review | finding generation |
| test/build/lint result | deterministic |
| State version check | deterministic |
| Plan Approval | Human authority |
| Code Approval | Human authority |
| State mutation | Orchestrator authority |

---

## 19. References

- TypeSafe API: https://api.typesafe.ai/docs
- TypeSafe System One / Jev overview: https://typesafe.ai/blog/introducing-system-one-models-and-jev
- Workflow evals: https://evals.typesafe.ai/
