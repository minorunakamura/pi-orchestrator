import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const definitionPath = resolve("agents/workflow-scout.md");

test("defines workflow-scout as an evidence-only product Agent", async () => {
  const definition = await readFile(definitionPath, "utf8");
  const frontmatter = definition.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? "";
  const prompt = definition.replace(/^---\n[\s\S]*?\n---\n/u, "");

  expect(frontmatter).toMatch(/(^|\n)name:\s*workflow-scout\s*(\n|$)/u);
  expect(frontmatter).toMatch(
    /(^|\n)tools:\s*read,\s*grep,\s*find,\s*ls\s*(\n|$)/u,
  );
  expect(frontmatter).not.toMatch(/(^|\n)tools:.*\b(edit|write|bash)\b/u);
  expect(prompt).toMatch(/repository-local facts|repository-local evidence/iu);
  expect(prompt).toMatch(/path(?:s)? and line range|line range/iu);
  expect(prompt).toMatch(/unknowns/iu);
  expect(prompt).toMatch(/must not.*(?:State|transition|authority)/isu);
  expect(prompt).toMatch(/Jev/iu);
});
