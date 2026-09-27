# Orchestrator Configuration

Version: 1.0

## 1. 目的

本書は pi-orchestrator v1 の configurable policy と、その ownership / default / persistence boundary を定義する。

Configuration は Workflow State ではない。

```text
Configuration
    = 実行ポリシー・threshold・mapping

State
    = 現在の Workflow progress / authority
```

---

## 2. 基本原則

### CFG-001

State Machine の安全 invariant を Configuration で無効化できない。

例:

- Human Plan Gate を bypass しない
- Human Code Gate を bypass しない
- validation failure で COMPLETE を許可しない

### CFG-002

Secret を Workflow State / Artifact に保存しない。

### CFG-003

具体的 provider/model 名は Decision Engine の logical tier から Configuration が解決する。

### CFG-004

Automated retry は必ず上限を持つ。

---

## 3. v1 Configuration

概念例:

```ts
export interface OrchestratorConfiguration {
  decision: {
    autoDecisionThreshold: number;
    escalationThreshold: number;
  };

  executionProfiles: {
    ECONOMY: ExecutionProfile;
    STANDARD: ExecutionProfile;
    STRONG: ExecutionProfile;
  };

  retries: {
    maxAutomatedFixRounds: number;
    maxStrongerRetries: number;
  };

  validation: {
    stopOnInfrastructureFailure: boolean;
  };

  jev: {
    endpoint?: string;
  };
}
```

API key 等の secret はこの object を durable artifact として保存しない。

### Product Runtime の source と precedence

標準 package entry は Pi の既存 `SettingsManager` boundary を読み取り、次の
`piOrchestrator` object を `loadConfiguration()` へ渡す。

```text
<agent-dir>/settings.json  →  piOrchestrator
<project>/.pi/settings.json →  piOrchestrator
```

Project settings は Pi の既存 precedence（trusted project の project settings が
user settings を deep override）に従う。Project が untrusted の場合は Pi の
既存挙動どおり project settings を読み込まない。object が欠落または invalid
の場合、Product Runtime は fail-closed し、secret は domain configuration に
含めない。

---

## 4. Recommended v1 Defaults

```text
maxAutomatedFixRounds = 3
maxStrongerRetries    = 1
```

Confidence threshold の具体値は、Jev の評価データ / project eval に基づいて確定する。

評価なしに threshold を設計上の固定値として hard-code しない。

---

## 5. Execution Profile Mapping

Jev は logical tier を返す。

```text
ECONOMY
STANDARD
STRONG
```

Configuration が concrete model へ変換する。

例:

```text
STANDARD + HIGH
      ↓
Configuration
      ↓
provider / model / thinking
```

これにより model catalog 変更を Decision Contract から分離する。

---

## 6. Retry Policy

Automated Coding loop:

```text
Implementation
→ Validation
→ Review
→ Decision
→ Fix
→ ...
```

は `maxAutomatedFixRounds` を超えてはならない。

Stronger execution profile への escalation は `maxStrongerRetries` を超えてはならない。

上限到達時:

```text
retry budget exhausted
      ↓
BLOCK
      ↓
blocked
```

Human attention または明示的 policy change が必要。

silent infinite loop を禁止する。

---

## 7. Validation Contract と Configuration

「何を検証するか」は Approved Plan の Validation Contract が所有する。

Configuration は「Validation の共通実行ポリシー」を所有する。

```text
Approved Plan
    → WHAT to validate

Configuration
    → HOW validation infrastructure behaves
```

Configuration が task-specific test requirement を勝手に追加・削除しない。

---

## 8. Jev Configuration

v1 Jev use:

- Coding Entry Routing
- Finding Evaluation
- Round Decision

Configuration が所有するもの:

- endpoint / transport option
- confidence policy
- timeout / retry transport policy（実装時に確定）
- logical tier mapping

Jev unavailable は automatic LLM fallback しない。

```text
Jev unavailable
→ blocked
```

---

## 9. Persistence

Effective non-secret configuration の snapshot / digest を Workflow evidence に保存することを検討できる。

ただし secret は保存しない。

Decision artifact には policy version / configuration digest を持たせ、resume 時に stale decision 判定へ利用できる。

---

## 10. Future

v1.1+:

- Context Routing policy
- Conditional Stage policy
- Escalation Target allowlist
- Validation Failure classifier policy

複数 Coding Orchestration 導入時:

- global concurrency
- per-Coding concurrency
- Work Package scheduling policy

を追加可能。
