import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Disposable workspace/settings only. Upstream skills and operator auth stay untouched. */
export async function tddFixture(
  authFile: string,
  skillsCheckout: string,
  repository: string,
) {
  const exec = promisify(execFile);
  const skillRevision = (
    await exec("git", ["rev-parse", "HEAD"], { cwd: skillsCheckout })
  ).stdout.trim();
  await exec(
    "git",
    [
      "diff",
      "--exit-code",
      "HEAD",
      "--",
      "skills/engineering/tdd",
      "skills/engineering/codebase-design",
    ],
    { cwd: skillsCheckout },
  );
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "pi-orchestrator-tdd-")),
  );
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await Promise.all([agentDir, cwd].map((path) => mkdir(path)));
  await exec("git", ["init", "--quiet", cwd]);
  await symlink(resolve(authFile), join(agentDir, "auth.json"));
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "openai",
      defaultModel: "gpt-6.1-sol",
      defaultProjectTrust: "never",
      packages: [
        {
          source: resolve(repository),
          extensions: [],
          skills: [],
          prompts: [],
        },
      ],
      skills: ["tdd", "codebase-design"].map((name) =>
        join(skillsCheckout, "skills/engineering", name),
      ),
      subagents: {
        defaultModel: "openai/gpt-6.1-sol",
        defaultThinking: "medium",
        intercomBridge: { mode: "off" },
      },
    }),
  );
  await writeFile(
    join(agentDir, "plannotator.json"),
    JSON.stringify({ executionMode: "external" }),
  );
  await writeFile(
    join(cwd, "greeting.mjs"),
    'export function greet(name) { throw new Error("not implemented"); }\n',
  );
  assert(cwd.startsWith(root));
  return { root, cwd, agentDir, skillRevision };
}
