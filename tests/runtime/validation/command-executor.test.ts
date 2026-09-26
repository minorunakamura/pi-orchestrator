import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ValidationContract } from "../../../src/core/decisions/types.ts";
import { CommandValidationExecutor } from "../../../src/runtime/validation/command-executor.ts";

const roots: string[] = [];

function nodeCommand(source: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join("/tmp", "pi-orchestrator-validation-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("CommandValidationExecutor", () => {
  test("returns execution-only passed checks without an implementation revision", async () => {
    const cwd = await makeRoot();
    const contract: ValidationContract = {
      schemaVersion: 1,
      checks: [
        {
          id: "tests",
          type: "command",
          command: nodeCommand("process.exit(0)"),
          cwd,
          required: true,
        },
        {
          id: "optional-check",
          type: "command",
          command: nodeCommand("process.exit(0)"),
          cwd,
          required: false,
        },
      ],
    };

    const result = await new CommandValidationExecutor().execute(contract);

    expect(result).toEqual({
      status: "passed",
      checks: [
        { id: "tests", status: "passed", exitCode: 0 },
        { id: "optional-check", status: "passed", exitCode: 0 },
      ],
    });
    expect(result).not.toHaveProperty("implementationRevision");
  });

  test("classifies a required non-zero exit as an ordinary validation failure", async () => {
    const cwd = await makeRoot();
    const result = await new CommandValidationExecutor().execute({
      schemaVersion: 1,
      checks: [
        {
          id: "tests",
          type: "command",
          command: nodeCommand("process.exit(3)"),
          cwd,
          required: true,
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.checks).toEqual([
      { id: "tests", status: "failed", exitCode: 3, evidence: "exit code 3" },
    ]);
  });

  test("does not fail the contract for a failed non-required check", async () => {
    const cwd = await makeRoot();
    const result = await new CommandValidationExecutor().execute({
      schemaVersion: 1,
      checks: [
        {
          id: "tests",
          type: "command",
          command: nodeCommand("process.exit(0)"),
          cwd,
          required: true,
        },
        {
          id: "optional-check",
          type: "command",
          command: nodeCommand("process.exit(2)"),
          cwd,
          required: false,
        },
      ],
    });

    expect(result.status).toBe("passed");
    expect(result.checks[1]).toEqual({
      id: "optional-check",
      status: "failed",
      exitCode: 2,
      evidence: "exit code 2",
    });
  });

  test("classifies an unavailable cwd as validation infrastructure error", async () => {
    const result = await new CommandValidationExecutor().execute({
      schemaVersion: 1,
      checks: [
        {
          id: "tests",
          type: "command",
          command: nodeCommand("process.exit(0)"),
          cwd: "/tmp/pi-orchestrator-validation-missing-cwd",
          required: true,
        },
      ],
    });

    expect(result.status).toBe("infrastructure-error");
    expect(result.checks[0]).toMatchObject({
      id: "tests",
      status: "infrastructure-error",
    });
    expect(result.checks[0]?.evidence).toMatch(/cwd|spawn|ENOENT/iu);
  });

  test("classifies a timeout as infrastructure error rather than command failure", async () => {
    const cwd = await makeRoot();
    const result = await new CommandValidationExecutor().execute({
      schemaVersion: 1,
      checks: [
        {
          id: "tests",
          type: "command",
          command: nodeCommand("setTimeout(() => process.exit(0), 500)"),
          cwd,
          required: true,
          timeoutMs: 20,
        },
      ],
    });

    expect(result.status).toBe("infrastructure-error");
    expect(result.checks[0]).toMatchObject({
      id: "tests",
      status: "infrastructure-error",
    });
    expect(result.checks[0]?.evidence).toMatch(/timed out|timeout/iu);
  });
});
