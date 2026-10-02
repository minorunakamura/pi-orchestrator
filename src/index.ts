import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { physicalModelSnapshot } from "./runtime/integrations/subagent-launch.ts";
import {
  createWorkflowCommandRuntime,
  registerWorkflowCommands,
} from "./commands/index.ts";
import { loadProductionConfiguration } from "./runtime/configuration/load-configuration.ts";

// Composition callers supply the host event bus, ArtifactStore reader, and
// workflow-scoped options. Importing these adapters does not dispatch work.
export { SubagentsIntegration } from "./runtime/integrations/subagents.ts";
export {
  JevIntegration,
  PiClassifierDecisionClient,
} from "./runtime/integrations/jev.ts";
export type { DecisionClassifierPort } from "./runtime/ports/jev-decision-client.ts";
export { PlannotatorIntegration } from "./runtime/integrations/plannotator.ts";
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
  registerWorkflowCommands(pi, {
    createRuntime: (context) =>
      createWorkflowCommandRuntime(pi.events, context.cwd, {
        projectTrusted: context.isProjectTrusted(),
        modelRegistry: context.modelRegistry,
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
