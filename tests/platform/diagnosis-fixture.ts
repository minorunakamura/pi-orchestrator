import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Disposable product resources; does not edit operator settings or dependencies. */
export async function diagnosisFixture(authFile: string, model: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "pi-orchestrator-diagnosis-")),
  );
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await Promise.all([agentDir, cwd].map((path) => mkdir(path)));
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
      subagents: {
        defaultModel: model,
        defaultThinking: "medium",
        intercomBridge: { mode: "off" },
      },
    }),
  );
  await writeFile(
    join(cwd, "cache.ts"),
    "export function lookup(cache: Record<string, number>, key: string): number {\n  if (!cache[key]) throw new Error('missing');\n  return cache[key];\n}\n",
  );
  await writeFile(
    join(cwd, "failure.log"),
    "Recorded failing assertion: lookup({key:0}, 'key')\nExpected: 0\nObserved: Error('missing') at cache.ts:2\nThis log is supplied evidence, not an execution performed by Diagnosis.\n",
  );
  return { root, agentDir, cwd };
}
