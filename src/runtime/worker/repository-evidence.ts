import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { calculateSha256 } from "../persistence/artifact-store.ts";

const exec = promisify(execFile);
export interface RepositorySnapshot {
  kind: "git";
  policy: { version: 1; exclusions: string[] };
  cwd: string;
  root: string;
  head: string | null;
  indexDigest: string;
  worktreeDigest: string;
  untracked: {
    path: string;
    sha256: string;
    mode: number;
    kind: "file" | "symlink";
  }[];
}
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["--no-optional-locks", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 15_000,
  });
  return stdout;
}
async function observe(
  cwd: string,
  excludedDirectory?: string,
  excludedPaths: string[] = [],
): Promise<RepositorySnapshot> {
  const root = await realpath(
    (await git(cwd, ["rev-parse", "--show-toplevel"])).trim(),
  );
  let head: string | null;
  try {
    head = (
      await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"])
    ).trim();
  } catch (error) {
    if (
      error === null ||
      (typeof error !== "object" && typeof error !== "function") ||
      !("code" in error) ||
      error.code !== 1
    )
      throw error;
    await git(root, ["symbolic-ref", "HEAD"]);
    head = null;
  }
  const exclude = excludedDirectory
    ? relative(root, resolve(excludedDirectory))
    : undefined;
  const exclusions = [
    ".pi/orchestrator",
    ...excludedPaths,
    ...(exclude && !exclude.startsWith("..") && !isAbsolute(exclude)
      ? [exclude]
      : []),
  ];
  if (exclude === "")
    throw Error("Artifact directory cannot equal repository root");
  const paths = [
    "--",
    ".",
    ...exclusions.map((path) => `:(exclude,literal)${path}`),
  ];
  const entries = (
    await git(root, ["ls-files", "--stage", "-z", ...paths])
  ).split("\0");
  if (entries.some((entry) => entry.startsWith("160000 ")))
    throw Error("Submodule/gitlink repository evidence is unsupported");
  const flaggedEntries = (
    await git(root, ["ls-files", "-v", "-z", ...paths])
  ).split("\0");
  if (flaggedEntries.some((entry) => /^[a-zS] /u.test(entry)))
    throw Error(
      "assume-unchanged/skip-worktree repository evidence is unsupported",
    );
  const indexDigest = calculateSha256(
    await git(root, [
      "diff",
      "--cached",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      ...paths,
    ]),
  );
  const worktreeDigest = calculateSha256(
    await git(root, [
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      ...paths,
    ]),
  );
  const names = (
    await git(root, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      ...paths,
    ])
  )
    .split("\0")
    .filter(Boolean)
    .toSorted();
  const untracked: RepositorySnapshot["untracked"] = [];
  for (const path of names) {
    const absolute = resolve(root, path);
    if (relative(root, absolute).startsWith(".."))
      throw Error("Invalid repository path");
    // Observe untracked entries in stable path order for deterministic evidence.
    // oxlint-disable-next-line eslint/no-await-in-loop
    const metadata = await lstat(absolute);
    if (!metadata.isFile() && !metadata.isSymbolicLink())
      throw Error("Unsupported repository entry");
    const content = metadata.isSymbolicLink()
      ? // Symlink targets belong to the same sequential path observation.
        // oxlint-disable-next-line eslint/no-await-in-loop
        await readlink(absolute)
      : // Read regular files sequentially as well; don't reorder snapshot evidence.
        // oxlint-disable-next-line eslint/no-await-in-loop
        await readFile(absolute);
    untracked.push({
      path,
      sha256: calculateSha256(content),
      mode: metadata.mode,
      kind: metadata.isSymbolicLink() ? "symlink" : "file",
    });
  }
  return {
    kind: "git",
    policy: { version: 1, exclusions: [...new Set(exclusions)].toSorted() },
    cwd,
    root,
    head,
    indexDigest,
    worktreeDigest,
    untracked,
  };
}
/** Observable content identity, not a claim of an atomic filesystem snapshot. */
export async function captureRepository(
  cwd: string,
  excludedDirectory?: string,
  excludedPaths: string[] = [],
): Promise<RepositorySnapshot> {
  const canonical = await realpath(cwd);
  const excluded = excludedDirectory
    ? await realpath(excludedDirectory)
    : undefined;
  const before = await observe(canonical, excluded, excludedPaths);
  const after = await observe(canonical, excluded, excludedPaths);
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw Error("Repository changed during observation");
  return after;
}

/** Pin Git's exact review representation; never invoke external diff/textconv drivers. */
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
  const diff = async (args: string[], added = false) => {
    try {
      const { stdout } = await exec("git", ["--no-optional-locks", ...args], {
        cwd: snapshot.root,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 15_000,
      });
      return stdout;
    } catch (error) {
      if (
        added &&
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
  };
  const options = [
    "--binary",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--src-prefix=a/",
    "--dst-prefix=b/",
  ];
  let patch = snapshot.head
    ? await diff(["diff", ...options, "--no-renames", snapshot.head, ...paths])
    : "";
  const added = snapshot.head
    ? []
    : (await git(snapshot.root, ["ls-files", "--cached", "-z", ...paths]))
        .split("\0")
        .filter(Boolean);
  for (const path of [
    ...new Set([...added, ...snapshot.untracked.map((entry) => entry.path)]),
  ].toSorted()) {
    // Sequential reads preserve deterministic patch order.
    // oxlint-disable-next-line eslint/no-await-in-loop
    const metadata = await lstat(join(snapshot.root, path));
    if (!metadata.isFile()) throw Error("Unsupported Code Review file type");
    // oxlint-disable-next-line eslint/no-await-in-loop
    patch += await diff(
      ["diff", "--no-index", ...options, "--", "/dev/null", path],
      true,
    );
  }
  if (
    Buffer.byteLength(patch) > 1024 * 1024 ||
    /GIT binary patch|^.*(?:old|new|deleted file|new file) mode (?:120000|160000)/mu.test(
      patch,
    )
  )
    throw Error("Unsupported binary/link or oversized Code Review patch");
  return patch;
}
