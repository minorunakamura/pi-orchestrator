import { RuntimePortError } from "./errors.ts";
import type { PlanningAgentDiagnosticCode } from "../../core/planning/agent-attempt.ts";

/** Only the adapter may assert this after proving no request was emitted. */
export class SubagentNotDispatchedError extends RuntimePortError {
  readonly diagnosticCode?: PlanningAgentDiagnosticCode;

  constructor(
    message: string,
    options?: { cause?: unknown; diagnosticCode?: PlanningAgentDiagnosticCode },
  ) {
    super("infrastructure", message, options);
    this.name = "SubagentNotDispatchedError";
    this.diagnosticCode = options?.diagnosticCode;
  }
}

import type { ArtifactRef } from "../../core/artifacts/references.ts";
import type {
  ProfileStage,
  ResolvedExecutionProfile,
} from "../../core/configuration.ts";
import type { SubagentRunId } from "../../types.ts";
import type {
  AgentLaunchEvidence,
  AgentLaunchPolicy,
} from "../../core/agent-launch.ts";

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
  /** Must persist intent/evidence and State before the adapter may emit spawn. */
  onPrepared?: (launch: AgentLaunchEvidence) => Promise<void>;
  launchPolicy?: AgentLaunchPolicy;
  launch?: AgentLaunchEvidence;
  agent: string;
  /** Logical execution policy; distinct from versioned dispatch node IDs. */
  profileStage?: ProfileStage;
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
  preflight(input: AgentRunRequest): Promise<AgentLaunchEvidence>;
  run(input: AgentRunRequest): Promise<AgentRunResult>;
  runParallel(inputs: AgentRunRequest[]): Promise<AgentRunResult[]>;
  status(
    runId: SubagentRunId,
    receipt?: AgentRunReceipt,
  ): Promise<AgentRunStatus>;
  resume(runId: SubagentRunId, task: string): Promise<AgentRunResult>;
}
