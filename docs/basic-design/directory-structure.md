# Directory Structure

Version: 2.0 — v1 target contract (Issue #3)

## 1. Ownership / dependency direction

```text
commands / tools / events / ui
              ↓
           runtime
              ↓
             core
```

Core is independent of Pi, filesystem/network, TypeSafe/classifier SDK, Plannotator and pi-subagents transport types。Runtime assembles evidence and persists refs; integrations normalize released public APIs; commands remain thin。

Below are responsibility locations, **not a requirement to create one file per concept**。Reuse existing modules; no unused abstractions/placeholders/scaffolding。

## 2. Source / Agent responsibilities

| Location | Responsibility / implementing Issue |
| --- | --- |
| src/commands/, src/index.ts | /wf-* normal driver entry, /wf-resume reconcile + continuation, read-only status (#4) |
| src/core/workflow/ | State/Event/schema/invariants/pure transition; sole authority contract |
| src/core/playbooks/, src/core/decisions/ | stage matrix + conditional/mode/method policies + coding hard rules (#6/#7/#16) |
| src/core/planning/ | strategy/Test Seams/simplicity/refinement freshness (#14) |
| src/core/coding/ | approved strategy/local freedom/material deviation authority (#15) |
| src/core/configuration.ts | non-secret schema / mappings / grant upper bounds (#11/#18/#19/#21) |
| src/runtime/orchestrator/ | driveWorkflow normal lifecycle (#4); phase runners; separate reconciler / resume |
| src/runtime/ports/ | normalized child launch, classifier, clarification, separate async Plan/sync Code contracts |
| src/runtime/integrations/ | public subagents preflight/RPC (#21), native classifier (#19), Plannotator (#9) adapters |
| src/runtime/planning/, src/runtime/validation/ | Plan logical parser + machine-readable Validation Contract / deterministic commands |
| src/runtime/worker/ | Git/filesystem observation / mutation baseline / material deviation (#10/#15) |
| src/runtime/persistence/ | immutable Artifact store / atomic State / lock / revision check |
| host tool-call / ownership integration | active workflow Main guard; narrow clarification document exception (#5/#8) |
| agents/ | product workflow-scout, planner, plan-simplicity-reviewer (#14), ponytail-reviewer |
| tests/ | core / persistence / adapter / scenario / fault / host / smoke (#12) |

Diagnosis may reuse a read-only evidence definition; do not create a standalone mutating role merely for a new Stage name。Architecture stays owned by Planner and embedded in Plan。Oracle uses verified pi-subagents builtin oracle。Worker/reviewer remain builtin roles under explicit Launch Policy。

Builtin development-time helpers are not product custom definitions。Generic reviewer is not plan-simplicity-reviewer or ponytail-reviewer。Finding Evaluation is classifier + deterministic policy, not another Agent。

TDD/grilling/domain-modeling are upstream skills selected via supported public contracts, not copied JavaScript dependencies。Read-only Codemode uses Pi's released capability under #20, not an orchestrator workflow-script engine。

## 3. Runtime evidence directory

```text
.pi/orchestrator/runs/<workflow-id>/
  state.json
  task.md
  context/          Scout / Diagnosis / Research / clarification / document-write evidence
  plans/            immutable plan-vN.md
  plan-reviews/     exact-bound simplicity findings + async Human Plan results
  decisions/        stage/mode/method/execution/evaluation policy + request accounting
  agent-runs/       resolved launch projections / exact output receipts
  advisory/         bounded Oracle attempts / outputs
  workspace/        Git/filesystem snapshots / manifests / retained baseline content
  implementation/   Worker intent/observations/success / material deviation
  validation/       exact contract results
  reviews/          correctness / ponytail / evaluation / accepted / round decisions
  code-reviews/     local synchronous attempt / static patch / settled Human results
```

The authoritative path/kind catalog is [Artifacts §2](./artifacts.md#2-runtime-paths--producer-consumer-contract)。Folders are created only for real Artifacts; no eager architecture/ directory is required。Runtime directories are excluded from workspace mutation observation under a persisted policy; source/workspace identity is not Worker text hash。

State stores refs/hash/identities/counters, not output bodies。Public pi-subagents output/lifecycle paths are retained external receipt evidence, not approved Artifact authority until validated and published by Orchestrator。

## 4. Documents / source of truth

```text
docs/basic-design/       WHAT / WHY / authority
  basic-design.md
  state-machine.md
  decision-engine.md
  integrations.md
  configuration.md
  artifacts.md
  directory-structure.md
docs/detailed-design/    HOW / contracts / recovery / tests
  domain-model.md
  runtime-design.md
  planning-orchestration.md
  coding-orchestration.md
  plannotator.md
  persistence-recovery.md
  test-strategy.md
  detailed-design-overview.md
docs/implementation/     Issue #13 dependency order / coverage / pending work
docs/release/            historical verified release evidence, not target-design claims
```

Issue #3 defines v1 target; #13 tracks implementation. Pi >=0.99.1 / pi-subagents >=0.74.0 / native classifier typesafe/jev-latest (#19, transitional pi-typesafe removed after live smoke) are platform contracts, not permission to modify package metadata in this design-only Issue。

## 5. Tests / Future Scope

Adapter/fake tests cover decision evidence, exact launch/trust/skill/tool identity, freshness, both Gate contracts, non-Git patch and persistence barriers。Real Pi processes use new Herdr tab; no runtime/integrations/herdr.ts or tmux。Herdr is test/development harness only。

Future Scope directories (multi-Worker/worktree scheduling, generic context routing, arbitrary escalation target, semantic validation classifier, Virtual Models authority) are not created ahead of need。v1 concepts live in existing responsibility areas wherever possible。
