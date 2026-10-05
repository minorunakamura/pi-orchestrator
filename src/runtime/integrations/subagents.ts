import {
  PLAN_DEVIATION_MARKER,
  deviationCategories,
  type PlanDeviationBinding,
} from "../../core/coding/plan-deviation.ts";
import type { DevelopmentMethod } from "../../core/decisions/planning-routing.ts";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  agentLaunchPolicy,
  type AgentLaunchEvidence,
} from "../../core/agent-launch.ts";
import {
  resolveAgentLaunch,
  restrictAgentLaunch,
  type AgentLaunchHost,
  type LaunchResolver,
} from "./subagent-launch.ts";
import type { ArtifactRef } from "../../core/artifacts/references.ts";
import {
  resolveStageProfile,
  type OrchestratorConfiguration,
  type ResolvedExecutionProfile,
} from "../../core/configuration.ts";
import { isRecord } from "../../core/schema.ts";
import { subagentRunId, type SubagentRunId } from "../../types.ts";
import type { ArtifactStore } from "../persistence/artifact-store.ts";
import {
  captureRunReceipt,
  agentOutputPath,
  prepareAgentOutput,
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
  deviationBinding?: PlanDeviationBinding;
  developmentMethod?: DevelopmentMethod;
  testSeams?: string;
  developmentMethodRef?: ArtifactRef<"development-method">;
  approvedPlanRef: ArtifactRef<"plan">;
  contextRefs: readonly ArtifactRef[];
  executionProfile: ResolvedExecutionProfile;
  acceptedFindingsRef?: ArtifactRef<"accepted-findings">;
  humanCodeFeedbackRef?: ArtifactRef<"code-review">;
  /** Selected by approved method authority, not ambient skill inheritance. */
  skills?: readonly string[];
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
    ...(input.developmentMethodRef ? [input.developmentMethodRef] : []),
    ...(input.acceptedFindingsRef ? [input.acceptedFindingsRef] : []),
    ...(input.humanCodeFeedbackRef ? [input.humanCodeFeedbackRef] : []),
  ];
  const tdd = input.developmentMethod === "TDD";
  if (tdd && !input.testSeams?.trim())
    throw Error("TDD Worker requires approved Test Seams");
  const skills = tdd ? ["tdd", ...(input.skills ?? [])] : (input.skills ?? []);
  if (!tdd && skills.includes("tdd"))
    throw Error("STANDARD Worker cannot select tdd");
  return {
    agent: "worker",
    launchPolicy: agentLaunchPolicy("worker", input.executionProfile, [
      ...new Set(skills),
    ]),
    task: `${options.task ?? defaultWorkerTask}\nThe exact approved Plan contents supplied below are the strategy/constraint authority, not a detailed execution recipe. Private helpers, local naming, test helpers and equivalent small internal organization are allowed without reapproval if they preserve that boundary. Accepted findings and Human Code feedback cannot expand it. Before knowingly introducing an unauthorized component/dependency, public API or repository/domain boundary change, persistence/integration change, scope expansion, method/seam/Validation change, STOP ALL mutation. Do not implement the proposed deviation or ask another Agent/Oracle to authorize it. Finish with ONLY ${PLAN_DEVIATION_MARKER} followed by a newline and JSON (no fences): ${JSON.stringify({ schemaVersion: 1, ...input.deviationBinding, category: deviationCategories.join(" | "), reason: "why continuation is unsafe", constraint: "verbatim approved Plan excerpt", proposedChange: "material change needed but NOT implemented", localAlternative: "safe narrower option or why unavailable", evidence: ["repository path:line and observed facts"] })}. Use one listed category, nonempty fields <=2000 chars, 1-8 evidence entries, total <=16000 chars. This is a stop/evidence request, not successful implementation. Existing authorized changes may remain; report them and do not rollback blindly. Oracle advice cannot approve this request; a new Plan, fresh simplicity review and Human Plan Gate are required.${tdd ? `\nDevelopment Method: TDD. Read and follow the explicitly selected upstream tdd skill before writing tests.${skills.includes("codebase-design") ? " Read codebase-design for the approved seam/interface vocabulary." : ""}\nHuman Plan approval already confirms these exact Test Seams; do not invent other seams or ask for implicit approval:\n${input.testSeams}\nTest public observable behavior only; do not test private helpers or internal collaborator calls. Work in vertical RED -> minimal GREEN -> next vertical slice: one failing test, observed failure, minimal implementation, observed pass. Never write all tests then all implementation. Report each slice's approved seam, test, observed RED and GREEN commands/results in the implementation evidence. A required method/seam change must stop for Human replanning. TDD never replaces the approved deterministic Validation Contract.` : "\nDevelopment Method: STANDARD. Do not load ambient tdd guidance; preserve the approved Validation Contract."}`,
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
  configuration?: OrchestratorConfiguration;
  artifactReader?: ArtifactReader;
  ownerRunId?: string;
  cwd?: string;
  /** Host trust decision; unknown trust excludes project Agent definitions/overrides. */
  projectTrusted?: boolean;
  timeoutMs?: number;
  launchHost?: AgentLaunchHost;
  /** Test seam; production uses the released public preflight resolver. */
  launchResolver?: LaunchResolver;
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
  private readonly projectTrusted: boolean;
  private readonly artifactReader: ArtifactReader | undefined;

  constructor(
    private readonly events: EventBus,
    private readonly options: SubagentsIntegrationOptions = {},
  ) {
    this.artifactReader = options.artifactReader;
    this.ownerRunId = options.ownerRunId ?? randomUUID();
    this.cwd = options.cwd ?? process.cwd();
    this.projectTrusted =
      options.launchHost?.projectTrusted ?? options.projectTrusted === true;
    if (
      options.launchHost &&
      options.projectTrusted !== undefined &&
      options.projectTrusted !== options.launchHost.projectTrusted
    )
      throw Error("Host launch trust snapshot mismatch");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      this.timeoutMs > 2_147_483_647
    )
      throw new Error("Subagent timeout must be a positive finite integer");
  }

  private async resolveLaunch(
    input: AgentRunRequest,
  ): Promise<AgentLaunchEvidence> {
    try {
      const output =
        input.onStarted && this.artifactReader?.rootDirectory && input.dispatch
          ? agentOutputPath(
              this.artifactReader.rootDirectory,
              input.dispatch.requestId,
            )
          : false;
      return await (this.options.launchResolver ?? resolveAgentLaunch)(input, {
        task: await taskWithArtifacts(input, this.artifactReader),
        cwd: input.cwd ?? this.cwd,
        output,
        ...(output
          ? {
              sessionDir: join(
                dirname(output),
                `session-${input.dispatch!.requestId}`,
              ),
            }
          : {}),
        host: this.options.launchHost,
      });
    } catch (cause) {
      if (cause instanceof SubagentNotDispatchedError) throw cause;
      throw new SubagentNotDispatchedError("Agent launch preflight rejected", {
        cause,
        diagnosticCode: "preflight-exception",
      });
    }
  }

  private restrict(input: AgentRunRequest) {
    try {
      return restrictAgentLaunch(input, this.options.launchHost);
    } catch (cause) {
      throw new SubagentNotDispatchedError(
        "Invalid Agent launch policy/ceiling",
        { cause, diagnosticCode: "invalid-launch-policy" },
      );
    }
  }

  private stageRequest(input: AgentRunRequest): AgentRunRequest {
    const configuration = this.options.configuration;
    // Worker profiles are bound to approved dynamic routing, never stage defaults.
    if (!configuration || input.agent === "worker") return input;
    const agents = {
      scout: "workflow-scout",
      diagnosis: "workflow-scout",
      research: "pi-ketch.researcher",
      planning: "planner",
      "plan-simplicity": "plan-simplicity-reviewer",
      "correctness-review": "reviewer",
      "ponytail-review": "ponytail-reviewer",
      oracle: "oracle",
    } as const;
    const stage = input.profileStage;
    if (!stage || agents[stage] !== input.agent)
      throw new SubagentNotDispatchedError(
        "Explicit matching stage profile required",
        {
          diagnosticCode: "invalid-launch-policy",
        },
      );
    const executionProfile = resolveStageProfile(configuration, stage);
    return {
      ...input,
      executionProfile,
      launchPolicy: {
        ...(input.launchPolicy ?? agentLaunchPolicy(input.agent)),
        executionProfile,
      },
    };
  }

  async preflight(input: AgentRunRequest): Promise<AgentLaunchEvidence> {
    input = this.stageRequest(input);
    const restriction = this.restrict(input);
    try {
      return await this.resolveLaunch(input);
    } finally {
      restriction?.dispose();
    }
  }

  async run(input: AgentRunRequest): Promise<AgentRunResult> {
    input = this.stageRequest(input);
    const restriction = this.restrict(input);
    try {
      return await this.runRestricted(input);
    } finally {
      restriction?.dispose();
    }
  }

  private async runRestricted(input: AgentRunRequest): Promise<AgentRunResult> {
    const requestId = input.dispatch?.requestId ?? randomUUID();
    const dispatch = input.dispatch ?? {
      requestId,
      ownerRunId: this.ownerRunId,
      nodeId: `worker-${requestId}`,
      deadline: new Date(Date.now() + this.timeoutMs).toISOString(),
    };
    input = { ...input, dispatch };
    const task = await taskWithArtifacts(input, this.artifactReader);
    const launch = await this.resolveLaunch(input);
    // Only the adopted role's exact child replacement is verified by the common
    // resolver; other Codemode inspection policies remain unsupported for dispatch.
    const codemode = launch.policy.allowedTools.includes("codemode");
    if (
      (launch.tools.includes("codemode") || codemode) &&
      launch.agent !== "plan-simplicity-reviewer"
    )
      throw new SubagentNotDispatchedError(
        "Codemode runtime isolation is unverified (#20); inspection does not permit dispatch",
      );
    if (input.launch && JSON.stringify(input.launch) !== JSON.stringify(launch))
      throw new SubagentNotDispatchedError(
        "Agent launch changed after durable preflight",
      );
    if (!input.onPrepared)
      throw new SubagentNotDispatchedError(
        "Durable launch evidence callback required",
      );
    try {
      await input.onPrepared(launch);
    } catch (cause) {
      throw new SubagentNotDispatchedError(
        "Unable to persist launch evidence",
        { cause },
      );
    }
    if (
      JSON.stringify(await this.resolveLaunch(input)) !== JSON.stringify(launch)
    )
      throw new SubagentNotDispatchedError(
        "Launch drift during evidence persistence; no child was dispatched",
      );
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
      agentScope: this.projectTrusted ? "both" : "user",
      task,
      context: "fresh",
      cwd: input.cwd ?? this.cwd,
      async: true,
      // Keep a literal full text result, regardless of agent output defaults.
      output: outputPath ?? false,
      outputMode: "inline",
      ...(outputPath
        ? { sessionDir: join(dirname(outputPath), `session-${requestId}`) }
        : {}),
      outputSchema: false,
      acceptance: false,
      // Pin the physical result, including evidence/review roles following host defaults.
      model: `${launch.model}:${launch.thinking}`,
      skill: [...launch.policy.skills],
      intercomBridge: { mode: "off" },
      reads: false,
      progress: false,
      timeoutMs,
      ...(codemode ? { toolTimeoutMs: 30_000 } : {}),
    };
    return this.spawnAndWait(
      dispatch,
      params,
      input.agent,
      timeoutMs,
      input.onStarted,
      launch.launchContractDigest,
    );
  }

  async runParallel(inputs: AgentRunRequest[]): Promise<AgentRunResult[]> {
    // Reject a missing static sibling before any child side effect. Each run still
    // resolves and rechecks its exact launch around durable evidence persistence.
    const preflight = await Promise.allSettled(
      inputs.map((input) => this.preflight(input)),
    );
    for (const checked of preflight) {
      if (checked.status === "rejected") throw checked.reason;
    }
    const settled = await Promise.allSettled(
      inputs.map((input) => this.run(input)),
    );
    return settled.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
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
    expectedDigest?: string,
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
                const recovered = await recoverAgentRun(
                  savedReceipt,
                  this.artifactReader.rootDirectory,
                );
                if (
                  recovered.status !== "succeeded" ||
                  recovered.result?.status !== "succeeded"
                )
                  throw Error(
                    "Terminal child status/output does not match the historical receipt",
                  );
                result = { ...result, output: recovered.result.output };
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
              const digestMatches =
                details.launchContractDigest === expectedDigest;
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
                  if (!digestMatches)
                    throw Error("Actual launch digest differs from preflight");
                })();
                void receiptSaved.catch(() =>
                  finish({
                    status: "ambiguous",
                    reason: "Unable to persist child launch receipt",
                  }),
                );
              }
              if (!digestMatches) {
                finish({
                  status: "ambiguous",
                  reason:
                    "Actual launch digest differs from durable preflight; do not relaunch",
                });
                return;
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
