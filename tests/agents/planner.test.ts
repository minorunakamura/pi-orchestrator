import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const definitionPath = resolve("agents/planner.md");

test("defines planner as a read-only plan author without implementation authority", async () => {
  const definition = await readFile(definitionPath, "utf8");
  const frontmatter = definition.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? "";
  const prompt = definition.replace(/^---\n[\s\S]*?\n---\n/u, "");

  expect(frontmatter).toMatch(/(^|\n)name:\s*planner\s*(\n|$)/u);
  expect(frontmatter).toMatch(
    /(^|\n)tools:\s*read,\s*grep,\s*find,\s*ls\s*(\n|$)/u,
  );
  expect(frontmatter).not.toMatch(/(^|\n)tools:.*\b(edit|write|bash)\b/u);
  expect(prompt).toMatch(/Scope\s*\/\s*Requirements/iu);
  expect(prompt).toMatch(/Architecture\s*\/\s*Design/iu);
  for (const section of [
    "Implementation Approach",
    "Expected Change Surface",
    "New Components",
    "New Dependencies",
    "Non-goals",
  ])
    expect(prompt).toContain(section);
  expect(prompt).toMatch(/not a line-by-line recipe/u);
  expect(prompt).toMatch(/Validation Contract/iu);
  expect(prompt).toMatch(/orchestrator-validation/iu);
  expect(prompt).toMatch(/artifact refs?/iu);
  expect(prompt).toMatch(
    /must not.*(?:implement|source code|State|authority)/isu,
  );
  expect(prompt).toMatch(/fact(?:s)?/iu);
  expect(prompt).toMatch(/Human|clarification/iu);
});
