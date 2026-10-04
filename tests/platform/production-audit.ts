import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactStore } from "../../src/runtime/persistence/artifact-store.ts";
import { StateStore } from "../../src/runtime/persistence/state-store.ts";
import { isArtifactRef } from "../../src/core/artifacts/references.ts";
import { isRecord } from "../../src/core/schema.ts";
import { parseWorkerAttempt } from "../../src/runtime/worker/attempt-evidence.ts";
import { parseCodeReviewArtifact } from "../../src/runtime/orchestrator/coding-orchestrator.ts";
import { parseValidationContractBlock } from "../../src/runtime/validation/contract-parser.ts";
import { fixedReviewerSet } from "../../src/runtime/orchestrator/review-runner.ts";
import { artifactRelativePath } from "../../src/runtime/persistence/artifact-paths.ts";
import { isCodeReviewAttempt } from "../../src/core/coding/code-review.ts";
import { verifyCodeReviewSource } from "../../src/runtime/worker/code-review-source.ts";

/** Read-only audit: cannot launch/relaunch a child, settle a Gate, or repair authority. */
export async function auditProductionWorkflow(cwd: string) {
  const runs = join(cwd, ".pi", "orchestrator", "runs");
  const names = (await readdir(runs)).filter((name) => !name.startsWith("."));
  assert.equal(names.length, 1, "Exactly one disposable workflow required");
  const root = join(runs, names[0]);
  const store = new ArtifactStore(root);
  const state = await new StateStore(root).loadState();
  assert.equal(
    state.phase,
    "completed",
    "Both Human Gates must actually settle",
  );
  const refs = new Map<string, string>();
  const evidence: unknown[] = [];
  async function visit(value: unknown): Promise<void> {
    if (isArtifactRef(value)) {
      if (refs.has(value.path)) {
        assert.equal(refs.get(value.path), value.sha256);
        return;
      }
      // Reuse the product's path/kind/hash/symlink checks, not unchecked reference paths.
      const content = await store.readText(value);
      refs.set(value.path, value.sha256);
      // Clarification/document/checkpoint records are JSON stored under canonical .md paths.
      if (
        value.path.endsWith(".json") ||
        [
          "clarification",
          "domain-document-write",
          "reconciliation",
          "diagnosis",
        ].includes(value.kind)
      ) {
        const body: unknown = JSON.parse(content);
        evidence.push(body);
        await visit(body);
      }
      return;
    }
    if (Array.isArray(value)) await Promise.all(value.map(visit));
    else if (isRecord(value))
      await Promise.all(Object.values(value).map(visit));
  }
  await visit(state);
  // Reviewer launch/receipt hashes use the existing external index, not ArtifactRef fields.
  await Promise.all(
    fixedReviewerSet.flatMap(({ source }) => {
      const key = `review.launch.p${state.planning.approvedPlanVersion}.i${state.coding.implementationRevision}.r${state.coding.reviewRound}.${source}`;
      assert(
        state.external[key] && state.external[`${key}.receipt`],
        "Both reviewer launch/receipt bindings required",
      );
      return [
        visit({
          kind: "agent-launch",
          path: artifactRelativePath("agent-launch", `${key}-launch.json`),
          schemaVersion: 1,
          sha256: state.external[key],
        }),
        visit({
          kind: "agent-launch",
          path: artifactRelativePath("agent-launch", `${key}-receipt.json`),
          schemaVersion: 1,
          sha256: state.external[`${key}.receipt`],
        }),
      ];
    }),
  );
  assert(state.planning.approvedPlanRef);
  assert(state.planning.latestPlanReviewRef);
  assert(state.coding.workerAttemptRef);
  assert(state.coding.latestCodeReviewRef);
  assert(state.coding.validationRef);
  assert(state.coding.correctnessReviewRef);
  assert(state.coding.ponytailReviewRef);
  assert(state.coding.findingEvaluationRef);
  assert(state.coding.acceptedFindingsRef);
  assert(state.jevUsage?.authorizationRef);
  assert(state.jevUsage.attemptsReserved > 0);
  const plan = await store.readText(state.planning.approvedPlanRef);
  const contract = parseValidationContractBlock(plan);
  const worker = parseWorkerAttempt(
    JSON.parse(await store.readText(state.coding.workerAttemptRef)),
  );
  assert.equal(worker.status, "succeeded");
  assert.deepEqual(worker.approvedPlanRef, state.planning.approvedPlanRef);
  const code = parseCodeReviewArtifact(
    JSON.parse(await store.readText(state.coding.latestCodeReviewRef)),
  );
  const codeAttempt: unknown = JSON.parse(
    await store.readText(code.attemptRef),
  );
  assert(isCodeReviewAttempt(codeAttempt));
  await verifyCodeReviewSource(codeAttempt.source, root);
  assert.equal(code.result.approved, true);
  assert.deepEqual(code.implementationRef, state.coding.implementationRef);
  const validation: unknown = JSON.parse(
    await store.readText(state.coding.validationRef),
  );
  assert(isRecord(validation));
  assert.equal(validation.status, "passed");
  assert.deepEqual(validation.approvedPlanRef, state.planning.approvedPlanRef);
  return {
    state,
    root,
    store,
    refs: Object.fromEntries(refs),
    evidence,
    plan,
    contract,
    worker,
    code,
    codeAttempt,
  };
}
