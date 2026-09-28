import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  SUBAGENT_RPC_REPLY_PREFIX,
  SUBAGENT_RPC_REQUEST_EVENT,
  type EventBus,
} from "../../src/runtime/integrations/subagents.ts";
import { requireRecord } from "./typed-boundaries.ts";

export function childRequest(payload: unknown): Record<string, unknown> {
  const envelope = requireRecord(payload);
  return {
    ...requireRecord(envelope.params),
    ...requireRecord(envelope.source),
    requestId: envelope.requestId,
  };
}

export class FakeSubagentRpc implements EventBus {
  readonly emitted: { event: string; payload: unknown }[] = [];
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  readonly asyncDirs = new Map<string, string>();
  constructor(
    readonly spawn?: (
      request: Record<string, unknown>,
      bus: FakeSubagentRpc,
    ) => void,
  ) {}

  emit(event: string, payload: unknown): void {
    this.emitted.push({ event, payload });
    if (event !== SUBAGENT_RPC_REQUEST_EVENT) return;
    const request = childRequest(payload);
    if (this.spawn) this.spawn(request, this);
    else {
      const id = `run-${String(request.requestId)}`;
      this.receipt(request, id);
      this.complete(request, id, "complete", "implemented");
    }
  }

  on(event: string, listener: (payload: unknown) => void): () => void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return () => listeners.delete(listener);
  }

  deliver(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  receipt(request: Record<string, unknown>, runId: string): void {
    let asyncDir: string | undefined;
    const launchContractDigest = `digest-${runId}`;
    if (typeof request.output === "string") {
      asyncDir = join(dirname(request.output), `async-${runId}`);
      this.asyncDirs.set(runId, asyncDir);
      mkdirSync(asyncDir, { recursive: true });
      writeFileSync(
        join(asyncDir, "status.json"),
        JSON.stringify({
          lifecycleArtifactVersion: 3,
          runId,
          sessionId: "fixture-session",
          mode: "single",
          state: "running",
          cwd: request.cwd,
          launchContractDigest,
          steps: [{ agent: request.agent, status: "running" }],
        }),
      );
    }
    this.deliver(`${SUBAGENT_RPC_REPLY_PREFIX}${String(request.requestId)}`, {
      version: 1,
      requestId: request.requestId,
      method: "spawn",
      success: true,
      data: {
        details: {
          mode: "single",
          runId,
          asyncId: runId,
          asyncDir,
          launchContractDigest,
          results: [],
        },
      },
    });
  }

  complete(
    request: Record<string, unknown>,
    runId: string,
    state: string,
    output?: string,
  ): void {
    const asyncDir = this.asyncDirs.get(runId);
    if (asyncDir) {
      if (
        state === "complete" &&
        typeof output === "string" &&
        typeof request.output === "string"
      )
        writeFileSync(request.output, output);
      const status = JSON.parse(
        readFileSync(join(asyncDir, "status.json"), "utf8"),
      );
      writeFileSync(
        join(asyncDir, "status.json"),
        JSON.stringify({
          ...status,
          state,
          steps: [{ agent: request.agent, status: state }],
        }),
      );
    }
    this.deliver(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      lifecycleArtifactVersion: 3,
      id: runId,
      runId,
      mode: "single",
      state,
      success: state === "complete",
      summary: "display only",
      results: [
        {
          agent: request.agent,
          success: state === "complete",
          output:
            asyncDir && typeof output === "string"
              ? `${output}\n\nOutput saved to: ${String(request.output)}. Read this file if needed.`
              : output,
        },
      ],
    });
  }
}
