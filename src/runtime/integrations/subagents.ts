import { randomUUID } from "node:crypto";
import type { ArtifactRef } from "../../core/artifacts/references.ts";
import type { ResolvedExecutionProfile } from "../../core/configuration.ts";
import { isRecord } from "../../core/schema.ts";
import type { SubagentRunId } from "../../types.ts";
import { RuntimePortError } from "../ports/errors.ts";
import { SubagentNotDispatchedError } from "../ports/subagent-executor.ts";
import type {
  AgentRunRequest,
  AgentRunResult,
  AgentRunStatus,
  SubagentExecutor,
} from "../ports/subagent-executor.ts";

/** Public pi-subagents delegation event names; no private package API is used. */
export const SUBAGENT_DELEGATION_REQUEST_EVENT =
  "prompt-template:subagent:request" as const;
export const SUBAGENT_DELEGATION_RESPONSE_EVENT =
  "prompt-template:subagent:response" as const;

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

type DelegationThinking =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

interface DelegationRequest {
  requestId: string;
  ownerRunId: string;
  nodeId: string;
  agent: string;
  task: string;
  context: "fresh" | "fork";
  cwd: string;
  model?: string;
  thinking?: DelegationThinking;
  timeoutMs?: number;
  result: { kind: "text" };
}

interface DelegationResponse {
  requestId: string;
  ownerRunId?: string;
  nodeId?: string;
  status: string;
  error?: string;
  runId?: string;
  result?:
    | { kind: "text"; text: string }
    | { kind: "structured"; value: unknown };
}

export interface SubagentsIntegrationOptions {
  ownerRunId?: string;
  cwd?: string;
  timeoutMs?: number;
}

function asRunId(value: string | undefined): SubagentRunId | undefined {
  return typeof value === "string" && value.trim()
    ? (value as SubagentRunId)
    : undefined;
}

export const DEFAULT_SUBAGENT_TIMEOUT_MS = 300_000;

/**
 * Adapter for the versioned pi-subagents event contract. The host supplies its
 * public event bus; pi-subagents remains an unmodified third-party extension.
 */
export class SubagentsIntegration implements SubagentExecutor {
  private readonly ownerRunId: string;
  private readonly cwd: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly events: EventBus,
    options: SubagentsIntegrationOptions = {},
  ) {
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
    const remaining = Date.parse(dispatch.deadline) - Date.now();
    if (
      !requestId ||
      !dispatch.ownerRunId ||
      !dispatch.nodeId ||
      !Number.isFinite(remaining) ||
      remaining <= 0
    )
      throw new SubagentNotDispatchedError(
        "Invalid or expired subagent dispatch identity",
      );
    const response = await this.delegate({
      requestId,
      ownerRunId: dispatch.ownerRunId,
      nodeId: dispatch.nodeId,
      agent: input.agent,
      task: taskWithArtifactRefs(input),
      context: "fresh",
      cwd: input.cwd ?? this.cwd,
      ...(input.executionProfile
        ? {
            // The public contract has no separate provider field. A
            // provider-qualified model pins both configuration dimensions.
            model: `${input.executionProfile.provider}/${input.executionProfile.model}`,
            thinking: toDelegationThinking(input.executionProfile.thinking),
          }
        : {}),
      timeoutMs: Math.min(this.timeoutMs, remaining),
      result: { kind: "text" },
    });

    const runId = asRunId(response.runId);
    if (response.status === "completed") {
      if (
        !runId ||
        response.result?.kind !== "text" ||
        typeof response.result.text !== "string"
      ) {
        return {
          status: "ambiguous",
          ...(runId ? { runId } : {}),
          dispatch,
          reason:
            "pi-subagents completed without a text result and run identity",
        };
      }
      return {
        status: "succeeded",
        runId,
        output: response.result.text,
        dispatch,
      };
    }
    if (response.status === "failed") {
      return {
        status: "failed",
        ...(runId ? { runId } : {}),
        dispatch,
        error: response.error ?? "Worker failed",
      };
    }
    return {
      status: "ambiguous",
      ...(runId ? { runId } : {}),
      dispatch,
      timedOut: response.status === "timed_out",
      reason: response.error ?? "Subagent outcome is unknown",
    };
  }

  runParallel(inputs: AgentRunRequest[]): Promise<AgentRunResult[]> {
    return Promise.all(inputs.map((input) => this.run(input)));
  }

  status(_runId: SubagentRunId): Promise<AgentRunStatus> {
    return Promise.reject(
      new RuntimePortError(
        "reconciliation",
        "pi-subagents status requires a host reconciliation adapter",
      ),
    );
  }

  resume(_runId: SubagentRunId, _task: string): Promise<AgentRunResult> {
    return Promise.reject(
      new RuntimePortError(
        "reconciliation",
        "pi-subagents resume requires a host reconciliation adapter",
      ),
    );
  }

  private delegate(request: DelegationRequest): Promise<DelegationResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let dispatched = false;
      let unsubscribe = () => {};
      const finish = (response: DelegationResponse): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(response);
      };
      const timer = setTimeout(
        () =>
          finish({
            requestId: request.requestId,
            status: "timed_out",
            error: "Subagent response deadline exceeded",
          }),
        request.timeoutMs ?? this.timeoutMs,
      );
      const listener = (payload: unknown): void => {
        if (!dispatched || !isDelegationResponse(payload)) return;
        if (
          payload.requestId !== request.requestId ||
          (payload.ownerRunId !== undefined &&
            payload.ownerRunId !== request.ownerRunId) ||
          (payload.nodeId !== undefined && payload.nodeId !== request.nodeId)
        ) {
          return;
        }
        finish(payload);
      };
      try {
        unsubscribe = this.events.on(
          SUBAGENT_DELEGATION_RESPONSE_EVENT,
          listener,
        );
      } catch (cause) {
        clearTimeout(timer);
        settled = true;
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
        this.events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, request);
      } catch {
        finish({
          requestId: request.requestId,
          status: "ambiguous",
          error: "Dispatch threw; child launch status is unknown",
        });
      }
    });
  }
}

function isDelegationResponse(value: unknown): value is DelegationResponse {
  if (!isRecord(value)) return false;
  const candidate = value;
  return (
    typeof candidate.requestId === "string" &&
    typeof candidate.status === "string" &&
    (candidate.runId === undefined ||
      (typeof candidate.runId === "string" &&
        candidate.runId.trim().length > 0)) &&
    (candidate.error === undefined || typeof candidate.error === "string") &&
    (candidate.ownerRunId === undefined ||
      typeof candidate.ownerRunId === "string") &&
    (candidate.nodeId === undefined || typeof candidate.nodeId === "string")
  );
}

function taskWithArtifactRefs(input: AgentRunRequest): string {
  const refs = JSON.stringify(input.inputRefs ?? []);
  return `${input.task}\n\nAuthoritative artifact refs (read through the orchestrator ArtifactStore):\n${refs}`;
}

function toDelegationThinking(value: string): DelegationThinking {
  const allowed: readonly DelegationThinking[] = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];
  if (!allowed.includes(value as DelegationThinking)) {
    throw new SubagentNotDispatchedError(
      `Unsupported pi-subagents thinking level: ${value}`,
    );
  }
  return value as DelegationThinking;
}
