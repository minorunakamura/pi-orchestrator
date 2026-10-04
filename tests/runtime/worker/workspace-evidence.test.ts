import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
const drift = vi.hoisted(() => ({ path: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (path: string) => {
      const result = await actual.lstat(path);
      if (path === drift.path) {
        drift.path = "";
        await actual.writeFile(
          join(path, "unstable.txt"),
          "intervening mutation",
        );
        await actual.utimes(path, new Date(), new Date(Date.now() + 10_000));
      }
      return result;
    },
  };
});
import {
  captureWorkspace,
  filesystemReviewPatch,
  isFilesystemSnapshot,
  FILESYSTEM_LIMITS,
} from "../../../src/runtime/worker/workspace-evidence.ts";
import { calculateSha256 } from "../../../src/runtime/persistence/artifact-store.ts";
import { parseWorkerAttempt } from "../../../src/runtime/worker/attempt-evidence.ts";

const roots: string[] = [];
const exec = promisify(execFile);
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "filesystem-evidence-")),
  );
  roots.push(root);
  const cwd = join(root, "work"),
    artifacts = join(cwd, ".pi/orchestrator/runs/test");
  await mkdir(artifacts, { recursive: true });
  const capture = async () => {
    const value = await captureWorkspace(cwd, artifacts);
    if (value.kind !== "filesystem") throw Error("Expected non-Git workspace");
    expect(isFilesystemSnapshot(value)).toBe(true);
    return value;
  };
  return { root, cwd, artifacts, capture };
}

test("deterministic manifest retains baseline bytes; unified patch applies exact create/modify/delete and modes", async () => {
  const f = await fixture();
  await writeFile(join(f.cwd, 'space 名 "quote".txt'), "first\r\nlast");
  await writeFile(join(f.cwd, "delete.txt"), "deleted\n");
  await writeFile(join(f.cwd, "mode.txt"), "same\n");
  const before = await f.capture();
  expect(before.digest).toBe(calculateSha256(JSON.stringify(before.entries)));
  expect(await f.capture()).toEqual(before);
  await writeFile(
    join(f.cwd, 'space 名 "quote".txt'),
    "modified\r\nwithout newline",
  );
  await rm(join(f.cwd, "delete.txt"));
  await writeFile(join(f.cwd, "added.txt"), "new\n");
  await writeFile(join(f.cwd, "empty.txt"), "");
  await chmod(join(f.cwd, "mode.txt"), 0o755);
  const after = await f.capture();
  const patch = filesystemReviewPatch(before, after);
  expect(patch).toContain("-deleted");
  expect(patch).toContain("+modified");
  expect(patch).toContain("+new");
  expect(patch).toContain("\\ No newline at end of file");
  expect(patch).toContain("old mode 100644\nnew mode 100755");
  expect(filesystemReviewPatch(before, after)).toBe(patch);
  const replay = join(f.root, "replay");
  await mkdir(replay);
  for (const entry of before.entries) {
    if (entry.kind === "directory") {
      // Reconstruct the retained baseline, not current files.
      // oxlint-disable-next-line eslint/no-await-in-loop
      await mkdir(join(replay, entry.path), { recursive: true });
    } else {
      // oxlint-disable-next-line eslint/no-await-in-loop
      await writeFile(join(replay, entry.path), entry.content, {
        mode: entry.mode,
      });
    }
  }
  const patchFile = join(f.root, "patch.diff");
  await writeFile(patchFile, patch);
  // Test parser/application compatibility; production filesystem provider never calls Git.
  await exec("git", ["apply", "--no-index", patchFile], { cwd: replay });
  for (const entry of after.entries.filter(
    (candidate) => candidate.kind === "file",
  )) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    expect(await readFile(join(replay, entry.path), "utf8")).toBe(
      entry.content,
    );
  }
  await expect(readFile(join(replay, "delete.txt"))).rejects.toThrow();
  expect(after.digest).not.toBe(before.digest);
});

test("non-Git capture and patch generation need no Git executable", async () => {
  const f = await fixture();
  vi.stubEnv("PATH", "");
  try {
    const before = await f.capture();
    await writeFile(join(f.cwd, "added.txt"), "without Git\n");
    const after = await f.capture();
    expect(filesystemReviewPatch(before, after)).toContain("+without Git");
  } finally {
    vi.unstubAllEnvs();
  }
});

test("canonical root/exclusions ignore only persisted Artifact scope, not gitignore or dependencies", async () => {
  const f = await fixture();
  await writeFile(join(f.cwd, ".gitignore"), "hidden.txt\n");
  await writeFile(join(f.cwd, "hidden.txt"), "included");
  await mkdir(join(f.cwd, "node_modules"));
  await writeFile(join(f.cwd, "node_modules/file.txt"), "included dependency");
  const before = await f.capture();
  await writeFile(join(f.artifacts, "private.json"), "private");
  await symlink("/outside", join(f.artifacts, "ignored-link"));
  expect(await f.capture()).toEqual(before);
  const alias = join(f.root, "alias");
  await symlink(f.cwd, alias);
  expect(
    await captureWorkspace(alias, join(alias, ".pi/orchestrator/runs/test")),
  ).toEqual(before);
  expect(before.entries.some((entry) => entry.path === "hidden.txt")).toBe(
    true,
  );
  expect(
    before.entries.some((entry) => entry.path === "node_modules/file.txt"),
  ).toBe(true);
  await writeFile(join(f.cwd, "hidden.txt"), "out-of-band");
  expect((await f.capture()).digest).not.toBe(before.digest);
});

test.each([
  "symlink-file",
  "symlink-directory",
  "dangling-link",
  "hardlink",
  "fifo",
  "binary",
  "invalid-utf8",
  "large",
  "mode",
])("rejects unsupported %s rather than omitting evidence", async (kind) => {
  const f = await fixture();
  const path = join(f.cwd, "unsupported");
  if (kind.startsWith("symlink") || kind === "dangling-link")
    await symlink(kind === "dangling-link" ? "missing" : f.root, path);
  else if (kind === "hardlink") {
    await writeFile(join(f.root, "outside"), "data");
    await link(join(f.root, "outside"), path);
  } else if (kind === "fifo") await exec("mkfifo", [path]);
  else if (kind === "binary") await writeFile(path, Buffer.from([0, 1, 2]));
  else if (kind === "invalid-utf8") await writeFile(path, Buffer.from([0xff]));
  else if (kind === "large")
    await writeFile(path, "x".repeat(FILESYSTEM_LIMITS.maxFileBytes + 1));
  else {
    await writeFile(path, "restricted");
    await chmod(path, 0o600);
  }
  await expect(f.capture()).rejects.toThrow(/unsupported|limit/iu);
});

test("aggregate bound, metadata-only identity and unreviewable directory changes fail closed", async () => {
  const f = await fixture();
  const before = await f.capture();
  await mkdir(join(f.cwd, "empty"));
  const after = await f.capture();
  expect(after.digest).not.toBe(before.digest);
  expect(() => filesystemReviewPatch(before, after)).toThrow(
    /Empty-directory/iu,
  );
  await rm(join(f.cwd, "empty"), { recursive: true });
  for (let i = 0; i < 33; i++) {
    // Bounded aggregate fixture.
    // oxlint-disable-next-line eslint/no-await-in-loop
    await writeFile(
      join(f.cwd, `${i}.txt`),
      "x".repeat(FILESYSTEM_LIMITS.maxFileBytes),
    );
  }
  await expect(f.capture()).rejects.toThrow(/content limit/iu);
});

test("unstable observation never becomes a usable mutation baseline", async () => {
  const f = await fixture();
  drift.path = f.cwd;
  await expect(f.capture()).rejects.toThrow(/changed during observation/iu);
  expect(await readFile(join(f.cwd, "unstable.txt"), "utf8")).toBe(
    "intervening mutation",
  );
});

test("provider and exclusion policy cannot silently switch on resume", async () => {
  const f = await fixture();
  const baseline = await f.capture();
  const otherArtifacts = join(f.cwd, "other-artifacts");
  await mkdir(otherArtifacts);
  await expect(
    captureWorkspace(f.cwd, otherArtifacts, baseline),
  ).rejects.toThrow(/policy identity/iu);
  await rm(otherArtifacts, { recursive: true });
  await exec("git", ["init", "--quiet", f.cwd]);
  await expect(captureWorkspace(f.cwd, f.artifacts, baseline)).rejects.toThrow(
    /provider changed/iu,
  );
  const git = await captureWorkspace(f.cwd, f.artifacts);
  expect(git.kind).toBe("git");
  await rm(join(f.cwd, ".git"), { recursive: true });
  await expect(captureWorkspace(f.cwd, f.artifacts, git)).rejects.toThrow(
    /provider changed/iu,
  );
});

test("schema rejects content/hash/policy/path tampering and legacy missing provider", async () => {
  const f = await fixture();
  await writeFile(join(f.cwd, "source.txt"), "data\n");
  const snapshot = await f.capture();
  for (const damage of ["hash", "content", "path", "policy"] as const) {
    const value = structuredClone(snapshot);
    const entry = value.entries.find((e) => e.kind === "file")!;
    if (entry.kind !== "file") throw Error("missing file");
    if (damage === "hash") entry.sha256 = "a".repeat(64);
    if (damage === "content") entry.content = "different";
    if (damage === "path") entry.path = "../escape";
    if (damage === "policy") Object.assign(value.policy, { version: 2 });
    value.digest = calculateSha256(JSON.stringify(value.entries));
    expect(isFilesystemSnapshot(value)).toBe(false);
  }
  expect(() =>
    parseWorkerAttempt({ before: { cwd: f.cwd, root: f.cwd } }),
  ).toThrow();
});
