import { spawn, type ChildProcess } from "node:child_process";
import {
  isValidationContract,
  type ValidationCheck,
  type ValidationCheckResult,
  type ValidationContract,
  type ValidationExecutionResult,
} from "../../core/decisions/types.ts";
import type { ValidationExecutor } from "../ports/validation-executor.ts";

export class ValidationCommandError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ValidationCommandError";
  }
}

function outputEvidence(
  stdout: string,
  stderr: string,
  fallback: string,
): string {
  const output = `${stdout}${stderr}`.trim();
  return output.length > 0 ? output : fallback;
}

function runCheck(check: ValidationCheck): Promise<ValidationCheckResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(check.command, {
        cwd: check.cwd,
        shell: true,
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        id: check.id,
        status: "infrastructure-error",
        evidence: `Unable to spawn command: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: ValidationCheckResult): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      resolve(result);
    };
    if (check.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
        finish({
          id: check.id,
          status: "infrastructure-error",
          evidence: `Command timed out after ${check.timeoutMs}ms`,
        });
      }, check.timeoutMs);
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string | Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: string | Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      finish({
        id: check.id,
        status: "infrastructure-error",
        evidence: `Command infrastructure error: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      if (exitCode === 0) {
        finish({ id: check.id, status: "passed", exitCode: 0 });
        return;
      }
      if (exitCode === null) {
        finish({
          id: check.id,
          status: "infrastructure-error",
          evidence: outputEvidence(
            stdout,
            stderr,
            `Command terminated by ${signal ?? "an unknown signal"}`,
          ),
        });
        return;
      }
      finish({
        id: check.id,
        status: "failed",
        exitCode,
        evidence: outputEvidence(stdout, stderr, `exit code ${exitCode}`),
      });
    });
  });
}

export class CommandValidationExecutor implements ValidationExecutor {
  async execute(
    contract: ValidationContract,
  ): Promise<ValidationExecutionResult> {
    if (!isValidationContract(contract)) {
      throw new ValidationCommandError("Invalid Validation Contract");
    }

    const checks: ValidationCheckResult[] = [];
    for (const check of contract.checks) {
      // Required checks run in contract order; concurrent commands would change results.
      // oxlint-disable-next-line eslint/no-await-in-loop
      checks.push(await runCheck(check));
    }

    if (checks.some((check) => check.status === "infrastructure-error")) {
      return { status: "infrastructure-error", checks };
    }
    if (
      checks.some(
        (check, index) =>
          check.status === "failed" && contract.checks[index]?.required,
      )
    ) {
      return { status: "failed", checks };
    }
    return { status: "passed", checks };
  }
}
