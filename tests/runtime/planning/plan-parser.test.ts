import { describe, expect, test } from "vitest";
import {
  PlanParseError,
  parsePlan,
} from "../../../src/runtime/planning/plan-parser.ts";

const contract = `
## Validation Contract

\`\`\`orchestrator-validation
{
  "schemaVersion": 1,
  "checks": [
    {
      "id": "tests",
      "type": "command",
      "command": "pnpm test",
      "cwd": ".",
      "required": true,
      "timeoutMs": 120000
    }
  ]
}
\`\`\`
`;

function plan(options: { architecture?: boolean } = {}): string {
  return [
    "# Plan",
    "",
    "## Scope / Requirements",
    "Implement the requested behavior.",
    options.architecture === false
      ? ""
      : "## Architecture / Design\nKeep the runtime boundary explicit.",
    "## Implementation Plan",
    "1. Add the smallest safe implementation.",
    contract,
  ]
    .filter(Boolean)
    .join("\n\n");
}

describe("parsePlan", () => {
  test("accepts required sections and returns the machine-readable contract", () => {
    const parsed = parsePlan(plan());

    expect(parsed.sections).toEqual(
      expect.arrayContaining([
        "Scope / Requirements",
        "Architecture / Design",
        "Implementation Plan",
        "Validation Contract",
      ]),
    );
    expect(parsed.validationContract).toEqual({
      schemaVersion: 1,
      checks: [
        {
          id: "tests",
          type: "command",
          command: "pnpm test",
          cwd: ".",
          required: true,
          timeoutMs: 120000,
        },
      ],
    });
  });

  test("allows Architecture / Design to be omitted when policy does not require it", () => {
    expect(() => parsePlan(plan({ architecture: false }))).not.toThrow();
    expect(() =>
      parsePlan(plan({ architecture: false }), { architectureRequired: true }),
    ).toThrow(/Architecture \/ Design/iu);
  });

  test.each([
    ["Scope / Requirements", /Scope \/ Requirements/iu],
    ["Implementation Plan", /Implementation Plan/iu],
    ["Validation Contract", /Validation Contract/iu],
  ])("rejects a plan missing %s", (section, heading) => {
    const withoutSection = plan().replace(
      new RegExp(`## ${section}[\\s\\S]*?(?=## |$)`, "u"),
      "",
    );

    expect(() => parsePlan(withoutSection)).toThrow(heading);
  });

  test("rejects duplicate logical sections", () => {
    expect(() =>
      parsePlan(`${plan()}\n\n## Implementation Plan\nDuplicate.`),
    ).toThrow(/duplicate.*Implementation Plan/iu);
  });

  test("rejects a contract block outside the Validation Contract section", () => {
    const outside = plan().replace(
      "## Validation Contract",
      "## Notes\n\n## Validation Contract",
    );

    expect(() => parsePlan(outside)).not.toThrow();
    expect(() =>
      parsePlan(
        outside.replace(
          /## Validation Contract[\s\S]*/u,
          "## Validation Contract\nThe block is missing.",
        ),
      ),
    ).toThrow(/orchestrator-validation|Validation Contract/iu);
  });

  test("does not treat headings inside tilde code fences as plan sections", () => {
    const disguised = plan().replace(
      "## Implementation Plan\n\n1. Add the smallest safe implementation.",
      "~~~markdown\n## Implementation Plan\n1. This is only an example.\n~~~",
    );

    expect(() => parsePlan(disguised)).toThrow(/Implementation Plan/iu);
  });

  test("exposes a stable validation error type", () => {
    try {
      parsePlan("## Scope / Requirements\nOnly scope.");
      throw new Error("expected parsePlan to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(PlanParseError);
    }
  });
});
