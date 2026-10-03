# Approved Plan strategy boundary — Issue #15

## Scope

[Issue #15](https://github.com/minorunakamura/pi-orchestrator/issues/15) implements the canonical [Worker boundary](../detailed-design/coding-orchestration.md#material-plan-deviation-15), [replanning](../detailed-design/planning-orchestration.md#10-replan--material-deviation), and [recovery](../detailed-design/persistence-recovery.md#clarifying--document-writes--advisory--deviation) contracts. Tracking #13's prerequisites, including #14 and #17, are CLOSED and present in the checkout.

Reuse the existing builtin Worker, public pi-subagents 0.74.0 preflight/single-agent RPC/receipt/full-output recovery, immutable ArtifactStore, CAS StateStore, normal driver, Planner/simplicity and mandatory Human Gates. No dependency changes, third-party patch/private API, supervisor-mediated authority, dedicated deviation reviewer, or workflow-script lifecycle.

## Worker contract / terminal stop

Worker receives the exact immutable approved Plan ref and full hash-verified contents through the existing Artifact input path. The task explicitly permits private helper extraction, local naming, test helper details and equivalent small internal organization when the approved strategy is preserved. Accepted Findings / Human Code feedback cannot expand the Plan.

Knowingly needed unauthorized component/dependency, public API, repository/domain boundary, persistence/integration strategy, scope, method, Test Seams or Validation change requires **STOP ALL mutation**, then final output:

```text
PLAN_DEVIATION
{"schemaVersion":1,"workflowId":"...","attemptId":"...","approvedPlanRef":{...},"planVersion":1,"inputRevision":0,"category":"public-api","reason":"...","constraint":"verbatim approved Plan excerpt","proposedChange":"needed but NOT implemented","localAlternative":"safe narrower option or why unavailable","evidence":["repository path:line and facts"]}
```

The task supplies the exact workflow/attempt/Plan/revision binding after generating the durable dispatch identity. Nine closed categories, nonempty text fields of at most 2000 characters, 1–8 evidence entries, full output at most 16000 characters. A malformed/oversized stop signal never falls back to implementation success. Constraint must be a verbatim excerpt of the approved Plan. Report is a proposal/evidence, not permission or an implementation result.

Transport `succeeded` means the child finished; it can still be a stopped Worker. No new upstream tool/structured-output contract is required. Worker reports by ending the existing single-agent run, so no pending supervisor interaction is needed. Historical launch preflight reconstruction includes exactly the same stop binding/task.

## Durable lifecycle / authority

```text
existing routing / Worker intent / launch / receipt → State → dispatch
 → exact full terminal result / received identity → State
 → after-workspace observation → State
 → implementation/attempt-<id>-deviated.json → workerAttemptRef CAS
 → implementation/deviation-<id>.json (kind plan-deviation)
 → PLAN_DEVIATION_REPORTED → State
 → normal Planner → fresh simplicity → mandatory Human Plan Gate
```

Deviation Artifact retains the bounded full output/report and exact stopped Worker ref. That stopped record retains the complete approved Plan/version, input/target revision, input refs, routing/profile, public request/run/launch/receipt, before/after workspace identities and predecessor history. `deviated` is not `succeeded`; no `implementationRef` or implementation revision increment is published for the stopped attempt.

State stores `coding.latestDeviationRef`. The event clears approved Plan/version, execution routing, current validation/reviews/evaluation/Fix/Code Gate authority and old Plan Gate binding/settled approval/simplicity. It starts a new planning cycle with its own one-shot refinement budget and invalidates Architecture/method routing. Completed implementation and previous round history remain durable; counters are not reset and no rollback is inferred.

Planner validates the retained deviation and consumes its exact ref/full body with the previous Plan. New versions cannot reuse old simplicity or approval. Optional Oracle requires persisted deviation history **after** approval invalidation, validates it before request, consumes the evidence frontier and remains advisory only. Core stop/replan makes zero Oracle calls unless explicitly requested.

## Resume / fault barriers

- Running, missing receipt, ambiguous/truncated output or unavailable after-workspace observation stays fail closed; no duplicate Worker.
- Output/deviation/State publication failures recover only the same historical public terminal output/receipt. Repeated normal driving of an unpublished stopped record blocks for reconciliation rather than incorrectly declaring reconstructable history terminal-corrupt. Existing stopped files are hash/schema checked, with exact report/attempt/Plan/input/workspace binding, before idempotent publication.
- Orphan stopped record and deviation Artifact cannot attach to a new Plan/revision/workflow. Old approval delivery cannot restore authority, even before the next Plan is produced.
- Resolved stopped history permits a subsequent Worker only under a distinct newly Human-approved Plan, with fresh routing/preflight. Workspace drift after the stopped observation blocks mutation rather than silently rebaselining or rolling back.
- Blocked mutating status queries now pass the persisted receipt to the same public status adapter; run ID alone is not exact recovery authority.
- Completed durable deviations/Plans/reviews are not redispatched/reopened by adapter recreation/resume.

## Post-implementation backstop

Existing Correctness Reviewer checks actual code against the full approved strategy, including method/seams/Validation, and reports observed material violations as `plan-boundary-violation` with exact Plan/repository evidence. It does not flag local choices merely for differing from a recipe. No dedicated reviewer is added; Ponytail keeps its post-code simplicity responsibility.

Evidence-supported, high-confidence observed violations conflicting with approved Plan/Architecture become `ESCALATE / plan-conflict`, not rejected recommendations or automatic Accepted Fix Authority. Round policy forces replan even if its raw decision is COMPLETE/RETRY/capability escalation. Human-decision and uncertain/low-confidence/infrastructure precedence remain conservative. Ordinary recommendations conflicting with the Plan remain REJECT under existing policy.

## Acceptance coverage

| Acceptance criterion | Executable coverage |
| --- | --- |
| Exact approved strategy/constraints | Worker full Artifact inputs and exact task/launch reconstruction assertions |
| Local choices without reapproval | Explicit local-freedom prompt; ordinary successful Worker follows unchanged lifecycle |
| Safe explicit pre-deviation stop | Closed bounded stop schema/categories; actual stop-only Worker smoke |
| Material change requires new Human Plan | Initial/fixing stop invalidates authority; actual exact second Human approval → actual new-Plan Worker / Validation / recovery; fake connected full continuation |
| Fresh simplicity before every new Gate | Connected v1 → stop → v2/fresh review → Gate; live actual Planner/simplicity |
| Oracle cannot approve/bypass | Decision-point guard before/after invalidation; validated immutable deviation input; existing Oracle authority tests |
| Unreported violations detectable | Existing reviewer task + finding/round policy tests and connected COMPLETE-overridden replan |
| No old deviation/approval rebinding | Copied workflow/revision/stale approval rejection; stopped history/next Plan/workspace guards |
| Immutable/CAS/persist-before-effect | Artifact, stopped-State and deviation-State fault recovery with zero redispatch; retained existing checks |

## Validation

- Final `VITEST_MAX_WORKERS=2 pnpm check`: **PASS — typecheck / lint (no warnings) / format / 60 files, 835 tests**.
- Focused core boundary/transition + deviation/Oracle/completed-Worker tests: **PASS — 5 files, 103 tests** (`pnpm exec vitest run ... --maxWorkers=2`). After the final unpublished-stop guard/repeated-driver assertions, final boundary focused tests: **PASS — 2 files, 29 tests**, followed by the final full check above.
- `git diff --check`: **PASS**. Changed Markdown local paths/anchors: **73 PASS**.
- Independent actual Human approval binding, four Artifact hashes, State/workspace, spawn/terminal and Worker transcript/full-output audits: **PASS**.

Early concurrent checks timed out at existing five-second test deadlines and are **not PASS**. A subsequent standalone check still timed out in the new overly long Fix scenario. Its redundant full third-Worker review loop was removed: the Fix test ends at the stopped authority barrier, while the separate connected test still proves new approval → Worker/Validation/reviews/Code Gate. No timeout value or authority assertion was relaxed. Final standalone check and final focused run passed.

The first transcript audit incorrectly assumed one read-only tool call; it failed and is not PASS. Inspection showed one `read` of source plus one `write` to the exact public pi-subagents raw output sink, not a workload/source write. The corrected audit requires those exact two calls, sink path/content matching the receipt/full report, and unchanged source bytes. The same terminal Worker was audited, never restarted.

Real Pi focused smoke: **PASS** — Pi 0.99.1 / pi-subagents 0.74.0 / installed Plannotator 0.27.16 / actual openai/gpt-6.1-sol, thinking medium. New Herdr tab/pane/Agent: `wF:t2T` / `wF:p34` / `issue15-deviation`. Start `2026-10-03T19:26:28.944Z`, finish `2026-10-03T19:29:11.111Z`.

Actual Human approved the original stop-only Plan in Plannotator. Actual Worker read `greeting.mjs`, reported the unauthorized object-input API change and stopped without workload/source mutation. Its only write was the exact public raw-output sink, which is evidence rather than Workflow authority. Actual Planner created Plan v2 allowing the proposed new contract; actual fresh simplicity was clean; a second actual Human Gate remained pending. Spawns: simplicity reviewer 2 / Worker 1 / Planner 1. Exact full output/receipt recovery matched, adapter recreation/resume redispatches 0, source bytes unchanged, implementation refs/revision/routing and current approval absent. All four actual children had public process-terminal proof observed / exit 0. Raw local report: `/tmp/issue15-smoke.json`. No tmux/direct Pi spawn or Human proxy answer. After successful audits, only the created tab and temporary auth symlink were removed; disposable evidence remains available for inspection.

Scout/original candidate/classifier are scripted. The original smoke above ended at a pending second Gate; by itself it did **not** prove actual reapproval/implementation continuation. That producer-side live gap was subsequently tested on the **same workflow/evidence**, as recorded below. #12 is not used to defer this #15 continuation check. Neither run proves actual Code Gate/live Jev/full v1 lifecycle/release PASS.

### Actual second approval / Worker continuation / Validation

**PASS** — new Herdr final tab/pane/Agent `wF:t2W` / `wF:p37` / `issue15-reapproval-final`, same disposable Git workspace and workflow `deviation-smoke-1791055588944`. Execution started `2026-10-03T20:23:58.376Z`; final audit completed `2026-10-03T20:32:18.261Z`. Pi **0.99.1**, pi-subagents **0.74.0**, Plannotator **0.27.16**, actual builtin Worker **openai/gpt-6.1-sol / medium / skills=[]**.

A read-only probe in its own new Herdr tab (`wF:t2V` / `wF:p36` / `issue15-reapproval-probe`) called the public `review-status` action for the exact persisted second review ID `6895cfd3-052a-4510-a490-75ac4e898df0`. The actual Human approval was already saved by Plannotator; Orchestrator State was still awaiting-plan-review. Probe State/bytes were unchanged, with no gate open/Worker dispatch. No proxy answer or inferred approval was substituted.

`deviation-smoke-continue` recovered that exact result through the production Plan port and `resumeWorkflow()` and then used the same normal driver. Immutable second approval / exact Plan v2 / fresh simplicity were verified in durable **State revision 52 before dispatch**. Plan v2 hash `3ae2b62a11a4aff42a63074b9a233d2bbc68e43dca04222369c20117a48f8f73` differs from the stopped Plan v1. Old Plan was absent from the new Worker's inputs.

- Actual new Worker **1**, run ID `a3365438-ce62-4821-a7a8-2b3bf3ad3714`; distinct from the original stopped Worker. No original Worker relaunch/resume. Total workflow Worker intents/runs **2**: one stopped, one implemented under new approval.
- Actual tool transcript: `read greeting.mjs → edit greeting.mjs → bash node --check greeting.mjs → read greeting.mjs → write exact public raw-output sink`. No other source/config/package files changed or dependencies added.
- New implementation revision **1** is bound to exact Plan v2, current routing, launch/receipt and full output. Before snapshot exactly matches the old stopped after snapshot. Source now accepts both strings and valid `{first,last}` objects, as Human approved.
- Independent Orchestrator **approved Validation** ran the unchanged `node --check greeting.mjs` contract and persisted PASS / exit 0. Worker prose/GREEN was not authority. The driver deliberately stopped at **reviewing / State revision 58**, before post-code review/Code Gate.
- Additional independent Node assertions passed: `greet('Ada') === 'Hello, Ada!'` and `greet({first:'Ada',last:'Lovelace'}) === 'Hello, Ada Lovelace!'`. These are smoke evidence, not a replacement/expansion of the approved syntax-only Validation Contract.
- Recreated adapter recovered the exact new implementation output and the exact old deviation output. Old approval/deviation application was rejected. Public terminal proof for the new Worker: **observed / exit 0**. Subsequent resume with continuation deliberately stopped preserved State revision 58, with **redispatch 0 / gate reopen 0**.
- Independent audit verified **six immutable Artifact hashes**, approval-before-dispatch, two exact Worker identities/lineage, snapshots, full output, launch, process-terminal, public tool transcript, Validation and workspace file set.

The first continuation command's runtime Worker/Validation completed, but its final behavior audit failed: it incorrectly assumed `process.execPath` was Node inside compiled Pi. That launched an unintended Pi CLI helper, which waited instead of executing the Node assertions. The specific owned helper process was terminated; this attempt is **not PASS**, and the accidental direct Pi helper launch did not follow the Herdr-only rule. No Workflow authority was granted through that helper and no Workflow Worker/implementation was retried. The harness now invokes explicit `node` and records failed status correctly. After reload, its audit-only branch checked the **same completed Worker** and persisted Validation, without launching any child or reopening a Gate. This corrected audit and independent checks PASS; the historical failed attempt remains recorded.

Local evidence: `/tmp/issue15-gate-status.json`, `/tmp/issue15-continuation-first-attempt.json` (failed audit), `/tmp/issue15-continuation-smoke.json` (final PASS / audit-only / zero dispatch). A preserved `approvalBeforeDispatch` record links the first execution to the final audit. The earlier report remains `/tmp/issue15-smoke.json`; it is not relabelled as a complete continuation run. After the final successful audits, both created probe/final tabs and the temporary auth symlink were cleaned. Disposable immutable evidence and both historical reports are retained.

After adding/fixing the continuation harness, final `VITEST_MAX_WORKERS=2 pnpm check`: **PASS — typecheck / lint (no warnings) / format / 60 files, 835 tests**. Final `git diff --check` and implementation-record local paths/anchors: **PASS**.

**Completion boundary:** #15's previously unperformed actual second-approval/Worker continuation/Validation/recovery check is now performed. Classifier remains scripted; actual Code Gate/live Jev/full lifecycle are not claimed. Runtime implementation was not changed by this additional validation.

### Reproduce

Use `simplicityFixture(authFile, repository)` in `tests/platform/simplicity-fixture.ts`, then `git init --quiet <fixture-cwd>` (Git evidence; #10 owns non-Git). Operator auth is linked read-only; settings/resources are isolated.

```sh
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd <fixture-cwd> \
  --label issue15-deviation --env PI_CODING_AGENT_DIR=<fixture-agentDir> --no-focus
herdr agent start issue15-deviation --kind pi --pane <returned-pane> -- \
  --no-approve --no-session --no-extensions --no-skills --no-prompt-templates \
  --no-context-files --no-tools -e <repo>/node_modules/pi-subagents \
  -e <installed-plannotator-package> -e <repo>/tests/platform/deviation-smoke-extension.ts \
  --model openai/gpt-6.1-sol --thinking medium
herdr agent prompt issue15-deviation '/deviation-smoke /tmp/issue15-smoke.json'
# Human approves original stop-only Plan in browser. Audit exact evidence/terminal/source.
# The initial report stops at the second Gate. Human approves exact Plan v2 in the browser.
# For the continuation check, retain the workflow/evidence and use a NEW Herdr tab,
# restoring only the fixture's temporary auth symlink if it was cleaned earlier.
herdr agent prompt <continuation-agent> \
  '/deviation-smoke-continue /tmp/issue15-smoke.json /tmp/issue15-continuation-smoke.json'
# Requires exact saved second approval; unknown/pending does not reopen/grant authority.
# Stops after approved Validation. Re-running at validating/reviewing is audit-only,
# never a Worker retry; an ambiguous implementing/blocked state is rejected.
# Close only created tabs and remove only the temporary auth symlink after audits.
```

## Limitations / other Issues

This is a semantic Worker stop contract plus evidence-based review/policy backstop, not an OS sandbox or universal semantic verifier. A dishonest/unaware Worker may violate instructions; supported reviewer evidence must detect such changes, and ambiguous outcomes block. Existing authorized partial changes remain as observed history. Report constraint provenance is checked mechanically; semantic correctness is not proven.

Non-Git/full workspace contents (#10), synchronous Code Gate correction (#9), general root/Main ownership (#5), integrated production verification (#12) remain their existing scopes. No automatic rollback, migration/rebinding of legacy attempts, new dependency, dedicated deviation reviewer, release evidence/CHANGELOG or GitHub Issue status changes.
