import assert from "node:assert/strict";
import { isRecord } from "../../src/core/schema.ts";

/** Public tool arguments + structured exit codes, independent of Node's text reporter. */
export function auditTddTranscript(records: readonly unknown[]) {
  const calls = new Map<string, Record<string, unknown>>();
  const sequence: string[] = [];
  const colors: string[] = [];
  for (const event of records) {
    if (
      !isRecord(event) ||
      !isRecord(event.args) ||
      typeof event.toolCallId !== "string" ||
      event.type !== "tool_execution_start"
    )
      continue;
    calls.set(event.toolCallId, event.args);
  }
  for (const event of records) {
    if (
      !isRecord(event) ||
      event.type !== "tool_execution_end" ||
      typeof event.toolCallId !== "string"
    )
      continue;
    const args = calls.get(event.toolCallId);
    if (!args) continue;
    if (
      ["edit", "write"].includes(String(event.toolName)) &&
      event.isError === false
    ) {
      if (args.path === "greeting.test.mjs") sequence.push("TEST");
      if (args.path === "greeting.mjs") sequence.push("SOURCE");
    }
    if (
      event.toolName !== "bash" ||
      args.command !== "node --test greeting.test.mjs"
    )
      continue;
    assert(
      isRecord(event.result) && isRecord(event.result.structuredContent),
      "Structured Bash result required",
    );
    const result = event.result.structuredContent;
    assert.equal(result.truncated, false);
    assert(
      result.exit_code === 0 || result.exit_code === 1,
      "Expected a real pass/failing-test exit, not infrastructure failure",
    );
    const color = result.exit_code === 0 ? "GREEN" : "RED";
    colors.push(color);
    sequence.push(color);
  }
  assert.deepEqual(
    sequence.slice(0, 8),
    ["TEST", "RED", "SOURCE", "GREEN", "TEST", "RED", "SOURCE", "GREEN"],
    "Two observed vertical slices required; horizontal bulk testing is not TDD",
  );
  assert(colors.slice(4).every((color) => color === "GREEN"));
  return colors;
}
