import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { physicalModelSnapshot } from "./runtime/integrations/subagent-launch.ts";
import {
  createWorkflowCommandRuntime,
  registerWorkflowCommands,
  disposeWorkflowContinuations,
  renderWorkflowCommandError,
} from "./commands/index.ts";
import { loadProductionConfiguration } from "./runtime/configuration/load-configuration.ts";

// Composition callers supply the host event bus, ArtifactStore reader, and
// workflow-scoped options. Importing these adapters does not dispatch work.
export {
  createWorkflowCommandRuntime,
  type WorkflowCommandRuntime,
} from "./commands/index.ts";
export { SubagentsIntegration } from "./runtime/integrations/subagents.ts";
export {
  JevIntegration,
  PiClassifierDecisionClient,
} from "./runtime/integrations/jev.ts";
export type { DecisionClassifierPort } from "./runtime/ports/jev-decision-client.ts";
export {
  requestOracleAdvice,
  runOracleAdvice,
  freshOracleAdvice,
  type OracleQuestion,
} from "./runtime/orchestrator/oracle-advisory.ts";
export {
  oracleReasons,
  ORACLE_MAX_ATTEMPTS,
  ORACLE_TIMEOUT_MS,
} from "./core/oracle.ts";
export { PlannotatorIntegration } from "./runtime/integrations/plannotator.ts";
export {
  driveWorkflow,
  type WorkflowDriverDependencies,
} from "./runtime/orchestrator/drive-workflow.ts";
export {
  resumeWorkflow,
  reconcileWorkflow,
  WorkflowController,
  type ResumeWorkflowInput,
  type ResumeWorkflowOptions,
  type ResumeWorkflowResult,
} from "./runtime/orchestrator/resume-workflow.ts";

export default function piOrchestrator(pi: ExtensionAPI): void {
  // Agent discovery is manifest-owned. Registration is inert; runtime work
  // starts only from an explicit command invocation.
  pi.on("session_shutdown", async () =>
    disposeWorkflowContinuations(pi.events),
  );
  registerWorkflowCommands(pi, {
    createRuntime: (context) =>
      createWorkflowCommandRuntime(pi.events, context.cwd, {
        projectTrusted: context.isProjectTrusted(),
        modelRegistry: context.modelRegistry,
        onContinuationError: (error) =>
          context.ui.notify(renderWorkflowCommandError(error), "error"),
        launchHost: {
          sessionId: context.sessionManager.getSessionId(),
          projectTrusted: context.isProjectTrusted(),
          availableModels: physicalModelSnapshot(context.modelRegistry),
          parentModel: context.model,
          scopedModelIds: context.scopedModels.map(
            ({ model }) => `${model.provider}/${model.id}`,
          ),
          runtimeSnapshotHost: pi,
        },
        configuration: loadProductionConfiguration(context.cwd, {
          projectTrusted: context.isProjectTrusted(),
        }),
      }),
  });
}
