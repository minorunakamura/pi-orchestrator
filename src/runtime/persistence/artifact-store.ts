import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import {
  parseArtifactRef,
  type ArtifactKind,
  type ArtifactRef,
} from "../../core/artifacts/references.ts";
import {
  artifactDirectoryName,
  artifactDirectoryPath,
  artifactPath,
  artifactRelativePath,
} from "./artifact-paths.ts";

export interface ArtifactFileHandle {
  writeFile(data: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface ArtifactFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  open(path: string, flags: string, mode?: number): Promise<ArtifactFileHandle>;
  link(existingPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  lstat(path: string): Promise<{
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }>;
  readFile(path: string): Promise<Uint8Array>;
}

const nodeFileSystem: ArtifactFileSystem = {
  mkdir: (path, options) => fs.mkdir(path, options),
  open: (path, flags, mode) => fs.open(path, flags, mode),
  link: fs.link,
  unlink: fs.unlink,
  lstat: fs.lstat,
  readFile: fs.readFile,
};

export type ArtifactSchema<T> = (value: unknown) => T;

export interface ArtifactWriteOptions {
  schema?: ArtifactSchema<unknown>;
}

export interface ArtifactStoreOptions {
  filesystem?: ArtifactFileSystem;
}

export class ArtifactStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactStoreError";
  }
}

export class ArtifactImmutableError extends ArtifactStoreError {
  constructor(path: string) {
    super(`Immutable artifact already exists: ${path}`);
    this.name = "ArtifactImmutableError";
  }
}

export class ArtifactHashMismatchError extends ArtifactStoreError {
  constructor(path: string) {
    super(`Artifact SHA-256 hash mismatch: ${path}`);
    this.name = "ArtifactHashMismatchError";
  }
}

export class ArtifactSchemaValidationError extends ArtifactStoreError {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactSchemaValidationError";
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function asBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string"
    ? Buffer.from(content, "utf8")
    : new Uint8Array(content);
}

export function calculateSha256(content: string | Uint8Array): string {
  return createHash("sha256").update(asBytes(content)).digest("hex");
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function assertSafeRelativePath(path: string): void {
  if (
    path.length === 0 ||
    path.includes("\\") ||
    posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    path.startsWith("../") ||
    path === ".."
  ) {
    throw new ArtifactStoreError(`Invalid artifact path: ${path}`);
  }
}

function assertArtifactPathMatchesKind(ref: ArtifactRef): void {
  const directory = `${artifactDirectoryName(ref.kind)}/`;
  const fileName = ref.path.startsWith(directory)
    ? ref.path.slice(directory.length)
    : "";
  if (
    fileName.length === 0 ||
    fileName.includes("/") ||
    artifactRelativePath(ref.kind, fileName) !== ref.path
  ) {
    throw new ArtifactStoreError(
      `Artifact path does not match kind ${ref.kind}: ${ref.path}`,
    );
  }
}

export function validateArtifactRef<K extends ArtifactKind>(
  value: ArtifactRef<K>,
): ArtifactRef<K>;
export function validateArtifactRef(value: unknown): ArtifactRef;
export function validateArtifactRef(value: unknown): ArtifactRef {
  const ref = parseArtifactRef(value);
  assertSafeRelativePath(ref.path);
  assertArtifactPathMatchesKind(ref);
  if (!isSha256(ref.sha256)) {
    throw new ArtifactStoreError(`Invalid SHA-256 hash: ${ref.sha256}`);
  }
  return ref;
}

export function createArtifactRef<K extends ArtifactKind>(
  kind: K,
  path: string,
  content: string | Uint8Array,
): ArtifactRef<K> {
  const ref = {
    kind,
    path,
    schemaVersion: 1 as const,
    sha256: calculateSha256(content),
  } satisfies ArtifactRef<K>;
  return validateArtifactRef(ref);
}

function parseJson<T>(content: Uint8Array, schema: ArtifactSchema<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(content).toString("utf8"));
  } catch (error) {
    throw new ArtifactSchemaValidationError(
      `Invalid JSON artifact: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    return schema(value);
  } catch (error) {
    throw new ArtifactSchemaValidationError(
      `Invalid JSON artifact schema: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isJsonFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(".json");
}

async function removeTempFile(
  filesystem: ArtifactFileSystem,
  tempPath: string,
): Promise<void> {
  try {
    await filesystem.unlink(tempPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }
}

export class ArtifactStore {
  readonly rootDirectory: string;
  private readonly filesystem: ArtifactFileSystem;

  constructor(rootDirectory: string, options: ArtifactStoreOptions = {}) {
    this.rootDirectory = resolve(rootDirectory);
    this.filesystem = options.filesystem ?? nodeFileSystem;
  }

  async write<K extends ArtifactKind>(
    kind: K,
    fileName: string,
    content: string | Uint8Array,
    options: ArtifactWriteOptions = {},
  ): Promise<ArtifactRef<K>> {
    const bytes = asBytes(content);
    if (isJsonFile(fileName)) {
      if (!options.schema) {
        throw new ArtifactSchemaValidationError(
          "JSON artifacts require a schema validator",
        );
      }
      parseJson(bytes, options.schema);
    }

    const path = artifactRelativePath(kind, fileName);
    const ref = createArtifactRef(kind, path, bytes);
    const targetPath = artifactPath(this.rootDirectory, kind, fileName);
    const directory = artifactDirectoryPath(this.rootDirectory, kind);

    await this.assertDirectory(this.rootDirectory, true);
    await this.assertDirectory(directory, true);
    await this.filesystem.mkdir(directory, { recursive: true });
    await this.assertDirectory(this.rootDirectory);
    await this.assertDirectory(directory);
    await this.assertTargetDoesNotExist(targetPath);
    await this.publishAtomically(targetPath, bytes);

    return ref;
  }

  async writeText<K extends ArtifactKind>(
    kind: K,
    fileName: string,
    content: string,
  ): Promise<ArtifactRef<K>> {
    return this.write(kind, fileName, content);
  }

  async writeJson<K extends ArtifactKind, R>(
    kind: K,
    fileName: string,
    value: unknown,
    schema: ArtifactSchema<R>,
  ): Promise<ArtifactRef<K>> {
    if (!isJsonFile(fileName)) {
      throw new ArtifactSchemaValidationError(
        "writeJson requires a .json artifact file name",
      );
    }
    let content: string;
    try {
      content = JSON.stringify(value);
    } catch (error) {
      throw new ArtifactSchemaValidationError(
        `Unable to serialize JSON artifact: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (content === undefined) {
      throw new ArtifactSchemaValidationError(
        "Unable to serialize JSON artifact",
      );
    }
    return this.write(kind, fileName, content, { schema });
  }

  async read<K extends ArtifactKind>(ref: ArtifactRef<K>): Promise<Uint8Array> {
    const validRef = validateArtifactRef(ref);
    await this.assertDirectory(this.rootDirectory);
    await this.assertDirectory(
      artifactDirectoryPath(this.rootDirectory, validRef.kind),
    );
    const targetPath = this.resolveRef(validRef);
    const metadata = await this.filesystem.lstat(targetPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new ArtifactStoreError(
        `Artifact is not a regular file: ${ref.path}`,
      );
    }

    const content = await this.filesystem.readFile(targetPath);
    if (calculateSha256(content) !== validRef.sha256) {
      throw new ArtifactHashMismatchError(validRef.path);
    }
    return content;
  }

  async readText<K extends ArtifactKind>(ref: ArtifactRef<K>): Promise<string> {
    return Buffer.from(await this.read(ref)).toString("utf8");
  }

  async readJson<K extends ArtifactKind, T>(
    ref: ArtifactRef<K>,
    schema: ArtifactSchema<T>,
  ): Promise<T> {
    return parseJson(await this.read(ref), schema);
  }

  private resolveRef(ref: ArtifactRef): string {
    const candidate = resolve(
      this.rootDirectory,
      ...ref.path.split("/").filter((part) => part.length > 0),
    );
    const rootPrefix = this.rootDirectory.endsWith(sep)
      ? this.rootDirectory
      : `${this.rootDirectory}${sep}`;
    if (candidate !== this.rootDirectory && !candidate.startsWith(rootPrefix)) {
      throw new ArtifactStoreError(
        `Artifact path escapes run directory: ${ref.path}`,
      );
    }
    return candidate;
  }

  private async assertDirectory(
    directory: string,
    allowMissing = false,
  ): Promise<void> {
    try {
      const metadata = await this.filesystem.lstat(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new ArtifactStoreError(
          `Artifact directory is not a real directory: ${directory}`,
        );
      }
    } catch (error) {
      if (allowMissing && errorCode(error) === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  private async assertTargetDoesNotExist(targetPath: string): Promise<void> {
    try {
      await this.filesystem.lstat(targetPath);
      throw new ArtifactImmutableError(
        relative(this.rootDirectory, targetPath),
      );
    } catch (error) {
      if (error instanceof ArtifactImmutableError) {
        throw error;
      }
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
    }
  }

  private async publishAtomically(
    targetPath: string,
    content: Uint8Array,
  ): Promise<void> {
    const tempPath = join(
      dirname(targetPath),
      `.${targetPath.split(/[\\/]/).pop()}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle: ArtifactFileHandle | undefined;
    let cleanupError: unknown;
    try {
      handle = await this.filesystem.open(tempPath, "wx", 0o600);
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
        handle = undefined;
      }

      try {
        await this.filesystem.link(tempPath, targetPath);
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          throw new ArtifactImmutableError(
            relative(this.rootDirectory, targetPath),
          );
        }
        throw error;
      }
      await this.syncDirectory(dirname(targetPath));
    } finally {
      if (handle) {
        await handle.close().catch(() => undefined);
      }
      try {
        await removeTempFile(this.filesystem, tempPath);
      } catch (error) {
        cleanupError = error;
      }
    }
    if (cleanupError) {
      throw cleanupError;
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await this.filesystem.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
