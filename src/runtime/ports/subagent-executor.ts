import { RuntimePortError } from "./errors.ts";

/** Only the adapter may assert this after proving no request was emitted. */
export class SubagentNotDispatchedError extends RuntimePortError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("infrastructure", message, options);
    this.name = "SubagentNotDispatchedError";
  }
}

import type { ArtifactRef } from "../../core/artifacts/references.ts";
import type { ResolvedExecutionProfile } from "../../core/configuration.ts";
import type { SubagentRunId } from "../../types.ts";

import type {
  AgentDispatch,
  AgentRunReceipt,
} from "../../core/planning/agent-attempt.ts";
export type {
  AgentDispatch,
  AgentRunReceipt,
} from "../../core/planning/agent-attempt.ts";

export interface AgentRunRequest {
  /** Orchestrator-owned correlation, persisted before dispatch. */
  dispatch?: AgentDispatch;
  onStarted?: (receipt: AgentRunReceipt) => Promise<void>;
  agent: string;
  task: string;
  cwd?: string;
  inputRefs?: readonly ArtifactRef[];
  executionProfile?: ResolvedExecutionProfile;
}

export type AgentRunResult = (
  | {
      status: "succeeded";
      runId: SubagentRunId;
      output: string;
    }
  | {
      status: "failed";
      notDispatched?: boolean;
      runId?: SubagentRunId;
      error: string;
    }
  | {
      status: "ambiguous";
      runId?: SubagentRunId;
      timedOut?: boolean;
      reason: string;
    }
) & { dispatch?: AgentDispatch };

export type AgentRunState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "ambiguous"
  | "unknown";

export interface AgentRunStatus {
  runId: SubagentRunId;
  status: AgentRunState;
  result?: AgentRunResult;
  reason?: string;
}

export interface SubagentExecutor {
  run(input: AgentRunRequest): Promise<AgentRunResult>;
  runParallel(inputs: AgentRunRequest[]): Promise<AgentRunResult[]>;
  status(
    runId: SubagentRunId,
    receipt?: AgentRunReceipt,
  ): Promise<AgentRunStatus>;
  resume(runId: SubagentRunId, task: string): Promise<AgentRunResult>;
}
