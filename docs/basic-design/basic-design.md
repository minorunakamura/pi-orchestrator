# pi-orchestrator 基本設計

Version: 1.0

## 1. 目的

本システムは、Pi 上でソフトウェア開発作業を一貫したプロセスとして実行するための Orchestrator Extension である。

対象:

- 新規プロジェクト開発
- 既存プロジェクトへの機能追加
- Bugfix
- Hotfix
- Chore

作業種別ごとに工程の有無や厳格さは異なるが、共通の Orchestrator、State、Artifact、Human Gate、Decision Engine を利用する。

v1 では Coding Orchestration は1本のみとする。

Planning による Work Package 分割、および複数 Coding Orchestration の並列実行は将来拡張として考慮するが、v1 の対象外とする。

---

## 2. 基本方針

Orchestrator をシステム全体の Control Plane とする。

```text
                              Pi
                               │
                               ▼
                     ┌─────────────────┐
                     │   Orchestrator  │
                     │   Extension     │
                     └────────┬────────┘
                              │
       ┌──────────────────────┼──────────────────────┐
       │                      │                      │
       ▼                      ▼                      ▼
  pi-subagents           Decision Engine        Plannotator
       │                    (Jev)                   │
       │                      │                      │
       │                      │                  Human Gate
       │                      │
       │                      └─ typed decisions
       │
       ├─ workflow-scout
       ├─ pi-ketch.researcher
       ├─ planner
       ├─ worker
       ├─ reviewer
       └─ ponytail-reviewer

Main Pi Agent
   └─ grilling
       └─ ask_user_question
           ↕
          Human
```

責務:

```text
Orchestrator
    = いつ、何を、どの順番で実行するか

Jev
    = bounded な State / Evidence に対する typed decision

Agent
    = 誰が作業するか

Skill
    = どの方法で作業するか

Artifact
    = Stage 間で受け渡す成果物・証拠

Gate
    = 次の Phase に進めるかを決定する境界

State
    = Workflow が現在どこにいるか
```

---

## 3. 設計原則

### 3.1 Generation / Decision / Verification の分離

```text
生成・探索
    → LLM Agent / Tool

曖昧な意味判断
    → Jev

機械的に証明可能な判定
    → deterministic code / test / build / lint / typecheck

最終承認
    → Human
```

Jev に source code、Plan、Review本文などの主要成果物を生成させない。

また以下を Jev に代替させない。

- test success / failure
- build success / failure
- Artifact existence
- State version check
- Human Plan Approval
- Human Code Approval

### 3.2 State Authority

Workflow State を変更できるのは Orchestrator のみ。

Jev、Agent、Skill、Plannotator は State を直接変更しない。

### 3.3 Third-Party Dependency Immutability

pi-orchestrator v1 が利用する third-party library / package は read-only dependency として扱い、pi-orchestrator の実装のために変更してはならない。v1 ではこの制約に例外を設けない。

対象には以下を含む。

- Pi / pi-coding-agent
- pi-subagents
- Plannotator
- pi-ketch
- pi-ask-user-question
- Jev / TypeSafe client library
- その他の npm / external dependency

禁止する実装方式:

```text
third-party source の直接変更
node_modules の編集
pnpm patch / patch-package を必須とする実装
fork した dependency を v1 の前提とする実装
private / internal API の変更を前提とする実装
```

外部 component との不整合は pi-orchestrator 側の Integration Adapter / Wrapper で吸収する。公開 contract の範囲で安全に実現できない場合は dependency を変更せず、`blocked` / unsupported として扱う。

必要な capability が upstream に存在しない場合も、pi-orchestrator v1 が third-party の改変版に依存してはならない。

---

## 4. Playbook

初期 Slash Command:

```text
/wf-new
/wf-feature
/wf-bugfix
/wf-hotfix
/wf-chore
/wf-resume
/wf-status
```

Slash Command は薄い entry point とする。

```ts
orchestrator.start({
  playbook: "feature",
  task: args,
});
```

Stage policy:

```ts
type StagePolicy = "required" | "conditional" | "skip";
```

v1 では `conditional` Stage の判定は Playbook の明示 rule / Orchestrator policy を使用する。

v1.1 では conditional Stage 判定を Jev Decision Engine に拡張可能とする。

---

## 5. Top-Level Lifecycle

```text
Planning Orchestration
        ↓
Human Plan Gate
        ↓
Coding Orchestration
        ↓
Human Code Gate
        ↓
Completed
```

Planning と Coding は別 Orchestration とする。

詳細な State / Event / Transition は [state-machine.md](./state-machine.md) を正本とする。

---

## 6. Planning Orchestration

```text
User Request
     ↓
Context Gathering
     ↓
Clarification
     ↓
Architecture / Design
     ↓
Planning
     ↓
Plan Artifact
```

### 6.1 Context Gathering

```text
                   Context Gathering
                    /             \
                   /               \
        workflow-scout       pi-ketch.researcher
        Local Repository      External Evidence
                   \               /
                    \             /
                     Context Artifacts
```

- Local repository: `workflow-scout`
- External Research: `pi-ketch.researcher`

### 6.2 Clarification

```text
Context
   ↓
grilling
   ↓
Decision frontier
   ↓
ask_user_question
   ↕
Human
   ↓
Shared Understanding
```

原則:

```text
Fact
    → Agent / Tool が調査

Decision
    → Human が決定
```

### 6.3 Architecture / Planning

v1 では Architecture / Design と Implementation Planning を `planner` が所有する。

独立した `architect` Agent は v1 では作成しない。

Architecture 判断が必要な場合、Planner は Approved Plan の中に Architecture / Design section を含める。

```text
Context Artifacts
+
Clarification Result
        ↓
      Planner
        ↓
plans/plan-vN.md
    ├─ Scope / Requirements
    ├─ Architecture / Design（必要時）
    ├─ Implementation Plan
    └─ Validation Contract
```

Validation Contract は、その Plan を実装・検証するときに実行すべき検証条件の正本とする。

例:

```text
- project test command
- typecheck
- lint
- build
- task-specific regression / focused verification
```

Planner は Implementation を開始しない。

将来、Architecture の複雑性が増した場合は `architect` Agent の分離を検討できるが、v1 の責務境界は変更しない。

---

## 7. Human Plan Gate

```text
plan-vN.md
    ↓
Plannotator
    ↕
Human
```

Feedback:

```text
PLAN_FEEDBACK
→ Planning
→ plan-vN+1.md
```

Approve:

```text
PLAN_APPROVED
→ approvedPlanRef を固定
→ Coding Orchestration
```

Implementation Authority は `approvedPlanRef` のみとする。

---

## 8. Coding Orchestration

v1:

```text
Approved Plan
      ↓
Jev: Execution Routing
      ↓
Implementation
      ↓
Deterministic Validation
      ↓
Automated Review
      ↓
Structured Findings
      ↓
Jev: Finding Evaluation
      ↓
Jev: Round Decision
   ┌──┼──────────────┐
   │  │              │
 RETRY COMPLETE   ESCALATE
   │  │              │
   │  │       deterministic
   │  │       escalation policy
   │  │              │
   ▼  ▼              ▼
 Fix  Human       Stronger Retry /
      Code Gate   Planning /
                  Clarification
```

---

## 9. Jev Decision Engine - v1

v1 では Jev を以下3箇所で必須利用する。

### 9.1 Coding Entry Routing

Approved Plan から Coding execution profile を選択する。

Jev が返す logical decision 例:

```text
modelTier:
  ECONOMY | STANDARD | STRONG

reasoningTier:
  LOW | MEDIUM | HIGH
```

具体的な provider / model 名への変換は Orchestrator Configuration が担当する。

Jev が provider/model 名を直接 Workflow contract に埋め込まない。

### 9.2 Finding Evaluation

Correctness Reviewer と Ponytail Reviewer は structured finding を返す。

Jev は finding ごとに狭い判断を行う。

例:

```text
evidenceSupported?
conflictsWithApprovedPlan?
conflictsWithArchitecture?
inScope?
requiresHumanDecision?
```

最終的な:

```text
ACCEPT
REJECT
ESCALATE
```

は Jev の typed decision と deterministic policy を組み合わせて決める。

### 9.3 Post-Implementation Round Decision

Validation と Review evidence を入力として:

```text
COMPLETE
RETRY
ESCALATE
```

を判断する。

Hard rule:

- deterministic validation failure がある場合 `COMPLETE` 不可
- accepted blocking finding がある場合 `COMPLETE` 不可
- Human Approval の代替にはならない

詳細は [decision-engine.md](./decision-engine.md) を参照する。

---

## 10. Escalation - v1

v1 では Jev が `ESCALATE` と理由分類を返し、対象先は code policy が決定する。

例:

```text
implementation-capability
    → stronger execution profile で Fix / Retry

plan-conflict
    → Planning へ戻す
    → approvedPlanRef を無効化
    → Human Plan Gate を再度通す

human-decision
    → Clarification
    → Planning
    → Human Plan Gate

uncertain
    → Clarification / Human attention
```

Jev 自身が任意の routing target を生成しない。

v1.1 では bounded Choice として Escalation Target を Jev に選択させることを検討する。

---

## 11. Implementation

pi-subagents builtin `worker` を基本利用する。

Worker input:

- approvedPlanRef
- required context refs
- execution profile
- accepted findings（Fix時）

Worker は未承認の Product / Architecture / Scope Decision を行わない。

---

## 12. Validation

Validation は Approved Plan の `Validation Contract` を正本として deterministic に実行する。

Validation Contract の例:

- project test command
- typecheck
- lint
- build
- task-specific regression / focused verification

各 check の pass / fail は code で判定する。

Jev に exit code や pass/fail 自体を判断させない。

Validation が失敗した場合は、その時点で直接 `fixing` / `planning` / `clarifying` へ遷移しない。

```text
Validation failure
      ↓
Validation Evidence を保存
      ↓
Jev Round Decision
      ↓
Orchestrator Escalation Policy
      ↓
RETRY_REQUIRED
STRONGER_RETRY_REQUIRED
REPLAN_REQUIRED
CLARIFICATION_REQUIRED
```

最終 routing event によって State Transition を一意に決定する。

---

## 13. Automated Review

```text
                  Current Diff
                       │
             ┌─────────┴─────────┐
             ▼                   ▼
   Correctness Reviewer    Ponytail Reviewer
             │                   │
             └─────────┬─────────┘
                       ↓
               Structured Findings
```

Reviewer は fresh context を基本とする。

Raw Review prose だけに依存せず、Finding Evaluation 用の structured finding contract を持つ。

---

## 14. Finding Evaluation

従来の `Finding Synthesis` という名称は使用せず、`Finding Evaluation` とする。

```text
Structured Findings
       ↓
      Jev
       ↓
typed decisions
       ↓
deterministic policy
       ↓
accepted / rejected / escalated findings
```

Jev は Finding を修正しない。

Orchestrator が evaluation artifact を検証して `acceptedFindingsRef` を authoritative に設定する。

---

## 15. Fix Loop

`RETRY` または accepted finding がある場合:

```text
Approved Plan
+
Accepted Findings
+
Current Implementation
+
Execution Profile
        ↓
      Worker
        ↓
    Validation
        ↓
Automated Review
        ↓
Jev Evaluation / Round Decision
```

---

## 16. Human Code Gate

`COMPLETE` は「Automated Stage が完了した」という意味であり Workflow completion ではない。

```text
Jev Round Decision = COMPLETE
        ↓
Plannotator Code Review
        ↕
Human
```

Feedback:

```text
CODE_FEEDBACK
→ Fixing
```

Approve:

```text
CODE_APPROVED
→ Completed
```

---

## 17. Blocked / Failed / Resume

外部依存の一時障害と、通常 recovery ができない failure を分離する。

```text
blocked
    = 現在は安全に続行できないが、原因解消後に resume 可能

failed
    = State / Authority / Artifact の整合性を安全に再構築できず、
      通常の resume を許可しない terminal state
```

`blocked` の代表例:

- Jev / TypeSafe API unavailable
- Plannotator unavailable
- pi-subagents infrastructure unavailable
- retry budget exhausted and Human intervention required

`failed` の代表例:

- persisted State corruption
- authoritative Artifact loss / corruption
- impossible / invalid State Transition
- Authority の再構築不能

Resume の正本:

```text
Workflow State
+
Authoritative Artifacts
+
External Identities
+
Decision Artifacts
```

Jev の決定も durable artifact として保存する。

Resume 時に Jev decision を無条件再実行しない。

既存の valid decision artifact が current input version / revision と一致する場合は再利用可能とする。

`blocked` からの resume は原因解消を reconcile した後、`blockedFrom` に記録された Phase へ戻り、通常 Event / Transition を再開する。

---

## 18. Source Code Architecture

```text
commands / tools / events / ui
              ↓
           runtime
              ↓
             core
```

追加:

```text
runtime/integrations/jev.ts
core/decisions/*
core/configuration.ts
```

詳細は [directory-structure.md](./directory-structure.md)。

Configuration / Retry policy の正本は [configuration.md](./configuration.md) とする。

---

## 19. Artifact

Artifact は durable contract / evidence。

Jev 関連:

- execution-routing decision
- finding-evaluation decision
- round-decision

詳細は [artifacts.md](./artifacts.md)。

---

## 20. Integrations

詳細は [integrations.md](./integrations.md)。

Jev の Decision contract は [decision-engine.md](./decision-engine.md) を正本とする。

Configuration / Retry policy は [configuration.md](./configuration.md) を正本とする。

---

## 21. Configuration / Retry Policy

v1 では以下を Orchestrator Configuration が所有する。

- Jev confidence thresholds
- logical execution tier → concrete provider/model mapping
- reasoning tier → concrete thinking level mapping
- automated Fix / Review round upper bound
- stronger retry upper bound
- Jev integration settings
- Validation execution policy

推奨 v1 default:

```text
maxAutomatedFixRounds = 3
maxStrongerRetries    = 1
```

上限到達時に silent loop を継続しない。

```text
retry budget exhausted
    ↓
blocked
    ↓
Human attention / explicit resume
```

API key 等の secret は Workflow State / Artifact に保存しない。

詳細は [configuration.md](./configuration.md)。

---

## 22. v1 Scope

- Single top-level Workflow
- Single Planning Orchestration
- Single Coding Orchestration
- Context Gathering
- Clarification
- Planning
- Plannotator Plan Gate
- Jev Coding Entry Routing
- Implementation
- Deterministic Validation
- Correctness Review
- Ponytail Review
- Jev Finding Evaluation
- Jev Round Decision
- Deterministic v1 Escalation Policy
- Fix Loop
- Plannotator Code Gate
- State / Artifact / Decision Persistence
- Blocked / Failed separation
- Validation Contract
- Configuration / Retry policy
- Resume / Recovery

---

## 23. v1 Scope Out

- Multiple Coding Orchestration
- Work Package DAG
- Integration Orchestration
- Jev Context Routing
- Jev Conditional Stage Routing
- Jev Escalation Target selection
- Agent Trace observability decision
- Dynamic Reviewer selection

---

## 24. v1.1+ Jev Extension

優先候補:

### v1.1

```text
Context Routing
    READY
    RESEARCH
    CLARIFY
    RESEARCH_AND_CLARIFY

Conditional Stage Decision
    RUN
    SKIP
    ESCALATE

Escalation Target
    STRONGER_WORKER
    PLANNING
    HUMAN

Validation Failure Semantic Classification
```

### v1.2+

```text
Agent Trace Observability
Dynamic Reviewer Routing
Adaptive model/cost/latency routing
Work Package priority / dependency triage
Multiple Coding Orchestration routing
```

詳細は [decision-engine.md](./decision-engine.md)。

---

## 25. Final Design Principles

```text
Orchestrator
    = Control Plane

Jev
    = Decision Plane

pi-subagents
    = Agent Execution Plane

Agents
    = Generation / Exploration / Review

Deterministic tools
    = Verification Plane

Artifacts
    = Durable Contracts / Evidence

Plannotator
    = Human Approval Gate

Human
    = Final Decision Authority
```

Jev は「Workflow を考える Agent」ではない。

Orchestrator が設計した bounded decision point に対して typed decision を返す Decision Engine とする。
