import { describe, expect, test } from "vitest";
import {
  ValidationContractParseError,
  parseValidationContractBlock,
} from "../../../src/runtime/validation/contract-parser.ts";

const validBlock = `## Validation Contract

\`\`\`orchestrator-validation
{
  "schemaVersion": 1,
  "checks": [
    {
      "id": "typecheck",
      "type": "command",
      "command": "pnpm typecheck",
      "cwd": ".",
      "required": true
    }
  ]
}
\`\`\`
`;

describe("parseValidationContractBlock", () => {
  test("extracts and validates one fenced orchestrator-validation block", () => {
    expect(parseValidationContractBlock(validBlock)).toEqual({
      schemaVersion: 1,
      checks: [
        {
          id: "typecheck",
          type: "command",
          command: "pnpm typecheck",
          cwd: ".",
          required: true,
        },
      ],
    });
  });

  test.each([
    ["missing block", "## Validation Contract\nNo executable checks."],
    [
      "malformed JSON",
      validBlock.replace(
        '"command": "pnpm typecheck"',
        '"command": "pnpm typecheck',
      ),
    ],
    [
      "unknown field",
      validBlock.replace(
        '"required": true',
        '"required": true,\n      "extra": true',
      ),
    ],
    ["empty checks", validBlock.replace(/\[\s*\{[\s\S]*?\}\s*\]/u, "[]")],
    [
      "invalid timeout",
      validBlock.replace(
        '"required": true',
        '"required": true,\n      "timeoutMs": 0',
      ),
    ],
    [
      "invalid check type",
      validBlock.replace('"type": "command"', '"type": "script"'),
    ],
    [
      "invalid schema version",
      validBlock.replace('"schemaVersion": 1', '"schemaVersion": 2'),
    ],
    [
      "duplicate check id",
      validBlock
        .replace('"id": "typecheck"', '"id": "same"')
        .replace(
          '"checks": [',
          '"checks": [{"id": "same", "type": "command", "command": "pnpm lint", "cwd": ".", "required": true},',
        ),
    ],
  ])("rejects %s", (_name, input) => {
    expect(() => parseValidationContractBlock(input)).toThrow(
      ValidationContractParseError,
    );
  });

  test("rejects multiple machine-readable blocks", () => {
    expect(() =>
      parseValidationContractBlock(`${validBlock}\n${validBlock}`),
    ).toThrow(/exactly one|multiple/iu);
  });

  test("ignores a contract-looking block inside another tilde fence", () => {
    expect(() =>
      parseValidationContractBlock(`~~~markdown\n${validBlock}\n~~~`),
    ).toThrow(ValidationContractParseError);
  });

  test("rejects an unterminated fenced block", () => {
    expect(() =>
      parseValidationContractBlock(validBlock.replace("\n```\n", "\n")),
    ).toThrow(ValidationContractParseError);
  });
});
