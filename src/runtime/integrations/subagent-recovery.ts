import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isRecord } from "../../core/schema.ts";
import type { AgentRunReceipt } from "../../core/planning/agent-attempt.ts";
import { subagentRunId } from "../../types.ts";
import type { AgentRunStatus } from "../ports/subagent-executor.ts";

export function agentOutputPath(root: string, requestId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(requestId))
    throw Error("Invalid request identity");
  return join(resolve(root), "agent-runs", `${requestId}.md`);
}

async function realDirectory(path: string): Promise<void> {
  const stat = await fs.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw Error("Recovery directory is not a real directory");
}

export async function prepareAgentOutput(
  root: string,
  requestId: string,
): Promise<string> {
  const path = agentOutputPath(root, requestId);
  await realDirectory(resolve(root));
  await fs.mkdir(dirname(path), { recursive: true });
  await realDirectory(dirname(path));
  try {
    await fs.lstat(path);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return path;
    throw error;
  }
  throw Error("Recovery output already exists; refusing to reuse an attempt");
}

async function readBounded(path: string): Promise<string> {
  const handle = await fs.open(
    path,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw Error("Invalid or oversized recovery artifact");
    const bytes = await handle.readFile();
    if (bytes.length > 1024 * 1024) throw Error("Oversized recovery artifact");
    return bytes.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readStatus(asyncDir: string): Promise<Record<string, unknown>> {
  if (!isAbsolute(asyncDir))
    throw Error("Recovery requires an absolute async directory");
  await realDirectory(asyncDir);
  const value: unknown = JSON.parse(
    await readBounded(join(asyncDir, "status.json")),
  );
  if (
    !isRecord(value) ||
    value.lifecycleArtifactVersion !== 3 ||
    value.mode !== "single"
  ) {
    throw Error("Unsupported public async lifecycle artifact");
  }
  return value;
}

/** Read the public initial status, which is durable before the spawn receipt. */
export async function captureRunReceipt(
  input: Omit<AgentRunReceipt, "sessionId">,
): Promise<AgentRunReceipt> {
  const status = await readStatus(input.asyncDir);
  if (
    status.runId !== input.runId ||
    typeof status.sessionId !== "string" ||
    !status.sessionId.trim()
  ) {
    throw Error("Async launch ownership is unavailable");
  }
  return { ...input, sessionId: status.sessionId };
}

/** The saved file is canonical for both live completion and recovery. */
export async function readAgentOutput(
  receipt: AgentRunReceipt,
  root: string,
): Promise<string> {
  if (receipt.outputPath !== agentOutputPath(root, receipt.requestId))
    throw Error("Recovery output is outside this Workflow");
  await realDirectory(resolve(root));
  await realDirectory(dirname(receipt.outputPath));
  const output = await readBounded(receipt.outputPath);
  if (!output.trim()) throw Error("Completed child output is empty");
  return output;
}

/** No private imports, directory scans, PID guesses, revival, or result-summary parsing. */
export async function recoverAgentRun(
  receipt: AgentRunReceipt,
  root: string,
): Promise<AgentRunStatus> {
  const runId = subagentRunId(receipt.runId);
  try {
    if (receipt.outputPath !== agentOutputPath(root, receipt.requestId))
      throw Error("Recovery output is outside this Workflow");
    const status = await readStatus(receipt.asyncDir);
    if (
      status.runId !== receipt.runId ||
      status.sessionId !== receipt.sessionId ||
      status.launchContractDigest !== receipt.launchContractDigest ||
      status.cwd !== receipt.cwd ||
      !Array.isArray(status.steps) ||
      status.steps.length !== 1 ||
      !isRecord(status.steps[0]) ||
      status.steps[0].agent !== receipt.agent
    ) {
      throw Error("Public async status does not match the persisted launch");
    }
    if (status.state === "queued" || status.state === "running") {
      return { runId, status: status.state };
    }
    if (
      status.state !== "complete" ||
      !["complete", "completed"].includes(String(status.steps[0].status)) ||
      status.timedOut === true ||
      status.stopped === true ||
      status.error ||
      status.steps[0].error
    ) {
      return {
        runId,
        status: "unknown",
        reason: "Child has no successful terminal result; do not relaunch",
      };
    }
    const output = await readAgentOutput(receipt, root);
    return {
      runId,
      status: "succeeded",
      result: { runId, status: "succeeded", output },
    };
  } catch (error) {
    return {
      runId,
      status: "unknown",
      reason:
        error instanceof Error
          ? error.message
          : "Recovery evidence unavailable",
    };
  }
}
