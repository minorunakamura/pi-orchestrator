import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const KETCH_REPOSITORY = "https://github.com/minorunakamura/pi-ketch";
export const KETCH_REVISION = "e49fd9ea48b675eef2ede729c9f13f7e12d44c20";

/** Clean, pinned Git snapshot; neither operator settings nor third-party checkout is modified. */
export async function researchFixture(
  checkout: string,
  authFile: string,
  model: string,
) {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  assert.equal(
    git("remote", "get-url", "origin").replace(/\.git$/u, ""),
    KETCH_REPOSITORY,
  );
  assert.equal(git("rev-parse", "HEAD"), KETCH_REVISION);
  git("diff", "--exit-code", "HEAD", "--");
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "pi-orchestrator-research-")),
  );
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const source = join(root, "pi-ketch");
  await Promise.all([agentDir, cwd, source].map((path) => mkdir(path)));
  execFileSync("tar", ["-xf", "-", "-C", source], {
    input: execFileSync("git", ["-C", checkout, "archive", KETCH_REVISION], {
      maxBuffer: 10 * 1024 * 1024,
    }),
  });
  await symlink(resolve(authFile), join(agentDir, "auth.json"));
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      packages: [
        { source, extensions: [], skills: [], prompts: [] },
        {
          source: resolve(import.meta.dirname, "../.."),
          extensions: [],
          skills: [],
          prompts: [],
        },
      ],
      subagents: {
        defaultModel: model,
        defaultThinking: "medium",
        intercomBridge: { mode: "off" },
      },
    }),
  );
  await writeFile(
    join(cwd, "README.md"),
    "# Disposable Research smoke\nExternal facts are needed about the pi-ketch Git package. No implementation is requested.\n",
  );
  await writeFile(
    join(root, "source.json"),
    JSON.stringify({
      repository: KETCH_REPOSITORY,
      revision: KETCH_REVISION,
      source,
    }),
  );
  return { root, agentDir, cwd, source };
}
