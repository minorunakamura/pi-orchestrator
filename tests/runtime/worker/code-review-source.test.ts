import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { captureRepository } from "../../../src/runtime/worker/repository-evidence.ts";
import {
  gitReviewPatch,
  verifyCodeReviewSource,
} from "../../../src/runtime/worker/code-review-source.ts";
import { calculateSha256 } from "../../../src/runtime/persistence/artifact-store.ts";

const roots: string[] = [];
const exec = promisify(execFile);
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function repo() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "code-review-source-")),
  );
  roots.push(root);
  const cwd = join(root, "repo");
  const artifacts = join(cwd, ".pi", "orchestrator", "runs", "workflow");
  await mkdir(artifacts, { recursive: true });
  const git = (args: string[]) =>
    exec(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd },
    );
  await git(["init", "--quiet"]);
  return { root, cwd, artifacts, git };
}
test("exact Git patch includes staged/unstaged/add/delete and excludes runtime Artifacts", async () => {
  const f = await repo();
  await writeFile(join(f.cwd, "modified.txt"), "baseline\n");
  await writeFile(join(f.cwd, "deleted.txt"), "remove me\n");
  await f.git(["add", "modified.txt", "deleted.txt"]);
  await f.git(["commit", "--quiet", "-m", "baseline"]);
  await writeFile(join(f.cwd, "modified.txt"), "staged\n");
  await f.git(["add", "modified.txt"]);
  await writeFile(join(f.cwd, "modified.txt"), "final\n");
  await rm(join(f.cwd, "deleted.txt"));
  await writeFile(join(f.cwd, "new.txt"), "added\n");
  await writeFile(join(f.artifacts, "state.json"), "private runtime evidence");
  const snapshot = await captureRepository(f.cwd, f.artifacts);
  const patch = await gitReviewPatch(snapshot, f.artifacts);
  expect(patch).toContain("-baseline");
  expect(patch).toContain("+final");
  expect(patch).toContain("deleted file mode");
  expect(patch).toContain("new file mode");
  expect(patch).toContain("+added");
  expect(patch).not.toContain("private runtime evidence");
  expect(patch).not.toContain("+staged");
  const patchFile = join(f.artifacts, "patch.diff");
  await writeFile(patchFile, patch);
  const source = {
    type: "git-patch" as const,
    cwd: snapshot.cwd,
    patchFile,
    patchSha256: calculateSha256(patch),
    workspaceDigest: calculateSha256(JSON.stringify(snapshot)),
  };
  await verifyCodeReviewSource(source, f.artifacts);
  await writeFile(join(f.cwd, "new.txt"), "unseen change");
  await expect(verifyCodeReviewSource(source, f.artifacts)).rejects.toThrow(
    /changed/iu,
  );
});
test("unborn Git includes tracked additions and untracked files without duplication", async () => {
  const f = await repo();
  await writeFile(join(f.cwd, "tracked.txt"), "first\n");
  await f.git(["add", "tracked.txt"]);
  await writeFile(join(f.cwd, "new.txt"), "second\n");
  const snapshot = await captureRepository(f.cwd, f.artifacts);
  expect(snapshot.head).toBeNull();
  const patch = await gitReviewPatch(snapshot, f.artifacts);
  expect(patch.match(/^diff --git/gmu)).toHaveLength(2);
  expect(patch).toContain("+first");
  expect(patch).toContain("+second");
});
test.each(["binary", "symlink", "oversized"])(
  "unsupported %s cannot silently disappear from Human review",
  async (kind) => {
    const f = await repo();
    if (kind === "binary")
      await writeFile(join(f.cwd, "data"), Buffer.from([0, 1, 2]));
    else if (kind === "symlink") await symlink("outside", join(f.cwd, "data"));
    else await writeFile(join(f.cwd, "data"), "x".repeat(1024 * 1024 + 1));
    await expect(
      gitReviewPatch(await captureRepository(f.cwd, f.artifacts), f.artifacts),
    ).rejects.toThrow();
  },
);
test("canonical exclusions remain valid when the caller workspace path is a symlink", async () => {
  const f = await repo();
  const alias = join(f.root, "alias");
  await symlink(f.cwd, alias);
  const first = await captureRepository(
    alias,
    join(alias, ".pi", "orchestrator", "runs", "workflow"),
  );
  await writeFile(join(f.artifacts, "new-artifact.json"), "durable intent");
  const after = await captureRepository(
    alias,
    join(alias, ".pi", "orchestrator", "runs", "workflow"),
  );
  expect(after).toEqual(first);
  expect(
    await gitReviewPatch(
      after,
      join(alias, ".pi", "orchestrator", "runs", "workflow"),
    ),
  ).toBe("");
  expect(await readFile(join(f.artifacts, "new-artifact.json"), "utf8")).toBe(
    "durable intent",
  );
});
