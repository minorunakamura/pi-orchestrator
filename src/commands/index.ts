import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { OrchestratorConfiguration } from "../core/configuration.ts";
import type { WorkflowState } from "../core/workflow/state.ts";
import { CommandValidationExecutor } from "../runtime/validation/command-executor.ts";
import { JevIntegration } from "../runtime/integrations/jev.ts";
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
  type EventBus,
} from "../runtime/integrations/subagents.ts";
import {
  resumeWorkflow,
  type ResumeWorkflowResult,
} from "../runtime/orchestrator/resume-workflow.ts";
import {
  startWorkflow,
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
  readStatusEvidence?: (
    state: WorkflowState,
  ) => Promise<WorkflowStatusEvidence>;
}

export interface WorkflowCommandRuntimeOptions {
  projectTrusted?: boolean;
  configuration?: OrchestratorConfiguration;
  jevDecisionClient?: JevDecisionClient;
  validationExecutor?: ValidationExecutor;
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

export function parseWorkflowId(args: string): string {
  const values = args.trim().split(/\s+/u).filter(Boolean);
  const workflowId = values[0];
  if (
    values.length !== 1 ||
    !workflowId ||
    !workflowIdPattern.test(workflowId)
  ) {
    throw new WorkflowCommandInputError(
      "Usage: /wf-resume <workflow-id> (a safe non-empty path segment)",
    );
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
    return createWorkflowCommandRuntime(
      options.eventBus,
      context.cwd,
      options.runtimeOptions,
    );
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
        const task = normalizeWorkflowTask(args);
        const result = await commandRuntime(context, options).start({
          task,
          playbook,
        });
        context.ui.notify(
          `Workflow ${result.workflowId} started (${result.state.phase})`,
          "info",
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
        const workflowId = parseWorkflowId(args);
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

export function createWorkflowCommandRuntime(
  events: EventBus,
  cwd: string,
  options: WorkflowCommandRuntimeOptions = {},
): WorkflowCommandRuntime {
  const root = runsDirectory(cwd);
  const configuration = options.configuration;
  return {
    start: (input) => {
      const workflowId = randomUUID();
      const artifactStore = new ArtifactStore(join(root, workflowId));
      return startWorkflow(
        { ...input, cwd: input.cwd ?? cwd },
        {
          runsDirectory: root,
          workflowIdFactory: () => workflowId,
          artifactStore,
          subagentExecutor: new SubagentsIntegration(events, {
            cwd,
            projectTrusted: options.projectTrusted,
            ownerRunId: workflowId,
            artifactReader: artifactStore,
          }),
        },
      );
    },
    resume: (workflowId) => {
      const artifactStore = new ArtifactStore(join(root, workflowId));
      return resumeWorkflow(workflowId, {
        runsDirectory: root,
        artifactStore,
        subagentExecutor: new SubagentsIntegration(events, {
          cwd,
          projectTrusted: options.projectTrusted,
          ownerRunId: workflowId,
          artifactReader: artifactStore,
        }),
        cwd,
        repositoryCwd: cwd,
        configuration,
        jevDecisionClient:
          options.jevDecisionClient ?? new JevIntegration(configuration?.jev),
        validationExecutor:
          options.validationExecutor ?? new CommandValidationExecutor(),
        plannotatorGate: new PlannotatorIntegration({
          events,
          planReader: artifactStore,
        }),
      });
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
