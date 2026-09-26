import type { ArtifactRef } from "../../core/artifacts/references.ts";
import type { ResolvedExecutionProfile } from "../../core/configuration.ts";
import type { SubagentRunId } from "../../types.ts";

export interface AgentRunRequest {
  agent: string;
  task: string;
  cwd?: string;
  inputRefs?: readonly ArtifactRef[];
  executionProfile?: ResolvedExecutionProfile;
}

export type AgentRunResult =
  | {
      status: "succeeded";
      runId: SubagentRunId;
      output: string;
    }
  | {
      status: "failed";
      runId?: SubagentRunId;
      error: string;
    }
  | {
      status: "ambiguous";
      runId: SubagentRunId;
      reason: string;
    };

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
  status(runId: SubagentRunId): Promise<AgentRunStatus>;
  resume(runId: SubagentRunId, task: string): Promise<AgentRunResult>;
}
