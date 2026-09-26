# Workflow State Machine

Version: 1.0

## 1. 目的

本書は pi-orchestrator の Workflow State Machine を定義する。

Jev は State Machine の外側にある Decision Engine であり、State を直接変更しない。

```text
Evidence
   ↓
Jev Decision
   ↓
Orchestrator Policy
   ↓
Workflow Event
   ↓
State Transition
```

---

## 2. Workflow Phase

```ts
export type WorkflowPhase =
  | "gathering-context"
  | "clarifying"
  | "planning"
  | "awaiting-plan-review"
  | "implementing"
  | "validating"
  | "reviewing"
  | "fixing"
  | "awaiting-code-review"
  | "blocked"
  | "completed"
  | "failed";
```

分類:

```text
Planning Orchestration
  gathering-context
  clarifying
  planning

Human Plan Gate
  awaiting-plan-review

Coding Orchestration
  implementing
  validating
  reviewing
  fixing

Human Code Gate
  awaiting-code-review

Recoverable Suspension
  blocked

Terminal
  completed
  failed
```

---

## 3. Event Model

```ts
export type WorkflowEvent =
  | { type: "CONTEXT_READY" }
  | { type: "CLARIFICATION_REQUIRED"; reasonRef?: string }
  | { type: "CLARIFICATION_COMPLETE"; clarificationRef: string }

  | { type: "PLAN_CREATED"; planRef: string; version: number }
  | { type: "PLAN_APPROVED"; planRef: string; version: number }
  | { type: "PLAN_FEEDBACK"; feedbackRef: string }
  | { type: "REPLAN_REQUIRED"; decisionRef: string }

  | { type: "EXECUTION_ROUTED"; decisionRef: string }
  | { type: "IMPLEMENTATION_COMPLETE"; resultRef: string; runId?: string }

  | { type: "VALIDATION_PASSED"; resultRef: string }
  | { type: "REVIEW_ARTIFACTS_PERSISTED"; correctnessReviewRef: string; ponytailReviewRef: string }

  | { type: "RETRY_REQUIRED"; decisionRef: string; findingsRef?: string; validationRef?: string }
  | { type: "REVIEW_RETRY_REQUIRED"; decisionRef: string; findingsRef?: string }
  | { type: "STRONGER_RETRY_REQUIRED"; decisionRef: string; findingsRef?: string }
  | { type: "REVIEW_COMPLETE"; decisionRef: string }

  | { type: "CODE_APPROVED"; reviewRef: string }
  | { type: "CODE_FEEDBACK"; feedbackRef: string }

  | { type: "BLOCK"; reason: BlockedReason; evidenceRef?: string }
  | { type: "BLOCK_RESOLVED"; evidenceRef?: string }
  | { type: "FAIL"; reason: FailureReason; evidenceRef?: string };
```

---

## 4. High-Level Diagram

```text
gathering-context
      │
      ├─ clarification required
      │        ↓
      │    clarifying
      │        │
      └────────┴────────→ planning
                             │
                             ↓
                   awaiting-plan-review
                    │               │
             feedback               approve
                    │               │
                    └→ planning     ↓
                               implementing
                               [Jev routing]
                                    ↓
                                validating
                               /           \
                          failed             pass
                            │                 ↓
                            │              reviewing
                            │             [Jev eval]
                            │            /    |    \
                            │       retry complete escalate
                            │          │      │       │
                            └──────→ fixing   │       ├→ stronger fixing
                                      ↑       │       ├→ planning
                                      │       │       └→ clarifying
                                      │       ▼
                                      │ awaiting-code-review
                                      │      /        \
                                      └─feedback      approve
                                                       ↓
                                                    completed
```

---

## 5. Transition Table

| Current | Event | Guard | Next | Action |
|---|---|---|---|---|
| `gathering-context` | `CONTEXT_READY` | unresolved decision なし | `planning` | context refs 保存 |
| `gathering-context` | `CLARIFICATION_REQUIRED` | Human decision 必要 | `clarifying` | reason 保存 |
| `clarifying` | `CLARIFICATION_COMPLETE` | unresolved decision なし | `planning` | clarificationRef 保存 |
| `planning` | `PLAN_CREATED` | artifact valid | `awaiting-plan-review` | currentPlanRef/version 更新 |
| `awaiting-plan-review` | `PLAN_FEEDBACK` | feedback valid | `planning` | feedbackRef 保存 |
| `awaiting-plan-review` | `PLAN_APPROVED` | current plan と一致 | `implementing` | approvedPlanRef 固定 |
| `implementing` | `EXECUTION_ROUTED` | current approved plan 対象 | `implementing` | executionProfileRef 保存 |
| `implementing` | `IMPLEMENTATION_COMPLETE` | execution profile 有効 | `validating` | revision/result 更新 |
| `validating` | `VALIDATION_PASSED` | Validation Contract の required checks pass | `reviewing` | validationRef 保存 |
| `reviewing` | `REVIEW_ARTIFACTS_PERSISTED` | correctness / Ponytail Artifact が schema-valid | `reviewing` | raw review refs 保存（Fix authority なし） |
| `validating` | `RETRY_REQUIRED` | Jev Round Decision + policy が retry | `fixing` | validationRef / decisionRef 保存 |
| `validating` | `STRONGER_RETRY_REQUIRED` | stronger retry budget あり | `fixing` | stronger profile / decisionRef 保存 |
| `validating` | `REPLAN_REQUIRED` | approved plan conflict | `planning` | approvedPlanRef 無効化 |
| `validating` | `CLARIFICATION_REQUIRED` | Human decision needed | `clarifying` | decisionRef 保存 |
| `reviewing` | `REVIEW_RETRY_REQUIRED` | Jev decision valid | `fixing` | acceptedFindingsRef 保存 |
| `reviewing` | `STRONGER_RETRY_REQUIRED` | stronger retry budget あり | `fixing` | stronger profile 保存 |
| `reviewing` | `REPLAN_REQUIRED` | approved plan invalidated | `planning` | approvedPlanRef 無効化 |
| `reviewing` | `CLARIFICATION_REQUIRED` | Human decision needed | `clarifying` | decisionRef 保存 |
| `reviewing` | `REVIEW_COMPLETE` | validation pass + blocking finding なし | `awaiting-code-review` | roundDecisionRef 保存 |
| `fixing` | `IMPLEMENTATION_COMPLETE` | result valid | `validating` | revision++ |
| `awaiting-code-review` | `CODE_FEEDBACK` | current revision 対象 | `fixing` | human feedback 保存 |
| `awaiting-code-review` | `CODE_APPROVED` | current revision 対象 | `completed` | completion evidence 保存 |
| active state | `BLOCK` | recovery可能だが現在続行不能 | `blocked` | `blockedFrom` / reason / evidence 保存 |
| `blocked` | `BLOCK_RESOLVED` | dependency recovery / reconciliation successful | `blockedFrom` | block metadata を解消 |
| active state | `FAIL` | authority/state を安全に再構築不能 | `failed` | failure evidence 保存 |
---

## 6. Jev Coding Entry Routing

`PLAN_APPROVED` 後、Worker 起動前に Jev decision を取得する。

State:

```text
implementing
```

Artifact:

```text
decisions/execution-routing-N.json
```

`EXECUTION_ROUTED` は self-transition。

Decision persistence 成功後のみ Worker を起動する。

---

## 7. Validation

Validation は Approved Plan 内の `Validation Contract` を正本として deterministic に実行する。

pass / fail は code で判定する。

```text
exit code
test result
typecheck result
lint result
build result
focused verification
```

を Jev に決めさせない。

### Passed

```text
Validation Contract satisfied
    ↓
VALIDATION_PASSED
    ↓
reviewing
```

### Failed

Validation failure 自体は Workflow Transition Event としない。

```text
Validation failure
      ↓
Validation Artifact を保存
      ↓
Jev Round Decision
      ↓
Orchestrator policy
      ↓
RETRY_REQUIRED
STRONGER_RETRY_REQUIRED
REPLAN_REQUIRED
CLARIFICATION_REQUIRED
```

これにより、1つの Event から複数 Next State に分岐する曖昧な Transition を避ける。

Validation failure round では Reviewer fanout を省略可能。

Retry budget が exhausted の場合は:

```text
BLOCK
→ blocked
```

とし、silent infinite loop を禁止する。
---

## 8. Reviewing

Parallel Review:

```text
Correctness Reviewer
Ponytail Reviewer
```

両者は structured finding を生成する。

その後:

```text
Structured Findings
      ↓
Jev Finding Evaluation
      ↓
evaluation artifact
      ↓
Jev Round Decision
```

### RETRY

```text
REVIEW_RETRY_REQUIRED
→ fixing
```

### ESCALATE: capability

```text
STRONGER_RETRY_REQUIRED
→ fixing
```

### ESCALATE: plan conflict

```text
REPLAN_REQUIRED
→ planning
```

この時 `approvedPlanRef` を authority として無効化する。

### ESCALATE: human decision

```text
CLARIFICATION_REQUIRED
→ clarifying
→ planning
→ Human Plan Gate
```

### COMPLETE

```text
REVIEW_COMPLETE
→ awaiting-code-review
```

---

## 9. Human Gates

### Plan Gate

禁止:

```text
planning ─X→ implementing
```

必須:

```text
planning
→ awaiting-plan-review
→ PLAN_APPROVED
→ implementing
```

### Code Gate

禁止:

```text
reviewing ─X→ completed
```

必須:

```text
reviewing
→ REVIEW_COMPLETE
→ awaiting-code-review
→ CODE_APPROVED
→ completed
```

---

## 10. Blocked / Failed

### blocked

一時的・運用上の原因で現在続行できないが、原因解消後に resume 可能。

State は最低限以下を保持する。

```text
blockedFrom
blockedReason
evidenceRef
```

代表例:

- Jev / TypeSafe API unavailable
- Plannotator unavailable
- pi-subagents infrastructure unavailable
- retry budget exhausted and Human attention required

### failed

通常の resume を許可しない terminal state。

代表例:

- persisted State corruption
- authoritative Artifact loss / corruption
- impossible transition
- Authority reconstruction impossible

`blocked` と `failed` を同一視しない。

---

## 11. Invariants

### INV-001

Only Orchestrator mutates Workflow State.

### INV-002

`implementing` 以降は valid `approvedPlanRef` が必要。ただし `REPLAN_REQUIRED` 発生時は authority を無効化し `planning` に戻る。

### INV-003

Jev output 自体は State Transition ではない。

### INV-004

Jev decision は deterministic policy を通して Workflow Event に変換する。

### INV-005

Validation failure がある round で `REVIEW_COMPLETE` を発生させてはならない。

### INV-006

accepted blocking finding がある round で `REVIEW_COMPLETE` を発生させてはならない。

### INV-007

Human Plan Approval なしに Implementation を開始しない。

### INV-008

Human Code Approval なしに `completed` へ遷移しない。

### INV-009

Jev decision artifact の input version/revision が current State と一致しなければ stale とする。

### INV-010

State persistence 成功前に次 Stage の side effect を開始しない。

### INV-011

Validation failure は直接 State Transition を起こさず、Decision Engine と Orchestrator policy が生成した routing event によって遷移する。

### INV-012

retry / stronger retry の上限到達後に自動 loop を継続しない。`blocked` へ遷移する。

---

## 12. Resume / Reconciliation

Resume は通常 Event へ復元する。

```text
Persisted State
      ↓
Artifacts / external status reconcile
      ↓
Decision artifact validation
      ↓
Normal Event
      ↓
Normal Transition
```

### Jev decision reuse

再利用条件:

- Plan version 一致
- implementation revision 一致
- input artifact refs 一致
- decision schema version 一致

不一致なら再評価する。

Jev unavailable の場合は fail-closed だが terminal `failed` にはせず `blocked` とする。復旧後 `/wf-resume` で reconciliation し、`BLOCK_RESOLVED` により元の Phase へ戻る。

---

## 13. Failure

`blocked` candidate:

- Jev / external integration unavailable
- retry budget exhausted
- temporary child infrastructure failure

`failed` candidate:

- artifact missing/corrupt かつ復元不能
- persisted State corruption
- invalid/impossible transition
- persistence consistency failure
- external identity mismatch かつ authority 再構築不能
- authority reconstruction impossible

通常の:

- test failure
- finding
- code feedback

は terminal failure ではない。

---

## 14. v1.1+

v1.1 で State Machine に追加可能な Decision Event:

```text
CONTEXT_RESEARCH_REQUIRED
CONDITIONAL_STAGE_RUN
CONDITIONAL_STAGE_SKIPPED
ESCALATION_TARGET_SELECTED
VALIDATION_FAILURE_CLASSIFIED
```

ただし既存 Human Gate invariant は変更しない。
