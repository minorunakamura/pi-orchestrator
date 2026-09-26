import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const definitionPath = resolve("agents/ponytail-reviewer.md");

test("defines ponytail-reviewer as a structured simplicity reviewer without authority", async () => {
  const definition = await readFile(definitionPath, "utf8");
  const frontmatter = definition.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? "";
  const prompt = definition.replace(/^---\n[\s\S]*?\n---\n/u, "");

  expect(frontmatter).toMatch(/(^|\n)name:\s*ponytail-reviewer\s*(\n|$)/u);
  expect(frontmatter).toMatch(
    /(^|\n)tools:\s*read,\s*grep,\s*find,\s*ls\s*(\n|$)/u,
  );
  expect(frontmatter).not.toMatch(/(^|\n)tools:.*\b(edit|write|bash)\b/u);
  expect(prompt).toMatch(/structured findings?/iu);
  expect(prompt).toMatch(/schemaVersion\s*[:：]\s*1/iu);
  expect(prompt).toMatch(/source\s*[:：]\s*["']ponytail["']/iu);
  expect(prompt).toMatch(/blocking/iu);
  expect(prompt).toMatch(/must not.*(?:Fix|State|authority)/isu);
  expect(prompt).toMatch(/over.?engineering|simplicity|unnecessary/iu);
  expect(prompt).toMatch(/approved plan/iu);
  expect(prompt).toMatch(/JSON|machine-readable/iu);
});
