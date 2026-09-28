# Pi Orchestrator Documentation

Pi Orchestrator の Initial Scope に関する設計・実装ドキュメントを、設計・実装の3階層と release evidence に分けて管理する。

## Release entrypoints

- [利用者向け README](../README.md) — installation、commands、lifecycle、configuration、known constraints
- [Initial Scope release notes](../CHANGELOG.md) — 実装・検証済みの利用者向け変更点
- [v0.1.0 release evidence](./release/v0.1.0.md) — ORCH-020 completion、validation、package inspection、release boundary

## Terminology

- **Initial Scope**: 現在実装・検証済みの product scope。
- **Future Scope**: Initial Scope では意図的に除外し、将来検討する機能。
- Package release version (`0.1.0`) は、上記の design-scope names とは独立している。
- `Basic Design (document revision 1.0)` などの表記は document revision を示し、package release version ではない。

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
├── implementation/
└── release/
```

## 3. Basic Design

Basic Design (document revision 1.0) は Initial Scope の前提・制約・権限境界の正本。Detailed Design や Implementation Plan は、Basic Design と矛盾する変更を行わない。

- [basic-design.md](./basic-design/basic-design.md) — 全体目的、責務境界、Initial Scope
- [state-machine.md](./basic-design/state-machine.md) — Workflow State / Event / Transition の正本
- [decision-engine.md](./basic-design/decision-engine.md) — Jev Decision Contract の正本
- [artifacts.md](./basic-design/artifacts.md) — Artifact / Authority / Persistence ordering
- [integrations.md](./basic-design/integrations.md) — 外部 component との接続境界
- [configuration.md](./basic-design/configuration.md) — Configuration / Retry / model mapping
- [directory-structure.md](./basic-design/directory-structure.md) — Source / Runtime directory と依存方向

## 4. Detailed Design

Basic Design (document revision 1.0) を変更せず、Initial Scope の実装可能な型・契約・runtime behavior へ具体化する。

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

## 6. Runtime Commands

Pi package を読み込むと、workflow の開始・reconciliation・read-only status を次の commands で利用できる。

```text
/wf-new <task>
/wf-feature <task>
/wf-bugfix <task>
/wf-hotfix <task>
/wf-chore <task>
/wf-resume <workflow-id>
/wf-status <workflow-id>
```

`/wf-resume` は phase の直接変更ではなく ORCH-018 reconciliation を通り、`/wf-status` は State と authoritative refs の projection のみを表示する。

## 7. Change Rule

実装中に Basic Design と矛盾する変更が必要になった場合は、実装側だけで吸収しない。変更理由と影響範囲を明示し、Basic Design の変更として扱う。

Future Scope と定義された機能は、Initial Scope の Detailed Design / Implementation に先行実装しない。
