import { randomUUID } from "node:crypto";
import type { ArtifactRef } from "../../core/artifacts/references.ts";
import type { ResolvedExecutionProfile } from "../../core/configuration.ts";
import { isRecord } from "../../core/schema.ts";
import type { SubagentRunId } from "../../types.ts";
import { RuntimePortError } from "../ports/errors.ts";
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
  return value ? (value as SubagentRunId) : undefined;
}

function responseError(response: DelegationResponse): Error {
  const message = response.error ?? `Worker ended with ${response.status}`;
  if (response.status === "timed_out") {
    return new RuntimePortError("timeout", message);
  }
  return new RuntimePortError("infrastructure", message);
}

/**
 * Adapter for the versioned pi-subagents event contract. The host supplies its
 * public event bus; pi-subagents remains an unmodified third-party extension.
 */
export class SubagentsIntegration implements SubagentExecutor {
  private readonly ownerRunId: string;
  private readonly cwd: string;
  private readonly timeoutMs?: number;

  constructor(
    private readonly events: EventBus,
    options: SubagentsIntegrationOptions = {},
  ) {
    this.ownerRunId = options.ownerRunId ?? randomUUID();
    this.cwd = options.cwd ?? process.cwd();
    this.timeoutMs = options.timeoutMs;
  }

  async run(input: AgentRunRequest): Promise<AgentRunResult> {
    const requestId = randomUUID();
    const nodeId = `worker-${requestId}`;
    const response = await this.delegate({
      requestId,
      ownerRunId: this.ownerRunId,
      nodeId,
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
      ...(this.timeoutMs === undefined ? {} : { timeoutMs: this.timeoutMs }),
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
          runId: runId ?? (requestId as SubagentRunId),
          reason:
            "pi-subagents completed without a text result and run identity",
        };
      }
      return { status: "succeeded", runId, output: response.result.text };
    }
    if (response.status === "failed" && runId) {
      return {
        status: "failed",
        runId,
        error: response.error ?? "Worker failed",
      };
    }
    if (response.status === "failed") {
      throw responseError(response);
    }
    throw responseError(response);
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
      const listener = (payload: unknown): void => {
        if (!isDelegationResponse(payload)) return;
        if (
          payload.requestId !== request.requestId ||
          (payload.ownerRunId !== undefined &&
            payload.ownerRunId !== request.ownerRunId) ||
          (payload.nodeId !== undefined && payload.nodeId !== request.nodeId)
        ) {
          return;
        }
        unsubscribe();
        resolve(payload);
      };
      const unsubscribe = this.events.on(
        SUBAGENT_DELEGATION_RESPONSE_EVENT,
        listener,
      );
      try {
        this.events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, request);
      } catch (error) {
        unsubscribe();
        reject(
          new RuntimePortError(
            "infrastructure",
            `Unable to launch pi-subagents Worker: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          ),
        );
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
    throw new RuntimePortError(
      "domain",
      `Unsupported pi-subagents thinking level: ${value}`,
    );
  }
  return value as DelegationThinking;
}
