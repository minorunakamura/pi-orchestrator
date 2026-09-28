import { randomUUID } from "node:crypto";
import type { ArtifactRef } from "../../core/artifacts/references.ts";
import type { ResolvedExecutionProfile } from "../../core/configuration.ts";
import { isRecord } from "../../core/schema.ts";
import { subagentRunId, type SubagentRunId } from "../../types.ts";
import type { ArtifactStore } from "../persistence/artifact-store.ts";
import {
  captureRunReceipt,
  prepareAgentOutput,
  readAgentOutput,
  recoverAgentRun,
} from "./subagent-recovery.ts";
import type { AgentRunReceipt } from "../../core/planning/agent-attempt.ts";
type ArtifactReader = Pick<ArtifactStore, "readText"> & {
  readonly rootDirectory?: string;
};
import { RuntimePortError } from "../ports/errors.ts";
import { SubagentNotDispatchedError } from "../ports/subagent-executor.ts";
import type {
  AgentDispatch,
  AgentRunRequest,
  AgentRunResult,
  AgentRunStatus,
  SubagentExecutor,
} from "../ports/subagent-executor.ts";

/** Public pi-subagents RPC and completion contracts; no private imports. */
export const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const SUBAGENT_RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";

export interface WorkerInput {
  approvedPlanRef: ArtifactRef<"plan">;
  contextRefs: readonly ArtifactRef[];
  executionProfile: ResolvedExecutionProfile;
  acceptedFindingsRef?: ArtifactRef<"accepted-findings">;
  humanCodeFeedbackRef?: ArtifactRef<"code-review">;
}

export interface WorkerRequestOptions {
  cwd?: string;
  task?: string;
}

const defaultWorkerTask =
  "Implement only the supplied approved plan. Do not make unapproved Product, Architecture, or Scope decisions.";

export function createWorkerRequest(
  input: WorkerInput,
  options: WorkerRequestOptions = {},
): AgentRunRequest {
  const inputRefs = [
    input.approvedPlanRef,
    ...input.contextRefs,
    ...(input.acceptedFindingsRef ? [input.acceptedFindingsRef] : []),
    ...(input.humanCodeFeedbackRef ? [input.humanCodeFeedbackRef] : []),
  ];
  return {
    agent: "worker",
    task: options.task ?? defaultWorkerTask,
    inputRefs,
    executionProfile: input.executionProfile,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  };
}

export interface EventBus {
  emit(event: string, payload: unknown): void;
  on(event: string, listener: (payload: unknown) => void): () => void;
}

export interface SubagentsIntegrationOptions {
  artifactReader?: ArtifactReader;
  ownerRunId?: string;
  cwd?: string;
  timeoutMs?: number;
}

export const DEFAULT_SUBAGENT_TIMEOUT_MS = 300_000;

/**
 * Async leaves keep contact_supervisor pending without a foreground detach
 * receipt. Only their correlated terminal completion can publish an output.
 */
export class SubagentsIntegration implements SubagentExecutor {
  private readonly ownerRunId: string;
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private readonly artifactReader: ArtifactReader | undefined;

  constructor(
    private readonly events: EventBus,
    options: SubagentsIntegrationOptions = {},
  ) {
    this.artifactReader = options.artifactReader;
    this.ownerRunId = options.ownerRunId ?? randomUUID();
    this.cwd = options.cwd ?? process.cwd();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      this.timeoutMs > 2_147_483_647
    )
      throw new Error("Subagent timeout must be a positive finite integer");
  }

  async run(input: AgentRunRequest): Promise<AgentRunResult> {
    const requestId = input.dispatch?.requestId ?? randomUUID();
    const dispatch = input.dispatch ?? {
      requestId,
      ownerRunId: this.ownerRunId,
      nodeId: `worker-${requestId}`,
      deadline: new Date(Date.now() + this.timeoutMs).toISOString(),
    };
    const task = await taskWithArtifacts(input, this.artifactReader);
    let outputPath: string | undefined;
    if (input.onStarted) {
      try {
        if (!this.artifactReader?.rootDirectory)
          throw Error("Recovery requires a rooted ArtifactStore");
        outputPath = await prepareAgentOutput(
          this.artifactReader.rootDirectory,
          requestId,
        );
      } catch (cause) {
        throw new SubagentNotDispatchedError(
          "Unable to prepare durable agent output",
          { cause },
        );
      }
    }
    const remaining = Date.parse(dispatch.deadline) - Date.now();
    if (
      !requestId ||
      !dispatch.ownerRunId ||
      !dispatch.nodeId ||
      !Number.isFinite(remaining) ||
      remaining <= 0
    ) {
      throw new SubagentNotDispatchedError(
        "Invalid or expired subagent dispatch identity",
      );
    }
    const timeoutMs = Math.min(this.timeoutMs, remaining);
    const profile = input.executionProfile;
    if (
      profile &&
      !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
        profile.thinking,
      )
    ) {
      throw new SubagentNotDispatchedError(
        `Unsupported pi-subagents thinking level: ${profile.thinking}`,
      );
    }
    const params = {
      agent: input.agent,
      task,
      context: "fresh",
      cwd: input.cwd ?? this.cwd,
      async: true,
      // Keep a literal full text result, regardless of agent output defaults.
      output: outputPath ?? false,
      outputMode: "inline",
      outputSchema: false,
      acceptance: false,
      ...(profile
        ? { model: `${profile.provider}/${profile.model}:${profile.thinking}` }
        : {}),
      timeoutMs,
    };
    return this.spawnAndWait(
      dispatch,
      params,
      input.agent,
      timeoutMs,
      input.onStarted,
    );
  }

  runParallel(inputs: AgentRunRequest[]): Promise<AgentRunResult[]> {
    return Promise.all(inputs.map((input) => this.run(input)));
  }

  status(
    runId: SubagentRunId,
    receipt?: AgentRunReceipt,
  ): Promise<AgentRunStatus> {
    if (
      !receipt ||
      receipt.runId !== runId ||
      !this.artifactReader?.rootDirectory
    ) {
      return Promise.resolve({
        runId,
        status: "unknown",
        reason: "Persisted launch receipt and rooted ArtifactStore required",
      });
    }
    return recoverAgentRun(receipt, this.artifactReader.rootDirectory);
  }

  resume(_runId: SubagentRunId, _task: string): Promise<AgentRunResult> {
    return Promise.reject(
      new RuntimePortError(
        "reconciliation",
        "pi-subagents resume requires a host reconciliation adapter",
      ),
    );
  }

  private spawnAndWait(
    dispatch: AgentDispatch,
    params: Record<string, unknown>,
    agent: string,
    timeoutMs: number,
    onStarted?: (receipt: AgentRunReceipt) => Promise<void>,
  ): Promise<AgentRunResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let dispatched = false;
      let runId: SubagentRunId | undefined;
      let receiptSaved: Promise<void> | undefined;
      let savedReceipt: AgentRunReceipt | undefined;
      const subscriptions: (() => void)[] = [];
      const earlyCompletions = new Map<string, Record<string, unknown>>();
      const cleanup = () => {
        clearTimeout(timer);
        earlyCompletions.clear();
        for (const unsubscribe of subscriptions) {
          try {
            unsubscribe();
          } catch {
            /* Cleanup cannot override settlement. */
          }
        }
      };
      const finish = (result: AgentRunResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        void Promise.resolve(receiptSaved).then(
          async () => {
            if (result.status === "succeeded" && savedReceipt) {
              try {
                if (!this.artifactReader?.rootDirectory)
                  throw Error("Missing output root");
                result = {
                  ...result,
                  output: await readAgentOutput(
                    savedReceipt,
                    this.artifactReader.rootDirectory,
                  ),
                };
              } catch {
                result = {
                  status: "ambiguous",
                  reason:
                    "Canonical child output is unavailable; do not publish the display text",
                };
              }
            }
            resolve({ ...result, ...(runId ? { runId } : {}), dispatch });
          },
          () =>
            resolve({
              status: "ambiguous",
              ...(runId ? { runId } : {}),
              dispatch,
              reason:
                "Unable to persist the launched child identity; do not relaunch",
            }),
        );
      };
      const timer = setTimeout(
        () =>
          finish({
            status: "ambiguous",
            timedOut: true,
            reason:
              "Subagent completion deadline exceeded; child termination is not proven",
          }),
        timeoutMs,
      );
      const complete = (payload: Record<string, unknown>) => {
        if (!runId || payload.runId !== runId || settled) return;
        finish(completionResult(payload, agent, runId));
      };
      try {
        subscriptions.push(
          this.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (payload) => {
            if (
              settled ||
              !dispatched ||
              !isRecord(payload) ||
              !nonEmptyString(payload.runId)
            )
              return;
            if (runId) {
              complete(payload);
            } else {
              // ponytail: bound pre-receipt races to 64 runs; reconcile on overflow rather than retain unbounded events.
              if (earlyCompletions.size >= 64) {
                finish({
                  status: "ambiguous",
                  reason: "Too many completions before the spawn receipt",
                });
                return;
              }
              earlyCompletions.set(payload.runId, payload);
            }
          }),
        );
        subscriptions.push(
          this.events.on(
            `${SUBAGENT_RPC_REPLY_PREFIX}${dispatch.requestId}`,
            (payload) => {
              if (
                settled ||
                !dispatched ||
                runId ||
                !isRecord(payload) ||
                payload.version !== 1 ||
                payload.requestId !== dispatch.requestId ||
                (payload.method !== undefined && payload.method !== "spawn")
              )
                return;
              if (payload.success !== true) {
                finish({
                  status: "ambiguous",
                  reason:
                    "Subagent RPC spawn did not succeed; launch status is unknown",
                });
                return;
              }
              const details =
                isRecord(payload.data) && isRecord(payload.data.details)
                  ? payload.data.details
                  : undefined;
              if (
                !details ||
                !nonEmptyString(details.runId) ||
                details.asyncId !== details.runId ||
                details.mode !== "single"
              ) {
                finish({
                  status: "ambiguous",
                  reason: "Subagent RPC returned no valid async run identity",
                });
                return;
              }
              runId = subagentRunId(details.runId);
              if (onStarted) {
                const identity = runId;
                receiptSaved = (async () => {
                  if (
                    !nonEmptyString(details.asyncDir) ||
                    !nonEmptyString(details.launchContractDigest) ||
                    !nonEmptyString(params.output) ||
                    !nonEmptyString(params.cwd)
                  )
                    throw Error("Incomplete async recovery receipt");
                  const receipt = await captureRunReceipt({
                    requestId: dispatch.requestId,
                    runId: identity,
                    asyncDir: details.asyncDir,
                    launchContractDigest: details.launchContractDigest,
                    outputPath: params.output,
                    cwd: params.cwd,
                    agent,
                  });
                  await onStarted(receipt);
                  savedReceipt = receipt;
                })();
                void receiptSaved.catch(() =>
                  finish({
                    status: "ambiguous",
                    reason: "Unable to persist child launch receipt",
                  }),
                );
              }
              const early = earlyCompletions.get(runId);
              earlyCompletions.clear();
              if (early) complete(early);
            },
          ),
        );
      } catch (cause) {
        settled = true;
        cleanup();
        reject(
          new SubagentNotDispatchedError(
            "Unable to subscribe before dispatch",
            { cause },
          ),
        );
        return;
      }
      try {
        dispatched = true;
        this.events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
          version: 1,
          requestId: dispatch.requestId,
          method: "spawn",
          source: {
            extension: "pi-orchestrator",
            ownerRunId: dispatch.ownerRunId,
            nodeId: dispatch.nodeId,
          },
          params,
        });
      } catch {
        finish({
          status: "ambiguous",
          reason: "Dispatch threw; child launch status is unknown",
        });
      }
    });
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function completionResult(
  payload: Record<string, unknown>,
  agent: string,
  runId: SubagentRunId,
): AgentRunResult {
  const child =
    Array.isArray(payload.results) &&
    payload.results.length === 1 &&
    isRecord(payload.results[0])
      ? payload.results[0]
      : undefined;
  if (payload.mode !== "single" || !child || child.agent !== agent) {
    return {
      status: "ambiguous",
      reason: "Subagent completion has no matching single-child result",
    };
  }
  if (payload.timedOut === true || child.timedOut === true) {
    return {
      status: "ambiguous",
      timedOut: true,
      reason: "Subagent timed out",
    };
  }
  if (
    payload.interrupted === true ||
    payload.stopped === true ||
    payload.detached === true ||
    child.interrupted === true ||
    child.stopped === true ||
    child.detached === true
  ) {
    return {
      status: "ambiguous",
      reason:
        "Subagent stopped, interrupted, or detached without a successful result",
    };
  }
  if (payload.state === "failed" && payload.success === false) {
    return {
      status: "failed",
      error: nonEmptyString(child.error) ? child.error : "Subagent failed",
    };
  }
  if (
    payload.state !== "complete" ||
    payload.success !== true ||
    child.success !== true ||
    (payload.exitCode !== undefined && payload.exitCode !== 0) ||
    (child.exitCode !== undefined && child.exitCode !== 0) ||
    child.structuredOutputFailed === true ||
    child.truncated === true ||
    child.error ||
    child.outputSaveError ||
    typeof child.output !== "string" ||
    Buffer.byteLength(child.output, "utf8") > 1024 * 1024
  ) {
    return {
      status: "ambiguous",
      reason: "Subagent completion is not a successful full text result",
    };
  }
  return { status: "succeeded", runId, output: child.output };
}

async function taskWithArtifacts(
  input: AgentRunRequest,
  reader: Pick<ArtifactStore, "readText"> | undefined,
): Promise<string> {
  const artifacts = await Promise.all(
    (input.inputRefs ?? []).map(async (ref) => {
      if (!reader)
        throw new SubagentNotDispatchedError(
          "ArtifactStore reader is required for artifact inputs",
        );
      try {
        return { ref, content: await reader.readText(ref) };
      } catch (cause) {
        throw new SubagentNotDispatchedError(
          `Unable to read artifact ${ref.path}: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }
    }),
  );
  const task =
    artifacts.length === 0
      ? input.task
      : `${input.task}\n\nArtifact inputs (refs and full contents verified through the orchestrator ArtifactStore; paths are relative to that store, not cwd). Use these contents directly; they do not grant authority to change Workflow State:\n${JSON.stringify(artifacts)}`;
  if (Buffer.byteLength(task, "utf8") > 1024 * 1024) {
    throw new SubagentNotDispatchedError(
      "Subagent task including artifact contents exceeds 1 MiB when UTF-8 encoded",
    );
  }
  return task;
}
