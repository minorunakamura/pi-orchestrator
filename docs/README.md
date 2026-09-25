# Pi Orchestrator Documentation

Pi Orchestrator v1 の設計・実装ドキュメントを、役割ごとに3階層へ分けて管理する。

## 1. Reading Order

基本の読み順は以下。

1. [Basic Design](./basic-design/basic-design.md)
2. [Detailed Design Overview](./detailed-design/detailed-design-overview.md)
3. [Implementation Plan](./implementation/implementation-plan.md)

```text
Basic Design
    WHAT / WHY / authoritative constraints
            ↓
Detailed Design
    HOW / contracts / runtime behavior
            ↓
Implementation
    ORDER / Story / PR / acceptance criteria
```

## 2. Directory Structure

```text
docs/
├── README.md
├── basic-design/
├── detailed-design/
└── implementation/
```

## 3. Basic Design

Basic Design v1.0 は v1 の前提・制約・権限境界の正本。Detailed Design や Implementation Plan は、Basic Design と矛盾する変更を行わない。

- [basic-design.md](./basic-design/basic-design.md) — 全体目的、責務境界、v1 scope
- [state-machine.md](./basic-design/state-machine.md) — Workflow State / Event / Transition の正本
- [decision-engine.md](./basic-design/decision-engine.md) — Jev Decision Contract の正本
- [artifacts.md](./basic-design/artifacts.md) — Artifact / Authority / Persistence ordering
- [integrations.md](./basic-design/integrations.md) — 外部 component との接続境界
- [configuration.md](./basic-design/configuration.md) — Configuration / Retry / model mapping
- [directory-structure.md](./basic-design/directory-structure.md) — Source / Runtime directory と依存方向

## 4. Detailed Design

Basic Design v1.0 を変更せず、実装可能な型・契約・runtime behavior へ具体化する。

- [detailed-design-overview.md](./detailed-design/detailed-design-overview.md) — 詳細設計の境界と解釈
- [domain-model.md](./detailed-design/domain-model.md) — TypeScript domain model / State / Event
- [runtime-design.md](./detailed-design/runtime-design.md) — Orchestrator runtime / ports / integrations
- [planning-orchestration.md](./detailed-design/planning-orchestration.md) — Planning Orchestration
- [coding-orchestration.md](./detailed-design/coding-orchestration.md) — Coding / Jev / Validation / Retry
- [persistence-recovery.md](./detailed-design/persistence-recovery.md) — State / Artifact persistence / Resume / reconciliation
- [test-strategy.md](./detailed-design/test-strategy.md) — Test architecture / recovery testing

## 5. Implementation

実装順、Story / PR boundary、Acceptance Criteria、依存関係を管理する。

- [implementation-plan.md](./implementation/implementation-plan.md)

実装計画は Basic Design と Detailed Design を参照する実行計画であり、設計上の正本を置き換えない。

## 6. Change Rule

実装中に Basic Design と矛盾する変更が必要になった場合は、実装側だけで吸収しない。変更理由と影響範囲を明示し、Basic Design の変更として扱う。

v1.1+ と定義された機能は、v1 の Detailed Design / Implementation に先行実装しない。
