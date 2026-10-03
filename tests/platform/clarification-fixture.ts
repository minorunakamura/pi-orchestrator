import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

export const QUESTION_SOURCE_REVISION =
  "0a6ad2c5fd7f79ceccb51bc791c10554789bdbd2";
const exec = promisify(execFile);
/** Operator-approved GitHub-only snapshot; no package patch, operator settings change, or credential copy. */
export async function clarificationFixture(
  authFile: string,
  model: string,
  checkout: string,
  skillsDirectory: string,
) {
  const origin = (
    await exec("git", ["remote", "get-url", "origin"], { cwd: checkout })
  ).stdout.trim();
  assert(
    /(?:github\.com[:/])minorunakamura\/pi-ask-user-question(?:\.git)?$/u.test(
      origin,
    ),
  );
  assert.equal(
    (await exec("git", ["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim(),
    QUESTION_SOURCE_REVISION,
  );
  await exec(
    "git",
    ["diff", "--exit-code", QUESTION_SOURCE_REVISION, "--", "."],
    { cwd: checkout },
  );
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "pi-orchestrator-clarification-")),
  );
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const questionPackage = join(root, "question-package");
  await Promise.all(
    [agentDir, cwd, questionPackage].map((path) => mkdir(path)),
  );
  const archive = await exec("git", ["archive", QUESTION_SOURCE_REVISION], {
    cwd: checkout,
    encoding: "buffer",
    maxBuffer: 10000000,
  });
  const archivePath = join(root, "question.tar");
  await writeFile(archivePath, archive.stdout);
  await exec("tar", ["-xf", archivePath, "-C", questionPackage]);
  await symlink(resolve(authFile), join(agentDir, "auth.json"));
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      packages: [
        {
          source: resolve(import.meta.dirname, "../.."),
          extensions: [],
          skills: [],
          prompts: [],
        },
      ],
      skills: [
        join(skillsDirectory, "grilling"),
        join(skillsDirectory, "domain-modeling"),
      ],
      subagents: {
        defaultModel: model,
        defaultThinking: "medium",
        intercomBridge: { mode: "off" },
      },
    }),
  );
  await writeFile(
    join(cwd, "source.ts"),
    "export const sourceMustNotChange = true;\n",
  );
  return {
    root,
    agentDir,
    cwd,
    questionPackage,
    questionRevision: QUESTION_SOURCE_REVISION,
  };
}
