import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configuration } from "../fakes/coding-scenario.ts";

/** Disposable product resources; does not edit operator settings or dependencies. */
export async function diagnosisFixture(authFile: string, model: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "pi-orchestrator-diagnosis-")),
  );
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await Promise.all([agentDir, cwd].map((path) => mkdir(path)));
  await symlink(resolve(authFile), join(agentDir, "auth.json"));
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1)
    throw Error("A concrete provider/model is required");
  const profile = {
    provider: model.slice(0, separator),
    model: model.slice(separator + 1),
  };
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
      // Stage defaults must work without subagent thinking and despite an unavailable ambient model.
      subagents: {
        defaultModel: "unavailable/ambient-model",
        intercomBridge: { mode: "off" },
      },
      piOrchestrator: {
        ...configuration,
        executionProfiles: {
          ECONOMY: profile,
          STANDARD: profile,
          STRONG: profile,
        },
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
