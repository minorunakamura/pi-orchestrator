import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertStateInvariants } from "../../core/workflow/invariants.ts";
import {
  parseWorkflowState,
  type WorkflowState,
} from "../../core/workflow/state.ts";
import { WorkflowLock } from "./workflow-lock.ts";

export interface StateFileHandle {
  writeFile(data: Uint8Array): Promise<void>;
  readFile?(): Promise<Uint8Array>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface StateFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  open(
    path: string,
    flags: string | number,
    mode?: number,
  ): Promise<StateFileHandle>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  link?(existingPath: string, newPath: string): Promise<void>;
  lstat(path: string): Promise<{
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }>;
  readFile(path: string): Promise<Uint8Array>;
}

const nodeFileSystem: StateFileSystem = {
  mkdir: (path, options) => fs.mkdir(path, options),
  open: (path, flags, mode) => fs.open(path, flags, mode),
  rename: fs.rename,
  unlink: fs.unlink,
  link: fs.link,
  lstat: fs.lstat,
  readFile: fs.readFile,
};

export interface StateStoreOptions {
  filesystem?: StateFileSystem;
  now?: () => string;
  workflowLock?: WorkflowLock;
}

export interface StateSaveOptions {
  lockHeld?: boolean;
}

export class StateStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateStoreError";
  }
}

export class StateNotFoundError extends StateStoreError {
  constructor(path: string) {
    super(`Workflow state does not exist: ${path}`);
    this.name = "StateNotFoundError";
  }
}

export class StateCorruptError extends StateStoreError {
  constructor(message: string) {
    super(message);
    this.name = "StateCorruptError";
  }
}

export class StateRevisionConflictError extends StateStoreError {
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super(
      `Workflow state revision conflict: expected ${expectedRevision}, found ${actualRevision}`,
    );
    this.name = "StateRevisionConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function asStateError(error: unknown, action: string): StateStoreError {
  if (error instanceof StateStoreError) return error;
  return new StateStoreError(
    `${action}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function assertSafeRevision(state: WorkflowState, path: string): void {
  if (!Number.isSafeInteger(state.stateRevision)) {
    throw new StateCorruptError(
      `Workflow state revision is not a safe integer at ${path}`,
    );
  }
}

function parseState(content: Uint8Array, path: string): WorkflowState {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(content).toString("utf8"));
  } catch (error) {
    throw new StateCorruptError(
      `Invalid workflow state JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const state = parseWorkflowState(value);
    assertStateInvariants(state);
    assertSafeRevision(state, path);
    return state;
  } catch (error) {
    if (error instanceof StateCorruptError) throw error;
    throw new StateCorruptError(
      `Invalid workflow state at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function serializeState(state: WorkflowState, path: string): Uint8Array {
  try {
    return Buffer.from(JSON.stringify(state), "utf8");
  } catch (error) {
    throw new StateStoreError(
      `Unable to serialize workflow state at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function removeTempFile(
  filesystem: StateFileSystem,
  path: string,
): Promise<void> {
  try {
    await filesystem.unlink(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

export class StateStore {
  readonly rootDirectory: string;
  readonly statePath: string;
  private readonly filesystem: StateFileSystem;
  private readonly now: () => string;
  private readonly workflowLock: WorkflowLock;

  constructor(rootDirectory: string, options: StateStoreOptions = {}) {
    this.rootDirectory = resolve(rootDirectory);
    this.statePath = join(this.rootDirectory, "state.json");
    this.filesystem = options.filesystem ?? nodeFileSystem;
    this.now = options.now ?? (() => new Date().toISOString());
    this.workflowLock =
      options.workflowLock ??
      new WorkflowLock(this.rootDirectory, {
        filesystem: this.filesystem,
        now: this.now,
      });
  }

  async loadState(): Promise<WorkflowState> {
    await this.assertRootDirectory();
    let metadata: Awaited<ReturnType<StateFileSystem["lstat"]>>;
    try {
      metadata = await this.filesystem.lstat(this.statePath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new StateNotFoundError(this.statePath);
      }
      throw asStateError(
        error,
        `Unable to inspect workflow state at ${this.statePath}`,
      );
    }

    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new StateCorruptError(
        `Workflow state is not a regular file: ${this.statePath}`,
      );
    }

    let handle: StateFileHandle;
    try {
      handle = await this.filesystem.open(
        this.statePath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
    } catch (error) {
      throw asStateError(
        error,
        `Unable to open workflow state at ${this.statePath}`,
      );
    }

    let content: Uint8Array;
    try {
      content = handle.readFile
        ? await handle.readFile()
        : await this.filesystem.readFile(this.statePath);
    } catch (error) {
      throw asStateError(
        error,
        `Unable to read workflow state at ${this.statePath}`,
      );
    } finally {
      await handle.close();
    }
    return parseState(content, this.statePath);
  }

  async saveState(
    state: WorkflowState,
    expectedRevision = state.stateRevision,
    options: StateSaveOptions = {},
  ): Promise<WorkflowState> {
    if (options.lockHeld) {
      return this.saveStateUnlocked(state, expectedRevision);
    }
    return this.workflowLock.withLock(() =>
      this.saveStateUnlocked(state, expectedRevision),
    );
  }

  async withLock<T>(operation: () => T | Promise<T>): Promise<T> {
    return this.workflowLock.withLock(operation);
  }

  private async saveStateUnlocked(
    state: WorkflowState,
    expectedRevision: number,
  ): Promise<WorkflowState> {
    assertStateInvariants(state);
    assertSafeRevision(state, this.statePath);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new StateStoreError(
        `Invalid expected state revision: ${expectedRevision}`,
      );
    }
    if (state.stateRevision !== expectedRevision) {
      throw new StateRevisionConflictError(
        expectedRevision,
        state.stateRevision,
      );
    }

    await this.ensureRootDirectory();
    const current = await this.readCurrentStateForSave();
    const actualRevision = current?.stateRevision ?? 0;
    if (actualRevision !== expectedRevision) {
      throw new StateRevisionConflictError(expectedRevision, actualRevision);
    }
    if (!current && expectedRevision !== 0) {
      throw new StateRevisionConflictError(expectedRevision, 0);
    }
    if (expectedRevision === Number.MAX_SAFE_INTEGER) {
      throw new StateStoreError(
        "Workflow state revision cannot be incremented",
      );
    }

    const next = {
      ...structuredClone(state),
      stateRevision: expectedRevision + 1,
      updatedAt: this.now(),
    } as WorkflowState;
    assertStateInvariants(next);
    assertSafeRevision(next, this.statePath);
    await this.publish(next);
    return next;
  }

  private async readCurrentStateForSave(): Promise<WorkflowState | undefined> {
    try {
      return await this.loadState();
    } catch (error) {
      if (error instanceof StateNotFoundError) return undefined;
      throw error;
    }
  }

  private async assertRootDirectory(): Promise<void> {
    let metadata: Awaited<ReturnType<StateFileSystem["lstat"]>>;
    try {
      metadata = await this.filesystem.lstat(this.rootDirectory);
    } catch (error) {
      throw asStateError(
        error,
        `Unable to inspect workflow directory at ${this.rootDirectory}`,
      );
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new StateStoreError(
        `Workflow directory is not a real directory: ${this.rootDirectory}`,
      );
    }
  }

  private async ensureRootDirectory(): Promise<void> {
    try {
      await this.filesystem.mkdir(this.rootDirectory, { recursive: true });
    } catch (error) {
      throw asStateError(
        error,
        `Unable to create workflow directory at ${this.rootDirectory}`,
      );
    }
    await this.assertRootDirectory();
  }

  private async assertTargetIsSafe(): Promise<void> {
    try {
      const metadata = await this.filesystem.lstat(this.statePath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new StateStoreError(
          `Workflow state is not a regular file: ${this.statePath}`,
        );
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error instanceof StateStoreError
        ? error
        : asStateError(
            error,
            `Unable to inspect workflow state at ${this.statePath}`,
          );
    }
  }

  private async publish(state: WorkflowState): Promise<void> {
    await this.assertTargetIsSafe();
    const tempPath = join(
      this.rootDirectory,
      `.state.json.${process.pid}.${randomUUID()}.tmp`,
    );
    const content = serializeState(state, this.statePath);
    let handle: StateFileHandle | undefined;
    try {
      handle = await this.filesystem.open(tempPath, "wx", 0o600);
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
        handle = undefined;
      }
      await this.filesystem.rename(tempPath, this.statePath);
      await this.syncDirectory();
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await removeTempFile(this.filesystem, tempPath);
    }
  }

  private async syncDirectory(): Promise<void> {
    let handle: StateFileHandle | undefined;
    try {
      handle = await this.filesystem.open(this.rootDirectory, "r");
      await handle.sync();
    } finally {
      if (handle) await handle.close();
    }
  }
}

export async function loadState(
  rootDirectory: string,
  options: StateStoreOptions = {},
): Promise<WorkflowState> {
  return new StateStore(rootDirectory, options).loadState();
}

export async function saveState(
  rootDirectory: string,
  state: WorkflowState,
  expectedRevision = state.stateRevision,
  options: StateStoreOptions = {},
  saveOptions: StateSaveOptions = {},
): Promise<WorkflowState> {
  return new StateStore(rootDirectory, options).saveState(
    state,
    expectedRevision,
    saveOptions,
  );
}
