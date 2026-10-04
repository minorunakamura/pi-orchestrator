// Ownership observations and publications are sequential authority barriers.
// oxlint-disable eslint/no-await-in-loop
import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, isAbsolute, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord, parseSchema } from "../../core/schema.ts";
import type { ArtifactRef } from "../../core/artifacts/references.ts";
import { sameArtifactRef } from "../../core/workflow/invariants.ts";
import type { WorkflowState } from "../../core/workflow/state.ts";
import {
  ArtifactStore,
  calculateSha256,
} from "../persistence/artifact-store.ts";
import { StateStore } from "../persistence/state-store.ts";
import { WorkflowLock } from "../persistence/workflow-lock.ts";
import {
  parseWorkerAttempt,
  isWorkspaceSnapshot,
} from "../worker/attempt-evidence.ts";
import {
  captureWorkspace,
  assertWorkspaceIdentity,
  unchangedDocumentScope,
  type WorkspaceSnapshot,
} from "../worker/workspace-evidence.ts";
import { verifyClarificationDocuments } from "./clarification.ts";
import {
  advanceWorkflow,
  type WorkflowStateWriter,
} from "./advance-workflow.ts";

export type OwnershipBoundary = Pick<WorkflowOwnership, "validate">;
export type OwnershipHint = Pick<
  WorkflowState,
  "workflowId" | "projectRoot" | "ownershipRef"
>;
interface OwnershipEvidence {
  schemaVersion: 1;
  recordType: "workflow-ownership";
  workflowId: string;
  rootSessionId: string;
  canonicalProjectRoot: string;
  workspace: WorkspaceSnapshot;
  ownershipRef?: ArtifactRef<"reconciliation">;
  previousRef?: ArtifactRef<"reconciliation">;
  workerAttemptRef?: ArtifactRef<"implementation">;
  documentRef?: ArtifactRef<"domain-document-write">;
}
export const isActiveOwner = (state: WorkflowState) =>
  !["completed", "failed"].includes(state.phase);
const within = (root: string, target: string) => {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

/** Production host boundary. Trust is deliberately absent: Pi owns resource trust. */
export class WorkflowOwnership {
  constructor(
    readonly cwd: string,
    readonly rootSessionId: string,
    private readonly host?: {
      known(): readonly OwnershipHint[];
      remember(state: WorkflowState): void;
    },
  ) {}
  get runsDirectory() {
    return join(this.cwd, ".pi", "orchestrator", "runs");
  }
  private stores(id: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id))
      throw Error("Unsafe ownership identity");
    const directory = join(this.runsDirectory, id);
    return {
      artifacts: new ArtifactStore(directory),
      states: new StateStore(directory),
    };
  }
  async active(): Promise<WorkflowState[]> {
    const owners: WorkflowState[] = [];
    let directory = await realpath(this.cwd);
    while (true) {
      owners.push(...(await this.activeAt(directory)));
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    // Session hints only deny/reconcile: losing repository State is never owner release.
    const canonical = await realpath(this.cwd);
    for (const hint of this.host?.known() ?? []) {
      if (!hint.projectRoot || !isAbsolute(hint.projectRoot))
        throw Error("Invalid host ownership hint");
      if (
        !within(hint.projectRoot, canonical) &&
        !within(canonical, hint.projectRoot)
      )
        continue;
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(hint.workflowId) ||
        (await realpath(hint.projectRoot)) !== hint.projectRoot
      )
        throw Error("Unsafe host ownership identity");
      const state = await new StateStore(
        join(hint.projectRoot, ".pi", "orchestrator", "runs", hint.workflowId),
      ).loadState();
      if (
        state.workflowId !== hint.workflowId ||
        !state.projectRoot ||
        (await realpath(state.projectRoot)) !== hint.projectRoot ||
        (hint.ownershipRef &&
          !sameArtifactRef(hint.ownershipRef, state.ownershipRef))
      )
        throw Error("Known workflow ownership disappeared or changed");
      if (
        isActiveOwner(state) &&
        !owners.some(
          (owner) =>
            owner.workflowId === state.workflowId &&
            owner.projectRoot === state.projectRoot,
        )
      )
        owners.push(state);
    }
    for (const state of owners)
      this.host?.remember({
        ...state,
        projectRoot: await realpath(state.projectRoot!),
      });
    return owners;
  }
  private async activeAt(canonical: string): Promise<WorkflowState[]> {
    // Never follow a project-controlled runtime-directory symlink.
    for (const path of [
      join(canonical, ".pi"),
      join(canonical, ".pi", "orchestrator"),
      join(canonical, ".pi", "orchestrator", "runs"),
    ]) {
      try {
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw Error("Unsafe ownership directory");
      } catch (error) {
        if (isRecord(error) && error.code === "ENOENT") return [];
        throw error;
      }
    }
    const states: WorkflowState[] = [];
    const runs = join(canonical, ".pi", "orchestrator", "runs");
    for (const name of await readdir(runs)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name))
        throw Error("Unsafe workflow identity");
      const stat = await lstat(join(runs, name));
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw Error("Unsafe workflow directory");
      const state = await new StateStore(join(runs, name)).loadState();
      if (
        state.workflowId !== name ||
        !state.projectRoot ||
        (await realpath(state.projectRoot)) !== canonical
      )
        throw Error("Workflow ownership workspace/identity mismatch");
      if (isActiveOwner(state)) states.push(state);
    }
    return states;
  }
  async start<T>(create: () => Promise<T>): Promise<T> {
    await this.active(); // Verify ancestors before the lock creates anything.
    return new WorkflowLock(join(this.cwd, ".pi", "orchestrator")).withLock(
      async () => {
        if ((await this.active()).length)
          throw Error("Workspace already has an active workflow owner");
        return create();
      },
    );
  }
  private async publish(state: WorkflowState, evidence: OwnershipEvidence) {
    const body = JSON.stringify(evidence, null, 2) + "\n";
    return this.stores(state.workflowId).artifacts.writeText(
      "reconciliation",
      `ownership-${calculateSha256(body)}.md`,
      body,
    );
  }
  async initialize(
    state: WorkflowState,
    writer: WorkflowStateWriter,
  ): Promise<WorkflowState> {
    const canonicalProjectRoot = await realpath(this.cwd);
    if (
      !this.rootSessionId ||
      !state.projectRoot ||
      (await realpath(state.projectRoot)) !== canonicalProjectRoot
    )
      throw Error("Missing exact host ownership identity");
    const workspace = await captureWorkspace(
      this.cwd,
      this.stores(state.workflowId).artifacts.rootDirectory,
    );
    // Nested Git workspaces would otherwise create independent owners of the same repository.
    if (workspace.root !== canonicalProjectRoot)
      throw Error("Workflow must own the canonical workspace root");
    const ownershipRef = await this.publish(state, {
      schemaVersion: 1,
      recordType: "workflow-ownership",
      workflowId: state.workflowId,
      rootSessionId: this.rootSessionId,
      canonicalProjectRoot,
      workspace,
    });
    this.host?.remember({
      ...state,
      projectRoot: canonicalProjectRoot,
      ownershipRef,
    });
    return writer.saveState({ ...state, ownershipRef }, state.stateRevision);
  }
  async validate(
    state: WorkflowState,
    writer: WorkflowStateWriter,
    recovery = false,
  ): Promise<WorkflowState> {
    if (!isActiveOwner(state)) return state;
    try {
      const owners = await this.active();
      if (
        owners.length !== 1 ||
        owners[0].workflowId !== state.workflowId ||
        !state.ownershipRef
      )
        throw Error("Missing/conflicting durable workspace owner");
      const { artifacts } = this.stores(state.workflowId);
      const initial: OwnershipEvidence = JSON.parse(
        await artifacts.readText(state.ownershipRef),
      );
      const checkpoint: OwnershipEvidence = state.workspaceCheckpointRef
        ? JSON.parse(await artifacts.readText(state.workspaceCheckpointRef))
        : initial;
      const canonical = await realpath(this.cwd);
      for (const evidence of [initial, checkpoint]) {
        if (
          evidence.schemaVersion !== 1 ||
          evidence.recordType !== "workflow-ownership" ||
          evidence.workflowId !== state.workflowId ||
          evidence.rootSessionId !== this.rootSessionId ||
          evidence.canonicalProjectRoot !== canonical ||
          !isWorkspaceSnapshot(evidence.workspace) ||
          evidence.workspace.root !== canonical
        )
          throw Error("Stale host/workspace ownership");
      }
      if (
        state.workspaceCheckpointRef &&
        !sameArtifactRef(checkpoint.ownershipRef, state.ownershipRef)
      )
        throw Error("Copied ownership checkpoint");
      let expected = checkpoint.workspace;
      let changed = false;
      const workerRef = state.coding.workerAttemptRef;
      if (
        workerRef &&
        !sameArtifactRef(workerRef, checkpoint.workerAttemptRef)
      ) {
        const worker = await artifacts.readJson(workerRef, parseWorkerAttempt);
        if (
          worker.workflowId !== state.workflowId ||
          worker.dispatch.ownerRunId !== state.workflowId ||
          !isDeepStrictEqual(worker.before, expected)
        )
          throw Error("Worker is not bound to owned workspace");
        // Exact persisted mutation intent may already have changed files. Only the existing
        // reconciler can prove its historical outcome; never rebaseline or redispatch here.
        if (recovery && !["succeeded", "deviated"].includes(worker.status))
          return state;
        if (
          !["succeeded", "deviated"].includes(worker.status) ||
          worker.after?.status !== "observed" ||
          !worker.receipt ||
          !worker.launch ||
          !worker.runId
        )
          throw Error(
            "Unresolved or unbound mutating Worker; reconciliation required",
          );
        expected = worker.after.snapshot;
        changed = true;
      }
      const documentRef = state.planning.domainDocumentWriteRef;
      if (
        documentRef &&
        !sameArtifactRef(documentRef, checkpoint.documentRef)
      ) {
        await verifyClarificationDocuments(state, {
          artifactStore: artifacts,
          stateStore: writer,
        });
        const document = JSON.parse(await artifacts.readText(documentRef));
        const intent = JSON.parse(await artifacts.readText(document.intentRef));
        const paths: string[] = document.operations.map(
          (op: { path: string }) => op.path,
        );
        const snapshot = (ref: ArtifactRef<"reconciliation">) => {
          if (!ref || ref.kind !== "reconciliation")
            throw Error("Missing document workspace reference");
          return artifacts.readJson(ref, (value) =>
            parseSchema(
              value,
              isWorkspaceSnapshot,
              "Document workspace evidence",
            ),
          );
        };
        const workspaceBefore = await snapshot(document.workspaceBeforeRef);
        const workspaceAfter = await snapshot(document.workspaceAfterRef);
        const scopeBefore = await snapshot(document.scopeBeforeRef);
        const scopeAfter = await snapshot(document.scopeAfterRef);
        assertWorkspaceIdentity(expected, workspaceAfter);
        const exclusions = [
          ...new Set([...expected.policy.exclusions, ...paths]),
        ].toSorted();
        if (
          !sameArtifactRef(
            document.workspaceBeforeRef,
            intent.workspaceBeforeRef,
          ) ||
          !sameArtifactRef(document.scopeBeforeRef, intent.scopeBeforeRef) ||
          !isDeepStrictEqual(scopeBefore.policy.exclusions, exclusions) ||
          !isDeepStrictEqual(scopeAfter.policy.exclusions, exclusions)
        )
          throw Error("Document scope is not bound to pre-write intent");
        if (
          !isDeepStrictEqual(workspaceBefore, expected) ||
          !unchangedDocumentScope(
            scopeBefore,
            scopeAfter,
            document.operations.map((op: { path: string }) => op.path),
          )
        )
          throw Error(
            "Documentation exception includes out-of-band workspace mutation",
          );
        expected = workspaceAfter;
        changed = true;
      }
      const current = await captureWorkspace(
        this.cwd,
        artifacts.rootDirectory,
        expected,
      );
      if (!isDeepStrictEqual(expected, current))
        throw Error("Out-of-band workspace mutation");
      if (!changed) return state;
      const ref = await this.publish(state, {
        ...initial,
        workspace: current,
        ownershipRef: state.ownershipRef,
        previousRef: state.workspaceCheckpointRef ?? state.ownershipRef,
        ...(workerRef ? { workerAttemptRef: workerRef } : {}),
        ...(documentRef ? { documentRef } : {}),
      });
      return writer.saveState(
        { ...state, workspaceCheckpointRef: ref },
        state.stateRevision,
      );
    } catch (error) {
      if (state.phase === "blocked") throw error;
      const { artifacts } = this.stores(state.workflowId);
      const body =
        JSON.stringify(
          {
            schemaVersion: 1,
            recordType: "ownership-denied",
            workflowId: state.workflowId,
            sourceRevision: state.stateRevision,
            ownershipRef: state.ownershipRef,
            checkpointRef: state.workspaceCheckpointRef,
            reason:
              error instanceof Error ? error.message : "Ownership unavailable",
          },
          null,
          2,
        ) + "\n";
      const evidenceRef = await artifacts.writeText(
        "reconciliation",
        `ownership-denied-${calculateSha256(body)}.md`,
        body,
      );
      // Drift never becomes a new implementation baseline, approval, or automatic retry.
      return advanceWorkflow(
        state,
        {
          type: "BLOCK",
          reason: "operator-attention-required",
          evidenceRef,
        },
        writer,
      );
    }
  }
}
