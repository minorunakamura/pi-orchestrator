import { expect, test } from "vitest";
import { auditTddTranscript } from "./tdd-evidence.ts";

test("vertical-slice audit uses exact public calls/exit codes, rejects horizontal or missing evidence regardless of reporter text", () => {
  const records = [
    "TEST",
    "RED",
    "SOURCE",
    "GREEN",
    "TEST",
    "RED",
    "SOURCE",
    "GREEN",
    "GREEN",
  ].flatMap((step, index) => {
    const toolName = step === "TEST" || step === "SOURCE" ? "write" : "bash";
    return [
      {
        type: "tool_execution_start",
        toolCallId: String(index),
        toolName,
        args:
          toolName === "write"
            ? { path: step === "TEST" ? "greeting.test.mjs" : "greeting.mjs" }
            : { command: "node --test greeting.test.mjs" },
      },
      {
        type: "tool_execution_end",
        toolCallId: String(index),
        toolName,
        isError: step === "RED",
        result: {
          structuredContent: {
            exit_code: step === "RED" ? 1 : 0,
            truncated: false,
            output: "any reporter text",
          },
        },
      },
    ];
  });
  expect(auditTddTranscript(records)).toEqual([
    "RED",
    "GREEN",
    "RED",
    "GREEN",
    "GREEN",
  ]);
  expect(() => auditTddTranscript([])).toThrow(/vertical slices/u);
  expect(() =>
    auditTddTranscript([
      ...records.slice(0, 2),
      ...records.slice(8, 10),
      ...records.slice(2, 8),
      ...records.slice(10),
    ]),
  ).toThrow(/vertical slices/u);
  const truncated = structuredClone(records);
  truncated[3].result!.structuredContent.truncated = true;
  expect(() => auditTddTranscript(truncated)).toThrow();
});
