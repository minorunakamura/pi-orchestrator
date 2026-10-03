import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

test("Plan simplicity is read-only evidence-backed pre-code review, distinct from post-code Ponytail", async () => {
  const definition = await readFile(
    "agents/plan-simplicity-reviewer.md",
    "utf8",
  );
  expect(definition).toMatch(/tools: read, grep, find, ls, codemode\n/u);
  expect(definition).toContain(
    "subagentOnlyExtensions: ../src/runtime/integrations/readonly-codemode.ts",
  );
  expect(definition).toContain("toolTimeoutMs: 30000");
  expect(definition).toContain(
    "Retain path, line ranges and verbatim excerpts",
  );
  expect(definition).toMatch(/inheritSkills: false/u);
  expect(definition).toMatch(/Taste alone is not a finding/u);
  expect(definition).toContain("verbatim excerpts");
  expect(definition).toContain("at most one");
  expect(definition).toContain("Human Plan Gate is always required");
  expect(definition).toContain("not post-code Ponytail");
});
