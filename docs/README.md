# Pi Orchestrator Documentation

## 1. Status / source of truth

Canonical Basic/Detailed Design now describe the **v1 target contract** finalized by [Issue #3](https://github.com/minorunakamura/pi-orchestrator/issues/3)。This documentation update does not implement or validate redesigned production paths。

[Issue #13](https://github.com/minorunakamura/pi-orchestrator/issues/13) owns dependency/order/completion; child Issues own implementation acceptance。Current package is v0.1.0; its historical [release evidence](./release/v0.1.0.md) / [CHANGELOG](../CHANGELOG.md) remain separate and unchanged。

Terminology:

- **v1 / Initial Scope target**: redesigned single-Workflow product scope in these canonical docs, including conditional routing/Diagnosis/non-Git/TDD/simplicity/Oracle。
- **v0.1.0 verified scope**: historical implementation/validation, not the v1 target PASS。
- **Future Scope**: explicitly deferred multiple coding/DAG/generic context routing/arbitrary escalation/semantic failure classifier/Virtual Models authority。
- Document revision 2.0 is not package release version。

## 2. Reading order

1. [Basic Design](./basic-design/basic-design.md): WHAT/WHY/authority/baseline
2. [Detailed Design Overview](./detailed-design/detailed-design-overview.md): HOW/contracts
3. [Implementation Plan](./implementation/implementation-plan.md): current gaps / Issue #13 order
4. [Dependency Contract Review](./implementation/dependency-contract-review.md): released public references / corrected assumptions / pending publication and runtime evidence

Conflicts are resolved through explicit Issue/canonical design changes, never silent implementation scope expansion。

## 3. Basic Design

- [basic-design.md](./basic-design/basic-design.md): lifecycle/playbooks/authority/platform
- [state-machine.md](./basic-design/state-machine.md): phases/events/transitions/invariants
- [decision-engine.md](./basic-design/decision-engine.md): bounded native classifier decisions/freshness/consent
- [artifacts.md](./basic-design/artifacts.md): kind/path/authority/persistence catalog
- [integrations.md](./basic-design/integrations.md): released public preflight/trust/skills/Codemode/Gate contracts
- [configuration.md](./basic-design/configuration.md): profiles/budgets/grant vs workflow consent
- [directory-structure.md](./basic-design/directory-structure.md): responsibility/allowed dependencies

## 4. Detailed Design

- [domain-model.md](./detailed-design/domain-model.md): typed State/Event/Artifact contract
- [runtime-design.md](./detailed-design/runtime-design.md): normal driver vs reconciliation/ports/ownership/launch
- [planning-orchestration.md](./detailed-design/planning-orchestration.md): sequential evidence/modes/TDD/strategy/simplicity
- [coding-orchestration.md](./detailed-design/coding-orchestration.md): Worker boundary/deviation/validation/review
- [plannotator.md](./detailed-design/plannotator.md): async Plan / synchronous Code + local attempt/static patch
- [persistence-recovery.md](./detailed-design/persistence-recovery.md): intent-before-effect/freshness/recovery
- [test-strategy.md](./detailed-design/test-strategy.md): focused/fault/host/live Herdr verification

Implementation records: [#4 normal driver foundation](./implementation/normal-workflow-driver.md)、[#19 native classifier](./implementation/native-classifier-migration.md)、[#11 generated-workflow consent](./implementation/classifier-authorization.md)、[#21 launch contract](./implementation/agent-launch-contract.md)、[#15 Plan strategy boundary / material deviation](./implementation/plan-deviation.md)。各 record の検証範囲は full v1 production readiness と区別します。

## 5. Commands / runtime target

```text
/wf-new <task>
/wf-feature <task>
/wf-bugfix <task>
/wf-hotfix <task>
/wf-chore <task>
/wf-resume <workflow-id>
/wf-status <workflow-id>
```

/wf-* invokes normal driveWorkflow() until genuine Human/external wait, block, failure or completion。Accepted results continue the same driver。/wf-resume reconciles first, then continues normal driver; repeated resume is not normal progress。/wf-status is read-only。

Production target: Pi >=0.99.1 / pi-subagents >=0.74.0。[#19 native classifier migration](./implementation/native-classifier-migration.md) uses typesafe/jev-latest; pi-typesafe was removed after live smoke。Remaining lifecycle/authorization/production integration belongs to its tracked child Issues. Release evidence/CHANGELOG update only after those required checks pass。
