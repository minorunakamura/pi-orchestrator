import { readFile, rm, writeFile, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { clarificationFixture } from "./clarification-fixture.ts";
import { jevEvidenceCategories } from "../../src/core/configuration.ts";

/** Only disposable settings/workspaces; no production-port replacements or credential copies. */
export async function productionFixture(
  authFile: string,
  questionCheckout: string,
  skillsDirectory: string,
  nonGit = false,
) {
  const fixture = await clarificationFixture(
    authFile,
    "openai/gpt-6.1-sol",
    questionCheckout,
    skillsDirectory,
  );
  const repository = resolve(import.meta.dirname, "../..");
  const skills = ["grilling", "domain-modeling", "tdd"].map((name) =>
    join(skillsDirectory, name),
  );
  await Promise.all(skills.map((path) => access(join(path, "SKILL.md"))));
  await rm(join(fixture.cwd, "source.ts"));
  await writeFile(
    join(fixture.cwd, "greeting.mjs"),
    'export function greet(name) { throw new Error("not implemented"); }\n',
  );
  if (!nonGit)
    await promisify(execFile)("git", ["init", "--quiet", fixture.cwd]);
  const settings = JSON.parse(
    await readFile(join(fixture.agentDir, "settings.json"), "utf8"),
  );
  Object.assign(settings, {
    defaultProvider: "openai",
    defaultModel: "gpt-6.1-sol",
    defaultThinkingLevel: "medium",
    defaultProjectTrust: "never",
    skills,
    retry: { enabled: false, provider: { maxRetries: 0 } },
    packages: [{ source: repository, skills: [], prompts: [] }],
    piOrchestrator: {
      decision: { autoDecisionThreshold: 0.8, escalationThreshold: 0.8 },
      executionProfiles: Object.fromEntries(
        ["ECONOMY", "STANDARD", "STRONG"].map((tier) => [
          tier,
          { provider: "openai", model: "gpt-6.1-sol" },
        ]),
      ),
      reasoningMapping: { LOW: "low", MEDIUM: "medium", HIGH: "high" },
      retries: { maxAutomatedFixRounds: 3, maxStrongerRetries: 1 },
      validation: { stopOnInfrastructureFailure: true },
      jev: {
        classifier: { provider: "typesafe", model: "jev-latest" },
        maxTransportRetries: 0,
        timeoutMs: 30000,
        runtimePolicy: {
          maxRequests: 40,
          grant: {
            id: "issue12-explicit-operator-smoke",
            policyVersion: "issue12-synthetic-only-v1",
            active: true,
            projectRoot: fixture.cwd,
            destination: "typesafe/jev-latest",
            evidenceCategories: jevEvidenceCategories,
          },
        },
      },
    },
  });
  await writeFile(
    join(fixture.agentDir, "settings.json"),
    JSON.stringify(settings, null, 2),
  );
  await writeFile(
    join(fixture.agentDir, "plannotator.json"),
    JSON.stringify({ executionMode: "external" }),
  );
  const task = nonGit
    ? "Implement greet(name) in greeting.mjs with TDD, two vertical slices and node --test greeting.test.mjs validation. This is a new tiny Greeting domain: the Human must choose whether the domain term is Greeting or Salutation and whether greet('Ada') returns 'Hello, Ada!' or 'Hi, Ada!'. Do not guess these decisions. Before planning, use GRILL_WITH_DOCS with grilling and domain-modeling to settle those choices and propose only root CONTEXT.md for exact Human-confirmed documentation. Preserve the public greet(name) API, no dependencies, classes, factories, CLI, or other source files. Empty string behavior is also a Human choice. No external research is needed."
    : "Implement greet(name) in greeting.mjs with TDD, two vertical slices and node --test greeting.test.mjs validation. The Human must choose whether greet('Ada') returns 'Hello, Ada!' or 'Hi, Ada!' and whether an empty name returns the same greeting with 'world' or throws. Use GRILL_ME with grilling and ask_user_question before planning; do not guess. No domain-document writes are wanted. Preserve the public greet(name) API, no dependencies, classes, factories, CLI, or other source files. No external research is needed.";
  return {
    ...fixture,
    nonGit,
    task,
    reportPath: join(fixture.root, "report.json"),
  };
}
