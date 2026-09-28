import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";

export interface WorkflowLockFileHandle {
  writeFile(data: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface WorkflowLockFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  open(
    path: string,
    flags: string | number,
    mode?: number,
  ): Promise<WorkflowLockFileHandle>;
  unlink(path: string): Promise<void>;
  link?(existingPath: string, newPath: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  lstat(path: string): Promise<{
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }>;
}

const nodeFileSystem: WorkflowLockFileSystem = {
  mkdir: (path, options) => fs.mkdir(path, options),
  open: (path, flags, mode) => fs.open(path, flags, mode),
  unlink: fs.unlink,
  link: fs.link,
  readFile: fs.readFile,
  lstat: fs.lstat,
};

export interface WorkflowLockOptions {
  filesystem?: WorkflowLockFileSystem;
  now?: () => string;
}

export class WorkflowLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowLockError";
  }
}

export class WorkflowLockUnavailableError extends WorkflowLockError {
  constructor(path: string) {
    super(`Workflow lock is already held: ${path}`);
    this.name = "WorkflowLockUnavailableError";
  }
}

export type WorkflowLockRelease = (() => Promise<void>) & {
  release(): Promise<void>;
};

interface LockMetadata {
  pid: number;
  token: string;
  acquiredAt: string;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function asLockError(error: unknown, action: string): WorkflowLockError {
  if (error instanceof WorkflowLockError) return error;
  return new WorkflowLockError(
    `${action}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function parseLockMetadata(content: Uint8Array): LockMetadata | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(content).toString("utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      typeof Reflect.get(value, "pid") !== "number" ||
      !Number.isSafeInteger(Reflect.get(value, "pid")) ||
      Reflect.get(value, "pid") <= 0 ||
      typeof Reflect.get(value, "token") !== "string" ||
      Reflect.get(value, "token").length === 0 ||
      typeof Reflect.get(value, "acquiredAt") !== "string" ||
      Reflect.get(value, "acquiredAt").length === 0
    ) {
      return undefined;
    }
    return {
      pid: Reflect.get(value, "pid"),
      token: Reflect.get(value, "token"),
      acquiredAt: Reflect.get(value, "acquiredAt"),
    };
  } catch {
    return undefined;
  }
}

export class WorkflowLock {
  readonly rootDirectory: string;
  readonly lockPath: string;
  private readonly filesystem: WorkflowLockFileSystem;
  private readonly now: () => string;

  constructor(rootDirectory: string, options: WorkflowLockOptions = {}) {
    this.rootDirectory = resolve(rootDirectory);
    this.lockPath = join(this.rootDirectory, ".workflow.lock");
    this.filesystem = options.filesystem ?? nodeFileSystem;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async acquire(): Promise<WorkflowLockRelease> {
    await this.ensureRootDirectory();

    try {
      return await this.createLease();
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        // Fail closed even for stale locks: unlinking by path could delete a
        // replacement owner's lock. Recovery is outside acquisition in the Initial Scope.
        throw new WorkflowLockUnavailableError(this.lockPath);
      }
      throw asLockError(
        error,
        `Unable to acquire workflow lock at ${this.lockPath}`,
      );
    }
  }

  async withLock<T>(operation: () => T | Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  private async createLease(): Promise<WorkflowLockRelease> {
    const metadata: LockMetadata = {
      pid: process.pid,
      token: randomUUID(),
      acquiredAt: this.now(),
    };
    let handle: WorkflowLockFileHandle | undefined;
    let handleClosed = true;

    if (this.filesystem.link) {
      const tempPath = `${this.lockPath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        handle = await this.filesystem.open(tempPath, "wx", 0o600);
        handleClosed = false;
        await handle.writeFile(Buffer.from(JSON.stringify(metadata), "utf8"));
        await handle.sync();
        await handle.close();
        handleClosed = true;
        await this.filesystem.link(tempPath, this.lockPath);
      } catch (error) {
        if (handle && !handleClosed) {
          await handle.close().catch(() => undefined);
        }
        await this.filesystem.unlink(tempPath).catch(() => undefined);
        throw error;
      }
      await this.filesystem.unlink(tempPath).catch(() => undefined);
    } else {
      handle = await this.filesystem.open(this.lockPath, "wx", 0o600);
      handleClosed = false;
      try {
        await handle.writeFile(Buffer.from(JSON.stringify(metadata), "utf8"));
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        handleClosed = true;
        await this.filesystem.unlink(this.lockPath).catch(() => undefined);
        throw error;
      }
    }

    let releasePromise: Promise<void> | undefined;
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      if (releasePromise) return releasePromise;
      releasePromise = this.releaseOwnedLock(
        handle,
        metadata.token,
        () => handleClosed,
        () => {
          handleClosed = true;
        },
      )
        .then(() => {
          released = true;
        })
        .finally(() => {
          releasePromise = undefined;
        });
      return releasePromise;
    };
    return Object.assign(release, { release });
  }

  private async releaseOwnedLock(
    handle: WorkflowLockFileHandle | undefined,
    token: string,
    isHandleClosed: () => boolean,
    markHandleClosed: () => void,
  ): Promise<void> {
    let closeError: unknown;
    if (handle && !isHandleClosed()) {
      try {
        await handle.close();
        markHandleClosed();
      } catch (error) {
        closeError = error;
      }
    }

    try {
      const content = await this.filesystem.readFile(this.lockPath);
      const metadata = parseLockMetadata(content);
      if (!metadata || metadata.token !== token) {
        throw new WorkflowLockError(
          `Workflow lock ownership changed: ${this.lockPath}`,
        );
      }
      await this.filesystem.unlink(this.lockPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw asLockError(
          error,
          `Unable to release workflow lock at ${this.lockPath}`,
        );
      }
    }

    if (closeError) {
      throw asLockError(
        closeError,
        `Unable to close workflow lock at ${this.lockPath}`,
      );
    }
  }

  private async ensureRootDirectory(): Promise<void> {
    try {
      await this.filesystem.mkdir(this.rootDirectory, { recursive: true });
      const metadata = await this.filesystem.lstat(this.rootDirectory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new WorkflowLockError(
          `Workflow directory is not a real directory: ${this.rootDirectory}`,
        );
      }
    } catch (error) {
      throw asLockError(
        error,
        `Unable to prepare workflow directory at ${this.rootDirectory}`,
      );
    }
  }
}
