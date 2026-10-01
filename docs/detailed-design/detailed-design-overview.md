# Pi Orchestrator Detailed Design Overview

Version: 2.0 — v1 target contract (Issue #3)

## 1. Authority / status

Basic Design defines WHAT/WHY/authority; Detailed Design defines HOW/contracts/recovery/tests; GitHub Issue #13 and child Issues define implementation order/acceptance。All are the v1 target, not current v0.1.0 production readiness。

Production baseline: Pi >=0.99.1 / pi-subagents >=0.74.0 / pi-typesafe >=0.8.1 transitional only until #19。Released public contracts only; dependency source/patch/fork/private APIs forbidden。

## 2. Canonical lifecycle

Task → Scout → required Diagnosis? → conditional Research → clarification mode/root Human → conditional Architecture → Development Method → Planner → deterministic Plan validation → Plan Simplicity Review → optional one-shot refinement/fresh review → mandatory Human Plan Gate → execution routing/explicit Launch Policy/preflight → Worker/local flexibility or material stop/replan → deterministic Validation → Correctness/Ponytail → finding/round policy → mandatory synchronous Human Code Gate → completed。

Oracle is rare read-only cross-cutting advisory, not mandatory stage/authority。domain-modeling only within GRILL_WITH_DOCS; TDD is method, not phase。Sequential decisions consume accumulated durable evidence。

Normal driveWorkflow() runs until genuine wait/block/failure/completion。Resume reconciles historical authority then continues same driver, never ordinary phase-stepping or pi-subagents script control plane。

## 3. Required retained boundaries

- Orchestrator sole State/lifecycle/Artifact/policy/Human Gate owner。
- All playbooks require exact Human Plan and Code approval。
- Plan is approved strategy/boundary with method/seams/contract, not frozen editing script。
- Every review-ready Plan has fresh exact-bound repository-evidenced simplicity; automatic refinement cap = 1 per cycle。
- Worker only automated source executor; material deviation stops before unauthorized change and gets new Human-approved Plan。
- Main source/indirect bypass forbidden; exact clarification-bound CONTEXT/ADR write exception only。
- Agent/classifier/Oracle/Codemode/reviewer evidence is not authority。
- Deterministic validation and B1–B5/I1–I5 retained safety cannot be weakened。
- Required launch/intent/reservation/baseline/local gate attempt and State precede external/mutating effects。
- Historical model/skills/tools/definition/launch identity cannot be silently replaced; ambiguous Worker never blindly relaunched。
- Git/filesystem both have content-bound before/after authority evidence; non-Git Code uses exact static patchFile。
- Plan Gate async external identity, Code Gate synchronous local attempt/source; no invented external Code polling or Human timeout。
- Product consent derives workflow binding from operator/project grant; credentials/Plan approval never authorize classifier transmission。

## 4. Canonical references

Basic:

- [basic-design.md](../basic-design/basic-design.md)
- [state-machine.md](../basic-design/state-machine.md)
- [decision-engine.md](../basic-design/decision-engine.md)
- [artifacts.md](../basic-design/artifacts.md)
- [integrations.md](../basic-design/integrations.md)
- [configuration.md](../basic-design/configuration.md)
- [directory-structure.md](../basic-design/directory-structure.md)

Detailed:

- [domain-model.md](./domain-model.md): single typed State/Event/Artifact contract
- [runtime-design.md](./runtime-design.md): driver/reconciler/launch/ports/ownership
- [planning-orchestration.md](./planning-orchestration.md): sequential evidence/modes/TDD/strategy/simplicity/Plan Gate
- [coding-orchestration.md](./coding-orchestration.md): approved Worker/deviation/validation/review/Code Gate
- [plannotator.md](./plannotator.md): actual async Plan vs synchronous Code public contract
- [persistence-recovery.md](./persistence-recovery.md): barriers/freshness/authority/phase-specific reconciliation
- [test-strategy.md](./test-strategy.md): focused/fault/host/real Herdr coverage
- [implementation-plan.md](../implementation/implementation-plan.md): target vs current and Issue #13 dependencies

## 5. Future Scope / verification

Multiple Coding Orchestrations/Work Package DAG/worktree parallelism, generic Context Routing, arbitrary escalation target, semantic Validation failure classifier, dynamic reviewer routing, Virtual Models execution authority remain excluded。

Conditional Stage Routing, Diagnosis, non-Git, GRILL modes/docs boundary, TDD/seams, simplicity/refinement, material deviation, bounded Oracle, native classifiers/explicit launch and read-only Codemode are v1。

Historical [v0.1.0 evidence](../release/v0.1.0.md) is not redesigned-runtime PASS。Release claims wait for child implementation and #12 production-path validation。Real Pi uses new Herdr tab, never tmux。
