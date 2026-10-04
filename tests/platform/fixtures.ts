import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function file(path: string, content: string) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, content);
}
const skill = (name: string) =>
  `---\nname: ${name}\ndescription: Platform contract canary\n---\n${name}\n`;

/** Disposable resources only; never changes operator settings or dependencies. */
export async function platformFixture(toolActivation?: "dynamic" | "eager") {
  const root = await mkdtemp(join(tmpdir(), "pi-orchestrator-platform-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await file(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "platform-smoke",
      defaultModel: "probe",
      subagents: { intercomBridge: { mode: "off" } },
    }),
  );
  if (toolActivation)
    await file(
      join(agentDir, "extensions/subagent/config.json"),
      JSON.stringify({ toolActivation }),
    );
  await file(
    join(agentDir, "skills/ambient-skill/SKILL.md"),
    skill("ambient-skill"),
  );
  await file(
    join(agentDir, "extension-skills/extension-skill/SKILL.md"),
    skill("extension-skill"),
  );
  await file(
    join(agentDir, "private-skills/platform-selected/SKILL.md"),
    skill("platform-selected"),
  );
  const providerPath = resolve(import.meta.dirname, "probe-provider.ts");
  await Promise.all(
    [false, true].map((inherit) =>
      file(
        join(
          agentDir,
          `agents/platform-${inherit ? "inherited" : "isolated"}.md`,
        ),
        `---
name: platform-${inherit ? "inherited" : "isolated"}
description: Read-only platform contract probe
model: platform-smoke/probe
thinking: off
tools: read
extensions:
subagentOnlyExtensions: ${providerPath}
inheritSkills: ${inherit}
inheritProjectContext: false
skills: platform-selected
skillPath: ../private-skills
---
Return platform probe evidence only. Do not call tools.
`,
      ),
    ),
  );
  await file(
    join(cwd, ".pi/settings.json"),
    JSON.stringify({
      defaultModel: "PROJECT_SETTINGS_INJECTION",
      subagents: {
        agentOverrides: {
          "platform-isolated": {
            tools: ["write", "edit"],
            model: "PROJECT_SETTINGS_INJECTION",
          },
        },
      },
    }),
  );
  await file(join(cwd, ".pi/SYSTEM.md"), "PROJECT_SYSTEM_INJECTION");
  await file(join(cwd, ".pi/APPEND_SYSTEM.md"), "PROJECT_APPEND_INJECTION");
  await file(
    join(cwd, ".pi/skills/project-skill/SKILL.md"),
    skill("project-skill"),
  );
  await file(
    join(cwd, ".pi/prompts/project-prompt.md"),
    "PROJECT_PROMPT_INJECTION",
  );
  await file(
    join(cwd, ".pi/extensions/injection.ts"),
    `import { writeFileSync } from 'node:fs';\nexport default function () { writeFileSync(${JSON.stringify(join(root, "project-extension-loaded"))}, 'unsafe'); }\n`,
  );
  return { root, cwd, agentDir };
}
