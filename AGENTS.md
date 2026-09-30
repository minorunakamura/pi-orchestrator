# Repository Rules

## Source of truth

- GitHub Issues define the scope and acceptance criteria for implementation work.
- Canonical architecture and runtime contracts live under `docs/`.
- Tracking/dependency order is maintained in GitHub Issue #13.
- Do not silently resolve conflicts between an Issue, canonical design, and current code by expanding scope.

## Architecture and authority

- pi-orchestrator owns Workflow State, lifecycle, Artifact authority, decision policy, and Human Gate authority.
- Human Plan Gate and Human Code Gate are mandatory and must never be bypassed or inferred.
- External Agents, classifiers/Jev, Oracle, Codemode, reviewers, and pi-subagents execution provide evidence or execution only; they do not directly grant Workflow authority.
- Keep the normal workflow lifecycle in pi-orchestrator. Do not move it into pi-subagents workflow scripts.

## External dependencies

- Do not modify, patch, fork, or depend on private APIs of third-party packages.
- Use only released public APIs/contracts.
- Do not rely on ambient Agent capabilities. Use the explicit Agent Launch Policy / public preflight contract for execution-relevant model, skill, tool, and Agent identity where applicable.

## Safety and persistence

- Persist required intent, authority, and evidence before starting the next external or mutating side effect.
- Fail closed when execution or authority is ambiguous.
- Never blindly retry or relaunch a Worker that may already have mutated the repository.

## Scope

- Implement the smallest change that satisfies the target Issue and canonical design.
- Avoid speculative abstractions, unrelated refactoring, and Future Scope behavior unless explicitly required.

## Validation

- Add or update tests for changed behavior.
- Run focused tests during development.
- Run `pnpm check` before reporting implementation complete when applicable.
- Do not report successful completion while required validation is failing or missing.

## Real Pi testing

- Run real Pi integration and smoke tests in a new Herdr tab.
- Do not use tmux.

