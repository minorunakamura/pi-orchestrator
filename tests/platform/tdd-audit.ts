import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactStore } from "../../src/runtime/persistence/artifact-store.ts";
import { StateStore } from "../../src/runtime/persistence/state-store.ts";
import type { SubagentsIntegration } from "../../src/runtime/integrations/subagents.ts";
import { ValidationRunner } from "../../src/runtime/orchestrator/validation-runner.ts";
import { CommandValidationExecutor } from "../../src/runtime/validation/command-executor.ts";
import { parseWorkerAttempt } from "../../src/runtime/worker/attempt-evidence.ts";
import { validateWorkerStrategy } from "../../src/runtime/worker/development-strategy.ts";
import { isRecord } from "../../src/core/schema.ts";
import { auditTddTranscript } from "./tdd-evidence.ts";

/** Historical audit and deterministic Validation only: no Worker launch/relaunch API here. */
export async function finishTddSmoke(
  store: ArtifactStore,
  states: StateStore,
  adapter: SubagentsIntegration,
  cwd: string,
) {
  const state = await states.loadState();
  assert.equal(state.phase, "validating");
  assert(state.planning.approvedPlanRef && state.planning.latestPlanReviewRef);
  const approval = JSON.parse(
    await store.readText(state.planning.latestPlanReviewRef),
  );
  assert.equal(approval.status, "approved");
  assert.deepEqual(approval.planRef, state.planning.approvedPlanRef);
  const attempt = await store.readJson(
    state.coding.workerAttemptRef!,
    parseWorkerAttempt,
  );
  assert(attempt.launch && attempt.receipt);
  assert.equal(attempt.status, "succeeded");
  assert.equal(attempt.launch.packageVersion, "0.74.0");
  assert.equal(attempt.launch.source, "builtin");
  assert.equal(attempt.launch.inheritSkills, false);
  assert.deepEqual(attempt.launch.policy.skills, ["tdd", "codebase-design"]);
  await validateWorkerStrategy(store, state, attempt, adapter);
  const records: unknown[] = (
    await readFile(join(attempt.receipt.asyncDir, "events.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const reads = records.filter(
    (event) =>
      isRecord(event) &&
      event.type === "tool_execution_start" &&
      event.toolName === "read",
  );
  assert(
    reads.some((event) => JSON.stringify(event).includes("/tdd/SKILL.md")),
    "Actual Worker must read upstream tdd",
  );
  assert(
    reads.some((event) =>
      JSON.stringify(event).includes("/codebase-design/SKILL.md"),
    ),
    "Actual Worker must read selected supporting skill",
  );
  const colors = auditTddTranscript(records);
  const recovered = await adapter.status(attempt.runId!, attempt.receipt);
  assert.equal(recovered.status, "succeeded");
  const implementation = JSON.parse(
    await store.readText(state.coding.implementationRef!),
  );
  assert(recovered.result?.status === "succeeded");
  assert.equal(recovered.result.output, implementation.output);
  const files = (await readdir(cwd))
    .filter((name) => name !== ".git")
    .toSorted();
  assert.deepEqual(files, ["greeting.mjs", "greeting.test.mjs"]);
  // All historical checks precede the one remaining deterministic side effect.
  const validated = await new ValidationRunner({
    artifactStore: store,
    stateStore: states,
    validationExecutor: new CommandValidationExecutor(),
  }).execute({ state });
  assert.equal(validated.validation.status, "passed");
  assert.equal(validated.state.phase, "reviewing");
  assert.deepEqual(
    validated.state.planning.approvedPlanRef,
    state.planning.approvedPlanRef,
  );
  return {
    status: "passed",
    finishedAt: new Date().toISOString(),
    runDirectory: store.rootDirectory,
    cwd,
    subagents: attempt.launch.packageVersion,
    planRef: state.planning.approvedPlanRef,
    methodRef: state.planning.developmentMethodRef,
    humanReviewRef: state.planning.latestPlanReviewRef,
    launch: attempt.launch,
    receipt: attempt.receipt,
    implementationRef: state.coding.implementationRef,
    validationRef: validated.validationRef,
    verticalSlices: colors,
    phase: validated.state.phase,
    limitations:
      "Actual Human Plan Gate and builtin Worker/skills/commands/Validation/recovery. Scout/Planner/stage and execution classifiers are scripted fixture evidence (live classify 0). Stops at reviewing: no Code approval, full lifecycle, Plan simplicity (#14), deviation (#15) or release completion claim.",
  };
}
