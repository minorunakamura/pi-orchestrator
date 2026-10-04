import { lstat, readFile, realpath } from "node:fs/promises";
import type { CodeReviewSource } from "../../core/coding/code-review.ts";
import { captureRepository } from "./repository-evidence.ts";
import {
  captureWorkspace,
  assertWorkspaceIdentity,
  workspaceReviewPatch,
  type WorkspaceSnapshot,
} from "./workspace-evidence.ts";
import {
  parseWorkerAttempt,
  type WorkerAttemptEvidence,
} from "./attempt-evidence.ts";
import { ArtifactStore } from "../persistence/artifact-store.ts";
import type { ArtifactRef } from "../../core/artifacts/references.ts";
import type { WorkflowArtifactWriter } from "../orchestrator/planning-orchestrator.ts";
import {
  calculateSha256,
  validateArtifactRef,
} from "../persistence/artifact-store.ts";

export { gitReviewPatch } from "./repository-evidence.ts";

/** Follow only immutable predecessor refs; never discover a baseline by directory scanning. */
export async function readWorkspaceBaseline(
  store: WorkflowArtifactWriter,
  ref: ArtifactRef<"implementation">,
  latest: WorkerAttemptEvidence,
): Promise<{
  ref: ArtifactRef<"implementation">;
  snapshot: WorkspaceSnapshot;
}> {
  const seen = new Set<string>();
  let record = latest,
    currentRef = ref;
  while (true) {
    if (seen.has(currentRef.path) || seen.size >= 10_000)
      throw Error("Invalid Worker baseline history");
    seen.add(currentRef.path);
    if (
      record.workflowId !== latest.workflowId ||
      record.inputRevision > latest.inputRevision
    )
      throw Error("Worker baseline belongs to another workflow/revision");
    assertWorkspaceIdentity(record.before, latest.before);
    if (!record.previousRef) {
      if (record.status !== "intent" || record.inputRevision !== 0)
        throw Error("Missing initial Worker baseline");
      return { ref: currentRef, snapshot: record.before };
    }
    currentRef = record.previousRef;
    if (!store.readText)
      throw Error("Baseline requires readable ArtifactStore");
    // Exact refs/hash verification, including deleted baseline bytes.
    // oxlint-disable-next-line eslint/no-await-in-loop
    validateArtifactRef(currentRef);
    // oxlint-disable-next-line eslint/no-await-in-loop
    const content = await store.readText(currentRef);
    if (calculateSha256(content) !== currentRef.sha256)
      throw Error("Workspace baseline Artifact hash mismatch");
    record = parseWorkerAttempt(JSON.parse(content));
  }
}

export async function verifyCodeReviewSource(
  source: CodeReviewSource,
  excludedDirectory: string,
): Promise<void> {
  const [cwd, patchPath, metadata] = await Promise.all([
    realpath(source.cwd),
    realpath(source.patchFile),
    lstat(source.patchFile),
  ]);
  if (
    cwd !== source.cwd ||
    patchPath !== source.patchFile ||
    !metadata.isFile() ||
    metadata.nlink !== 1
  )
    throw Error("Code Review source identity changed");
  const [patch, snapshot] = await Promise.all([
    readFile(source.patchFile),
    source.type === "git-patch"
      ? captureRepository(source.cwd, excludedDirectory)
      : captureWorkspace(source.cwd, excludedDirectory),
  ]);
  if (source.type === "filesystem-patch") {
    const store = new ArtifactStore(excludedDirectory);
    const latest = await store.readJson(
      source.workerAttemptRef,
      parseWorkerAttempt,
    );
    const baseline = await readWorkspaceBaseline(
      store,
      source.workerAttemptRef,
      latest,
    );
    if (
      baseline.ref.path !== source.baselineRef.path ||
      baseline.ref.sha256 !== source.baselineRef.sha256 ||
      latest.status !== "succeeded" ||
      latest.after?.status !== "observed" ||
      calculateSha256(JSON.stringify(latest.after.snapshot)) !==
        source.workspaceDigest ||
      calculateSha256(
        await workspaceReviewPatch(
          baseline.snapshot,
          snapshot,
          excludedDirectory,
        ),
      ) !== source.patchSha256
    )
      throw Error(
        "Code Review filesystem baseline/Worker/patch binding changed",
      );
  }
  if (
    snapshot.kind !== (source.type === "git-patch" ? "git" : "filesystem") ||
    patch.length > 1024 * 1024 ||
    calculateSha256(patch) !== source.patchSha256 ||
    calculateSha256(JSON.stringify(snapshot)) !== source.workspaceDigest
  )
    throw Error(
      "Code Review patch or workspace changed (including provider identity)",
    );
}
