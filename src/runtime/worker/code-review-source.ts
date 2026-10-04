import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import type { CodeReviewSource } from "../../core/coding/code-review.ts";
import {
  captureRepository,
  type RepositorySnapshot,
} from "./repository-evidence.ts";
import { calculateSha256 } from "../persistence/artifact-store.ts";

const exec = promisify(execFile);
const MAX_PATCH_BYTES = 1024 * 1024;
async function git(cwd: string, args: string[], diff = false): Promise<string> {
  try {
    const { stdout } = await exec("git", ["--no-optional-locks", ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_PATCH_BYTES,
      timeout: 15_000,
    });
    return stdout;
  } catch (error) {
    // --no-index returns 1 for an ordinary added-file diff.
    if (
      diff &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === 1 &&
      "stdout" in error &&
      typeof error.stdout === "string"
    )
      return error.stdout;
    throw error;
  }
}
/** Pin the exact Git review as a static patch; live UI mode switches cannot widen it. */
export async function gitReviewPatch(
  snapshot: RepositorySnapshot,
  excludedDirectory: string,
): Promise<string> {
  const exclude = relative(snapshot.root, await realpath(excludedDirectory));
  if (!exclude) throw Error("Invalid Artifact root");
  const paths = [
    "--",
    ".",
    ":(exclude,literal).pi/orchestrator",
    ...(exclude && !exclude.startsWith("..") && !isAbsolute(exclude)
      ? [`:(exclude,literal)${exclude}`]
      : []),
  ];
  let patch = snapshot.head
    ? await git(snapshot.root, [
        "diff",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--no-color",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        snapshot.head,
        ...paths,
      ])
    : "";
  const added = snapshot.head
    ? []
    : (await git(snapshot.root, ["ls-files", "--cached", "-z", ...paths]))
        .split("\0")
        .filter(Boolean);
  for (const path of [
    ...new Set([...added, ...snapshot.untracked.map((entry) => entry.path)]),
  ].toSorted()) {
    // Sequential reads preserve a deterministic patch order.
    // oxlint-disable-next-line eslint/no-await-in-loop
    const metadata = await lstat(join(snapshot.root, path));
    if (!metadata.isFile()) throw Error("Unsupported Code Review file type");
    // oxlint-disable-next-line eslint/no-await-in-loop
    patch += await git(
      snapshot.root,
      [
        "diff",
        "--no-index",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--",
        "/dev/null",
        path,
      ],
      true,
    );
  }
  if (
    Buffer.byteLength(patch) > MAX_PATCH_BYTES ||
    /GIT binary patch|^.*(?:old|new|deleted file|new file) mode (?:120000|160000)/mu.test(
      patch,
    )
  )
    throw Error("Unsupported binary/link or oversized Code Review patch");
  return patch;
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
    captureRepository(source.cwd, excludedDirectory),
  ]);
  if (
    patch.length > MAX_PATCH_BYTES ||
    calculateSha256(patch) !== source.patchSha256 ||
    calculateSha256(JSON.stringify(snapshot)) !== source.workspaceDigest
  )
    throw Error("Code Review patch or workspace changed");
}
