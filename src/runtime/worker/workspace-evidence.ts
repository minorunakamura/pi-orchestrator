import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { hasOnlyKeys, isRecord, isNonEmptyString } from "../../core/schema.ts";
import { calculateSha256 } from "../persistence/artifact-store.ts";
import {
  captureRepository,
  gitReviewPatch,
  type RepositorySnapshot,
} from "./repository-evidence.ts";

export const FILESYSTEM_LIMITS = {
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxEntries: 10_000,
  maxDepth: 64,
  timeoutMs: 15_000,
} as const;
export interface FilesystemSnapshot {
  kind: "filesystem";
  cwd: string;
  root: string;
  policy: {
    version: 1;
    exclusions: string[];
    limits: typeof FILESYSTEM_LIMITS;
  };
  entries: (
    | { path: string; kind: "directory"; mode: number }
    | {
        path: string;
        kind: "file";
        mode: number;
        content: string;
        sha256: string;
      }
  )[];
  digest: string;
}
export type WorkspaceSnapshot = RepositorySnapshot | FilesystemSnapshot;
export interface WorkspaceEvidenceProvider<S extends WorkspaceSnapshot> {
  kind: S["kind"];
  capture(cwd: string, excludedDirectory?: string): Promise<S>;
  reviewPatch(before: S, after: S, excludedDirectory: string): Promise<string>;
}
export const GitWorkspaceEvidenceProvider: WorkspaceEvidenceProvider<RepositorySnapshot> =
  {
    kind: "git",
    capture: captureRepository,
    reviewPatch: (_before, after, excluded) => gitReviewPatch(after, excluded),
  };
export const FilesystemWorkspaceEvidenceProvider: WorkspaceEvidenceProvider<FilesystemSnapshot> =
  {
    kind: "filesystem",
    capture: captureFilesystem,
    reviewPatch: async (before, after) => filesystemReviewPatch(before, after),
  };

const safePath = (path: unknown): path is string =>
  typeof path === "string" &&
  path.length > 0 &&
  !path.includes("\\") &&
  // Explicit unsupported control bytes at the path trust boundary.
  // oxlint-disable-next-line eslint/no-control-regex
  !/[\x00-\x1f\x7f]/u.test(path) &&
  !posix.isAbsolute(path) &&
  posix.normalize(path) === path &&
  path !== ".." &&
  !path.startsWith("../") &&
  path !== ".";
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
const excluded = (path: string, exclusions: string[]) =>
  exclusions.some((entry) => path === entry || path.startsWith(`${entry}/`));
const text = (bytes: Buffer): string => {
  const content = bytes.toString("utf8");
  if (
    !Buffer.from(content).equals(bytes) ||
    // Binary/control-byte policy is intentional, not a printable-text heuristic.
    // oxlint-disable-next-line eslint/no-control-regex
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(content)
  )
    throw Error("Unsupported binary workspace file (UTF-8 text required)");
  return content;
};

export function isFilesystemSnapshot(
  value: unknown,
): value is FilesystemSnapshot {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "kind",
      "cwd",
      "root",
      "policy",
      "entries",
      "digest",
    ]) ||
    value.kind !== "filesystem" ||
    !isNonEmptyString(value.cwd) ||
    value.cwd !== value.root ||
    !isRecord(value.policy) ||
    !hasOnlyKeys(value.policy, ["version", "exclusions", "limits"]) ||
    value.policy.version !== 1 ||
    !isDeepStrictEqual(value.policy.limits, FILESYSTEM_LIMITS) ||
    !Array.isArray(value.policy.exclusions) ||
    !value.policy.exclusions.every(safePath) ||
    !isDeepStrictEqual(
      value.policy.exclusions,
      [...new Set(value.policy.exclusions)].toSorted(),
    ) ||
    !Array.isArray(value.entries) ||
    value.entries.length > FILESYSTEM_LIMITS.maxEntries ||
    !hash(value.digest)
  )
    return false;
  let previous = "",
    total = 0;
  const directories = new Set<string>();
  for (const entry of value.entries) {
    if (
      !isRecord(entry) ||
      !safePath(entry.path) ||
      entry.path <= previous ||
      entry.path.split("/").length > FILESYSTEM_LIMITS.maxDepth ||
      excluded(entry.path, value.policy.exclusions) ||
      !Number.isSafeInteger(entry.mode) ||
      typeof entry.mode !== "number" ||
      entry.mode < 0 ||
      entry.mode > 0o777
    )
      return false;
    const parent = posix.dirname(entry.path);
    if (parent !== "." && !directories.has(parent)) return false;
    previous = entry.path;
    if (entry.kind === "directory") {
      if (!hasOnlyKeys(entry, ["path", "kind", "mode"])) return false;
      directories.add(entry.path);
    } else if (entry.kind === "file") {
      if (
        !hasOnlyKeys(entry, ["path", "kind", "mode", "content", "sha256"]) ||
        typeof entry.content !== "string" ||
        !hash(entry.sha256) ||
        ![0o644, 0o755].includes(entry.mode) ||
        calculateSha256(entry.content) !== entry.sha256
      )
        return false;
      const bytes = Buffer.from(entry.content);
      try {
        if (text(bytes) !== entry.content) return false;
      } catch {
        return false;
      }
      total += bytes.length;
      if (
        bytes.length > FILESYSTEM_LIMITS.maxFileBytes ||
        total > FILESYSTEM_LIMITS.maxTotalBytes
      )
        return false;
    } else return false;
  }
  return value.digest === calculateSha256(JSON.stringify(value.entries));
}

/** Detection never treats a broken Git marker or unavailable Git as a filesystem fallback. */
async function detectProvider(cwd: string): Promise<WorkspaceSnapshot["kind"]> {
  let directory = cwd;
  while (true) {
    try {
      // Provider detection must walk ancestors in order without invoking Git for non-Git.
      // oxlint-disable-next-line eslint/no-await-in-loop
      await lstat(join(directory, ".git"));
      return "git";
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) return "filesystem";
    directory = parent;
  }
}
export function assertWorkspaceIdentity(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): void {
  if (
    before.kind !== after.kind ||
    before.cwd !== after.cwd ||
    before.root !== after.root ||
    !isDeepStrictEqual(before.policy, after.policy)
  )
    throw Error("Workspace provider/root/policy identity changed");
}
/** Exclude only the exact proposed documents, never their containing workload. */
export function unchangedDocumentScope(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  paths: string[],
): boolean {
  if (before.kind !== "filesystem" || after.kind !== "filesystem")
    return isDeepStrictEqual(before, after);
  const old = new Set(before.entries.map((entry) => entry.path));
  const entries = after.entries.filter(
    (entry) =>
      !(
        entry.kind === "directory" &&
        !old.has(entry.path) &&
        paths.some((path) => path.startsWith(`${entry.path}/`))
      ),
  );
  return isDeepStrictEqual(before, {
    ...after,
    entries,
    digest: calculateSha256(JSON.stringify(entries)),
  });
}

export async function captureWorkspace(
  cwd: string,
  excludedDirectory?: string,
  expected?: WorkspaceSnapshot,
  excludedPaths: string[] = [],
): Promise<WorkspaceSnapshot> {
  if (!excludedPaths.every(safePath))
    throw Error("Invalid workspace exclusions");
  const canonical = await realpath(cwd);
  const kind = await detectProvider(canonical);
  if (expected && kind !== expected.kind)
    throw Error("Workspace evidence provider changed");
  const snapshot =
    kind === "git"
      ? await captureRepository(canonical, excludedDirectory, excludedPaths)
      : await captureFilesystem(canonical, excludedDirectory, excludedPaths);
  if (expected) assertWorkspaceIdentity(expected, snapshot);
  return snapshot;
}
async function captureFilesystem(
  cwd: string,
  excludedDirectory?: string,
  excludedPaths: string[] = [],
): Promise<FilesystemSnapshot> {
  const root = await realpath(cwd);
  const artifactPath = excludedDirectory
    ? relative(root, await realpath(excludedDirectory))
        .split("\\")
        .join("/")
    : undefined;
  if (artifactPath === "")
    throw Error("Artifact directory cannot equal workspace root");
  const exclusions = [
    ...new Set([
      ".pi/orchestrator",
      ...excludedPaths,
      ...(artifactPath &&
      !artifactPath.startsWith("../") &&
      artifactPath !== ".." &&
      !isAbsolute(artifactPath)
        ? [artifactPath]
        : []),
    ]),
  ].toSorted();
  const deadline = Date.now() + FILESYSTEM_LIMITS.timeoutMs;
  const observe = async (): Promise<FilesystemSnapshot> => {
    const entries: FilesystemSnapshot["entries"] = [];
    let total = 0;
    const visit = async (path: string, depth: number): Promise<void> => {
      if (Date.now() > deadline || depth > FILESYSTEM_LIMITS.maxDepth)
        throw Error("Workspace observation limit exceeded");
      const absolute = join(root, path);
      const before = await lstat(absolute);
      if (
        !before.isDirectory() ||
        before.isSymbolicLink() ||
        (await realpath(absolute)) !== absolute
      )
        throw Error("Unsupported workspace directory/link");
      const names = (await readdir(absolute)).toSorted();
      if (names.length + entries.length > FILESYSTEM_LIMITS.maxEntries)
        throw Error("Workspace entry limit exceeded");
      for (const name of names) {
        const child = path ? `${path}/${name}` : name;
        if (!safePath(child)) throw Error("Unsupported workspace path");
        if (excluded(child, exclusions)) continue;
        if (depth + 1 > FILESYSTEM_LIMITS.maxDepth)
          throw Error("Workspace depth limit exceeded");
        if (
          entries.length >= FILESYSTEM_LIMITS.maxEntries ||
          Date.now() > deadline
        )
          throw Error("Workspace observation limit exceeded");
        // Sequential reads bound open descriptors and keep observation order deterministic.
        // oxlint-disable-next-line eslint/no-await-in-loop
        const metadata = await lstat(join(root, child));
        const mode = metadata.mode & 0o777;
        if (metadata.mode & 0o7000)
          throw Error("Unsupported workspace special permission bits");
        if (metadata.isSymbolicLink())
          throw Error("Unsupported workspace symlink (not followed)");
        if (metadata.isDirectory()) {
          entries.push({ path: child, kind: "directory", mode });
          // oxlint-disable-next-line eslint/no-await-in-loop
          await visit(child, depth + 1);
        } else {
          if (
            !metadata.isFile() ||
            metadata.nlink !== 1 ||
            ![0o644, 0o755].includes(mode)
          )
            throw Error("Unsupported workspace entry/link/mode");
          if (
            metadata.size > FILESYSTEM_LIMITS.maxFileBytes ||
            total + metadata.size > FILESYSTEM_LIMITS.maxTotalBytes
          )
            throw Error("Workspace content limit exceeded");
          // oxlint-disable-next-line eslint/no-await-in-loop
          const file = await open(
            join(root, child),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          let bytes: Buffer;
          try {
            // oxlint-disable-next-line eslint/no-await-in-loop
            const opened = await file.stat();
            if (
              !opened.isFile() ||
              opened.dev !== metadata.dev ||
              opened.ino !== metadata.ino ||
              opened.nlink !== 1
            )
              throw Error("Workspace file identity changed");
            bytes = Buffer.alloc(FILESYSTEM_LIMITS.maxFileBytes + 1);
            // oxlint-disable-next-line eslint/no-await-in-loop
            const result = await file.read(bytes, 0, bytes.length, 0);
            bytes = bytes.subarray(0, result.bytesRead);
            // oxlint-disable-next-line eslint/no-await-in-loop
            const after = await file.stat();
            if (
              bytes.length !== metadata.size ||
              after.size !== metadata.size ||
              after.mtimeMs !== metadata.mtimeMs ||
              after.ctimeMs !== metadata.ctimeMs
            )
              throw Error("Workspace file changed during observation");
          } finally {
            // oxlint-disable-next-line eslint/no-await-in-loop
            await file.close();
          }
          total += bytes.length;
          if (
            bytes.length > FILESYSTEM_LIMITS.maxFileBytes ||
            total > FILESYSTEM_LIMITS.maxTotalBytes
          )
            throw Error("Workspace content limit exceeded");
          entries.push({
            path: child,
            kind: "file",
            mode,
            content: text(bytes),
            sha256: calculateSha256(bytes),
          });
        }
      }
      const after = await lstat(absolute);
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.mode !== before.mode ||
        after.mtimeMs !== before.mtimeMs
      )
        throw Error("Workspace directory changed during observation");
    };
    await visit("", 0);
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {
      kind: "filesystem",
      cwd: root,
      root,
      policy: { version: 1, exclusions, limits: FILESYSTEM_LIMITS },
      entries,
      digest: calculateSha256(JSON.stringify(entries)),
    };
  };
  const first = await observe(),
    second = await observe();
  if (!isDeepStrictEqual(first, second))
    throw Error("Workspace changed during observation");
  return second;
}

const lines = (content: string) =>
  content === ""
    ? []
    : content.endsWith("\n")
      ? content.slice(0, -1).split("\n")
      : content.split("\n");

// ponytail: full-file hunks, capped at 1 MiB; add contextual diff only if legitimate text changes hit the cap.
/** Retain exact deleted baseline bytes without an unbounded LCS algorithm. */
export function filesystemReviewPatch(
  before: FilesystemSnapshot,
  after: FilesystemSnapshot,
): string {
  if (!isFilesystemSnapshot(before) || !isFilesystemSnapshot(after))
    throw Error("Invalid filesystem baseline");
  assertWorkspaceIdentity(before, after);
  const old = new Map(before.entries.map((entry) => [entry.path, entry]));
  const current = new Map(after.entries.map((entry) => [entry.path, entry]));
  let patch = "";
  for (const path of [
    ...new Set([...old.keys(), ...current.keys()]),
  ].toSorted()) {
    const a = old.get(path),
      b = current.get(path);
    if (isDeepStrictEqual(a, b)) continue;
    if (a?.kind === "directory" || b?.kind === "directory") {
      if (a && b && (a.kind !== b.kind || a.mode !== b.mode))
        throw Error("Unsupported directory type/mode change");
      const tree = a ? before.entries : after.entries;
      if (
        !tree.some(
          (entry) => entry.kind === "file" && entry.path.startsWith(`${path}/`),
        )
      )
        throw Error(
          "Empty-directory-only change cannot be represented by a unified patch",
        );
      continue;
    }
    const left = JSON.stringify(`a/${path}`),
      right = JSON.stringify(`b/${path}`);
    patch += `diff --git ${left} ${right}\n`;
    if (!a) patch += `new file mode 100${b!.mode.toString(8)}\n`;
    else if (!b) patch += `deleted file mode 100${a.mode.toString(8)}\n`;
    else if (a.mode !== b.mode)
      patch += `old mode 100${a.mode.toString(8)}\nnew mode 100${b.mode.toString(8)}\n`;
    if ((a?.content ?? "") !== (b?.content ?? "")) {
      const oldLines = lines(a?.content ?? ""),
        newLines = lines(b?.content ?? "");
      patch += `--- ${a ? left : "/dev/null"}\n+++ ${b ? right : "/dev/null"}\n`;
      patch += `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@\n`;
      for (const [prefix, content, list] of [
        ["-", a?.content ?? "", oldLines],
        ["+", b?.content ?? "", newLines],
      ] as const) {
        patch += list.map((line) => `${prefix}${line}\n`).join("");
        if (list.length && !content.endsWith("\n"))
          patch += "\\ No newline at end of file\n";
      }
    }
    if (Buffer.byteLength(patch) > 1024 * 1024)
      throw Error("Oversized Code Review patch");
  }
  if (Buffer.byteLength(patch) > 1024 * 1024)
    throw Error("Oversized Code Review patch");
  return patch;
}
export async function workspaceReviewPatch(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  excludedDirectory: string,
): Promise<string> {
  assertWorkspaceIdentity(before, after);
  if (before.kind === "git" && after.kind === "git")
    return GitWorkspaceEvidenceProvider.reviewPatch(
      before,
      after,
      excludedDirectory,
    );
  if (before.kind === "filesystem" && after.kind === "filesystem")
    return FilesystemWorkspaceEvidenceProvider.reviewPatch(
      before,
      after,
      excludedDirectory,
    );
  throw Error("Workspace provider changed");
}
