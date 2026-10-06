import type { HumanQuestionPort } from "../runtime/integrations/ask-user-question.ts";
import { parsePlanningDecisionArtifact } from "../core/decisions/planning-routing.ts";
import { researchRoutingDiagnostic } from "../runtime/orchestrator/research-selection.ts";
import { WorkflowOwnership } from "../runtime/orchestrator/workflow-ownership.ts";
import { CLARIFICATION_COMPLETE_EVENT } from "../runtime/integrations/clarification.ts";
import type { ClarificationPort } from "../runtime/ports/clarification-port.ts";
import {
  requestOracleAdvice,
  type OracleQuestion,
} from "../runtime/orchestrator/oracle-advisory.ts";
import { randomUUID } from "node:crypto";
import { driveWorkflow } from "../runtime/orchestrator/drive-workflow.ts";
import type {
  AgentLaunchHost,
  LaunchResolver,
} from "../runtime/integrations/subagent-launch.ts";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { OrchestratorConfiguration } from "../core/configuration.ts";
import type { WorkflowState } from "../core/workflow/state.ts";
import { CommandValidationExecutor } from "../runtime/validation/command-executor.ts";
import {
  JevIntegration,
  type PiClassifierRuntime,
} from "../runtime/integrations/jev.ts";
import { PlannotatorIntegration } from "../runtime/integrations/plannotator.ts";
import type {
  JevDecisionClient,
  ValidationExecutor,
} from "../runtime/ports/index.ts";
import {
  projectWorkflowStatus,
  renderWorkflowStatus,
  type WorkflowStatusEvidence,
} from "../ui/workflow-status.ts";
import {
  StateNotFoundError,
  StateStore,
} from "../runtime/persistence/state-store.ts";
import { ArtifactStore } from "../runtime/persistence/artifact-store.ts";
import { parseWorkerAttempt } from "../runtime/worker/attempt-evidence.ts";
import {
  SubagentsIntegration,
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  type EventBus,
} from "../runtime/integrations/subagents.ts";
import {
  resumeWorkflow,
  type ResumeWorkflowResult,
} from "../runtime/orchestrator/resume-workflow.ts";
import {
  createWorkflow,
  type StartWorkflowInput,
  type StartedWorkflow,
} from "../runtime/orchestrator/start-workflow.ts";

export const workflowCommandNames = [
  "wf-new",
  "wf-feature",
  "wf-bugfix",
  "wf-hotfix",
  "wf-chore",
  "wf-resume",
  "wf-status",
] as const;

export type WorkflowCommandName = (typeof workflowCommandNames)[number];

export class WorkflowCommandInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowCommandInputError";
  }
}

export interface WorkflowCommandRuntime {
  start: (input: StartWorkflowInput) => Promise<StartedWorkflow>;
  resume: (workflowId: string) => Promise<ResumeWorkflowResult>;
  loadState: (workflowId: string) => Promise<WorkflowState>;
  advise?: (
    workflowId: string,
    question: OracleQuestion,
  ) => Promise<ResumeWorkflowResult>;
  readStatusEvidence?: (
    state: WorkflowState,
  ) => Promise<WorkflowStatusEvidence>;
}

export interface WorkflowCommandRuntimeOptions {
  ownership?: WorkflowOwnership;
  launchHost?: AgentLaunchHost;
  launchResolver?: LaunchResolver;
  projectTrusted?: boolean;
  configuration?: OrchestratorConfiguration;
  jevDecisionClient?: JevDecisionClient;
  modelRegistry?: PiClassifierRuntime;
  validationExecutor?: ValidationExecutor;
  clarificationPort?: ClarificationPort;
  humanQuestionPort?: HumanQuestionPort;
  onContinuationResult?: (result: ResumeWorkflowResult) => void;
  onContinuationError?: (error: unknown) => void;
}

export interface WorkflowCommandRegistrationOptions {
  runtime?: WorkflowCommandRuntime;
  createRuntime?: (context: ExtensionCommandContext) => WorkflowCommandRuntime;
  eventBus?: EventBus;
  runtimeOptions?: WorkflowCommandRuntimeOptions;
}

const workflowIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const runsDirectoryName = [".pi", "orchestrator", "runs"] as const;
const sensitiveIdentityValue =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[oprs]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/giu;

export function normalizeWorkflowTask(args: string): string {
  const task = args.trim();
  if (task.length === 0) {
    throw new WorkflowCommandInputError("Usage: /wf-<playbook> <task>");
  }
  return task;
}

export function parseWorkflowTask(
  args: string,
): Pick<StartWorkflowInput, "task" | "developmentIntent"> {
  const normalized = normalizeWorkflowTask(args);
  const flag = /^(--tdd|--behavior-free)(?:\s+|$)/u.exec(normalized)?.[1];
  if (!flag) return { task: normalized };
  const task = normalizeWorkflowTask(normalized.slice(flag.length));
  if (/^--(?:tdd|behavior-free)(?:\s|$)/u.test(task))
    throw new WorkflowCommandInputError(
      "Choose only one Development Intent flag",
    );
  return {
    task,
    developmentIntent: flag === "--tdd" ? "TDD" : "BEHAVIOR_FREE",
  };
}

export function parseWorkflowId(
  args: string,
  command: "wf-resume" | "wf-status" = "wf-resume",
): string {
  const values = args.trim().split(/\s+/u).filter(Boolean);
  const workflowId = values[0];
  if (
    values.length !== 1 ||
    !workflowId ||
    !workflowIdPattern.test(workflowId)
  ) {
    throw new WorkflowCommandInputError(`Usage: /${command} <workflow-id>`);
  }
  return workflowId;
}

function runsDirectory(cwd: string): string {
  return join(cwd, ...runsDirectoryName);
}

function isMissingWorkflowError(error: unknown): boolean {
  if (error instanceof StateNotFoundError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /ENOENT|does not exist/iu.test(message);
}

function redactSecrets(message: string): string {
  return message
    .replace(/Bearer\s+[^\s,;]+/giu, "Bearer [redacted]")
    .replace(
      /((?:api[_-]?key|auth(?:orization)?|credential|password|secret|token)\s*[:=]\s*)([^\s,;]+)/giu,
      "$1[redacted]",
    )
    .replace(sensitiveIdentityValue, "[redacted]")
    .replace(/https?:\/\/[^/\s:@]+:[^@\s]+@/giu, "https://[redacted]@");
}

export function renderWorkflowCommandError(error: unknown): string {
  if (error instanceof WorkflowCommandInputError) return error.message;
  if (isMissingWorkflowError(error)) return "Workflow state was not found";
  const message = error instanceof Error ? error.message : String(error);
  return `Workflow command failed: ${redactSecrets(message)}`;
}

function commandRuntime(
  context: ExtensionCommandContext,
  options: WorkflowCommandRegistrationOptions,
): WorkflowCommandRuntime {
  if (options.runtime) return options.runtime;
  if (options.createRuntime) return options.createRuntime(context);
  if (options.eventBus)
    return createWorkflowCommandRuntime(options.eventBus, context.cwd, {
      ...options.runtimeOptions,
      modelRegistry: context.modelRegistry,
      onContinuationError: (error) =>
        context.ui.notify(renderWorkflowCommandError(error), "error"),
    });
  throw new Error("Workflow command runtime is not configured");
}

async function runCommand(
  context: ExtensionCommandContext,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    context.ui.notify(renderWorkflowCommandError(error), "error");
  }
}

function registerStartCommand(
  pi: Pick<ExtensionAPI, "registerCommand">,
  name: Exclude<WorkflowCommandName, "wf-resume" | "wf-status">,
  playbook: StartWorkflowInput["playbook"],
  options: WorkflowCommandRegistrationOptions,
): void {
  pi.registerCommand(name, {
    description: `Start a ${playbook} workflow`,
    handler: async (args, context) =>
      runCommand(context, async () => {
        const task = parseWorkflowTask(args);
        const runtime = commandRuntime(context, options);
        const result = await runtime.start({
          ...task,
          playbook,
        });
        const evidence =
          result.state.phase === "blocked" && runtime.readStatusEvidence
            ? await runtime.readStatusEvidence(result.state)
            : undefined;
        context.ui.notify(
          `Workflow ${result.workflowId} started (${result.state.phase})${evidence?.routingDiagnostic ? `\n${evidence.routingDiagnostic}` : ""}`,
          result.state.phase === "blocked" ? "warning" : "info",
        );
      }),
  });
}

export function registerWorkflowCommands(
  pi: Pick<ExtensionAPI, "registerCommand">,
  options: WorkflowCommandRegistrationOptions = {},
): void {
  registerStartCommand(pi, "wf-new", "new-project", options);
  registerStartCommand(pi, "wf-feature", "feature", options);
  registerStartCommand(pi, "wf-bugfix", "bugfix", options);
  registerStartCommand(pi, "wf-hotfix", "hotfix", options);
  registerStartCommand(pi, "wf-chore", "chore", options);

  pi.registerCommand("wf-resume", {
    description: "Reconcile and resume a workflow",
    handler: async (args, context) =>
      runCommand(context, async () => {
        const workflowId = parseWorkflowId(args);
        const result = await commandRuntime(context, options).resume(
          workflowId,
        );
        const reason = result.reason ? `: ${result.reason}` : "";
        context.ui.notify(
          `Workflow ${workflowId}: ${result.status} (${result.phase})${reason}`,
          result.status === "failed" || result.status === "blocked"
            ? "warning"
            : "info",
        );
      }),
  });

  pi.registerCommand("wf-status", {
    description: "Show workflow status",
    handler: async (args, context) =>
      runCommand(context, async () => {
        const workflowId = parseWorkflowId(args, "wf-status");
        const runtime = commandRuntime(context, options);
        const state = await runtime.loadState(workflowId);
        if (state.workflowId !== workflowId) {
          throw new Error(
            "Persisted Workflow State identity does not match command input",
          );
        }
        const evidence = runtime.readStatusEvidence
          ? await runtime.readStatusEvidence(state)
          : undefined;
        context.ui.notify(
          renderWorkflowStatus(projectWorkflowStatus(state, evidence)),
          "info",
        );
      }),
  });
}

const workflowListeners = new WeakMap<EventBus, Map<string, () => void>>();

export function disposeWorkflowContinuations(events: EventBus): void {
  for (const stop of workflowListeners.get(events)?.values() ?? []) stop();
}

export function createWorkflowCommandRuntime(
  events: EventBus,
  cwd: string,
  options: WorkflowCommandRuntimeOptions = {},
): WorkflowCommandRuntime {
  const root = runsDirectory(cwd);
  // Standalone callers without an installed host boundary cannot execute a workflow.
  const ownership = options.ownership ?? new WorkflowOwnership(cwd, "");
  const configuration = options.configuration;
  const researchDiagnostic = async (
    state: WorkflowState,
  ): Promise<string | undefined> => {
    const ref = state.planning.stageDecisionRefs?.research;
    if (
      state.phase !== "blocked" ||
      state.block?.blockedFrom !== "gathering-context" ||
      !ref ||
      !configuration
    )
      return undefined;
    try {
      const artifact = await new ArtifactStore(
        join(root, state.workflowId),
      ).readJson(ref, parsePlanningDecisionArtifact);
      if (
        artifact.workflowId === state.workflowId &&
        artifact.family === "stage" &&
        artifact.stage === "research" &&
        artifact.outcome === "ESCALATE"
      )
        return researchRoutingDiagnostic(
          artifact,
          configuration.decision.autoDecisionThreshold,
        );
    } catch {
      // Never invent a decision from missing/corrupt display evidence.
    }
    return undefined;
  };
  const dependencies = (workflowId: string) => {
    const artifactStore = new ArtifactStore(join(root, workflowId));
    const stateStore = new StateStore(join(root, workflowId));
    return {
      runsDirectory: root,
      ownership,
      artifactStore,
      stateStore,
      loadState: () => stateStore.loadState(),
      subagentExecutor: new SubagentsIntegration(events, {
        configuration,
        cwd,
        projectTrusted: options.projectTrusted,
        launchHost: options.launchHost,
        launchResolver: options.launchResolver,
        ownerRunId: workflowId,
        artifactReader: artifactStore,
      }),
      cwd,
      repositoryCwd: cwd,
      configuration,
      clarificationPort: options.clarificationPort,
      humanQuestionPort: options.humanQuestionPort,
      jevDecisionClient:
        options.jevDecisionClient ??
        new JevIntegration({
          ...configuration?.jev,
          modelRegistry: options.modelRegistry,
        }),
      validationExecutor:
        options.validationExecutor ?? new CommandValidationExecutor(),
      plannotatorGate: new PlannotatorIntegration({
        events,
        planReader: artifactStore,
      }),
    };
  };
  const watch = (
    workflowId: string,
    deps: ReturnType<typeof dependencies>,
    initial: (signal: AbortSignal) => Promise<ResumeWorkflowResult>,
  ) => {
    const key = join(root, workflowId);
    let listeners = workflowListeners.get(events);
    if (!listeners) workflowListeners.set(events, (listeners = new Map()));
    listeners.get(key)?.();
    let active = true;
    const continuation = new AbortController();
    let queue: Promise<ResumeWorkflowResult>;
    const stop = () => {
      active = false;
      continuation.abort();
      unsubscribe();
      if (listeners.get(key) === stop) listeners.delete(key);
    };
    const settle = async (value: ResumeWorkflowResult) => {
      if (
        value.status === "blocked" ||
        value.status === "failed" ||
        value.state.phase === "completed"
      )
        stop();
      const diagnostic = await researchDiagnostic(value.state);
      return diagnostic
        ? {
            ...value,
            reason: `${value.reason ?? value.state.block?.reason}: ${diagnostic}`,
          }
        : value;
    };
    // Notifications only wake the driver. Exact persisted binding + public status remains authority.
    const wake = (
      payload: unknown,
      kind: "plan" | "oracle" | "clarification",
    ) => {
      if (!payload || typeof payload !== "object") return;
      const identity =
        kind === "plan" && "reviewId" in payload
          ? payload.reviewId
          : kind === "oracle" && "runId" in payload
            ? payload.runId
            : kind === "clarification" &&
                "requestHash" in payload &&
                "workflowId" in payload &&
                payload.workflowId === workflowId
              ? payload.requestHash
              : undefined;
      if (typeof identity !== "string") return;
      queue = queue.then(async (previous) => {
        if (!active) return previous;
        const state = await deps.loadState();
        if (kind === "plan") {
          if (
            state.phase !== "awaiting-plan-review" ||
            state.planning.planReview?.reviewId !== identity
          )
            return previous;
        } else if (kind === "clarification") {
          if (
            state.phase !== "planning" ||
            state.planning.clarificationRequestRef?.sha256 !== identity ||
            !state.planning.context.clarificationRef
          )
            return previous;
        } else if (
          !state.oracle?.pendingRef ||
          state.planning.agentAttempts?.[`oracle-${state.oracle.attemptsUsed}`]
            ?.receipt?.runId !== identity
        )
          return previous;
        const result = await settle(
          await driveWorkflow(workflowId, {
            ...deps,
            signal: continuation.signal,
          }),
        );
        if (result.status === "blocked" || result.status === "failed")
          options.onContinuationResult?.(result);
        return result;
      });
      void queue.catch((error) => {
        stop();
        if (options.onContinuationError) options.onContinuationError(error);
        // Standalone composition has no host UI; still report a redacted continuation failure.
        // oxlint-disable-next-line eslint/no-console
        else console.error(renderWorkflowCommandError(error));
      });
    };
    const unsubscribePlan = events.on("plannotator:review-result", (payload) =>
      wake(payload, "plan"),
    );
    const unsubscribeOracle = events.on(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      (payload) => wake(payload, "oracle"),
    );
    const unsubscribeClarification = events.on(
      CLARIFICATION_COMPLETE_EVENT,
      (payload) => wake(payload, "clarification"),
    );
    const unsubscribe = () => {
      unsubscribePlan();
      unsubscribeOracle();
      unsubscribeClarification();
    };
    listeners.set(key, stop);
    queue = Promise.resolve()
      .then(() => initial(continuation.signal))
      .then(settle);
    return queue.catch((error: unknown) => {
      stop();
      throw error;
    });
  };
  return {
    start: async (input) => {
      const workflowId = randomUUID();
      const deps = dependencies(workflowId);
      let started: StartedWorkflow | undefined;
      const driven = await watch(workflowId, deps, async (signal) => {
        const create = async () => {
          if (input.cwd && input.cwd !== cwd && options.ownership)
            throw Error("Workflow command cannot change the owned workspace");
          const created = await createWorkflow(
            { ...input, cwd: input.cwd ?? cwd },
            { ...deps, workflowIdFactory: () => workflowId },
          );
          created.state = options.ownership
            ? await ownership.initialize(created.state, deps.stateStore)
            : await ownership.validate(created.state, deps.stateStore);
          return created;
        };
        started = await ownership.start(create);
        return driveWorkflow(workflowId, { ...deps, signal });
      });
      return { ...started!, state: driven.state };
    },
    advise: (workflowId, question) => {
      parseWorkflowId(workflowId);
      const deps = dependencies(workflowId);
      return watch(workflowId, deps, async (signal) => {
        await deps.stateStore.withLock(async () => {
          let state = await deps.loadState();
          if (state.workflowId !== workflowId)
            throw Error("Oracle workflow identity mismatch");
          {
            const phase = state.phase;
            state = await ownership.validate(state, {
              saveState: (next, revision) =>
                deps.stateStore.saveState(next, revision, { lockHeld: true }),
            });
            if (phase !== "blocked" && state.phase === "blocked") return state;
          }
          return requestOracleAdvice(state, question, {
            ...deps,
            stateStore: {
              saveState: (next, revision) =>
                deps.stateStore.saveState(next, revision, { lockHeld: true }),
            },
          });
        });
        return driveWorkflow(workflowId, { ...deps, signal });
      });
    },
    resume: (workflowId) => {
      const deps = dependencies(workflowId);
      return watch(workflowId, deps, (signal) =>
        resumeWorkflow(workflowId, { ...deps, signal }),
      );
    },
    loadState: async (workflowId) => {
      const state = await new StateStore(join(root, workflowId)).loadState();
      if (state.workflowId !== workflowId) {
        throw new Error(
          "Persisted Workflow State identity does not match command input",
        );
      }
      return state;
    },
    readStatusEvidence: async (state) => {
      const evidence: WorkflowStatusEvidence = {};
      const diagnostic = await researchDiagnostic(state);
      if (diagnostic) evidence.routingDiagnostic = diagnostic;
      const workerAttemptRef = state.coding.workerAttemptRef;
      if (workerAttemptRef) {
        try {
          const attempt = await new ArtifactStore(
            join(root, state.workflowId),
          ).readJson(workerAttemptRef, parseWorkerAttempt);
          if (
            attempt.workflowId === state.workflowId &&
            attempt.dispatch.ownerRunId === state.workflowId
          ) {
            evidence.worker = {
              requestId: attempt.dispatch.requestId,
              ownerRunId: attempt.dispatch.ownerRunId,
              nodeId: attempt.dispatch.nodeId,
              ...(attempt.runId ? { runId: attempt.runId } : {}),
              launchStatus: attempt.launchStatus,
            };
          }
        } catch {
          // The authoritative State remains renderable when optional evidence
          // cannot be read; the attempt ref is still shown.
        }
      }
      const blockedEvidence = state.block?.evidenceRef;
      const failedEvidence = state.failure?.evidenceRef;
      const reconciliationRef =
        blockedEvidence?.kind === "reconciliation"
          ? blockedEvidence
          : failedEvidence?.kind === "reconciliation"
            ? failedEvidence
            : undefined;
      if (reconciliationRef) {
        evidence.reconciliationRef = {
          kind: "reconciliation",
          path: reconciliationRef.path,
          schemaVersion: reconciliationRef.schemaVersion,
          sha256: reconciliationRef.sha256,
        };
      }
      return evidence;
    },
  };
}
