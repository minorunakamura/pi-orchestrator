import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Disposable read-only workspace/settings; never modifies operator resources. */
export async function simplicityFixture(authFile: string, repository: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "pi-orchestrator-simplicity-")),
  );
  const agentDir = join(root, "agent"),
    cwd = join(root, "project");
  await Promise.all([agentDir, cwd].map((path) => mkdir(path)));
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
    "export function greet(name) { return `Hello, ${name}!`; }\n",
  );
  return { root, agentDir, cwd };
}
