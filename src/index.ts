import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createWorkflowCommandRuntime,
  registerWorkflowCommands,
} from "./commands/index.ts";

// Composition callers supply the host event bus, ArtifactStore reader, and
// workflow-scoped options. Importing these adapters does not dispatch work.
export { SubagentsIntegration } from "./runtime/integrations/subagents.ts";
export { JevIntegration } from "./runtime/integrations/jev.ts";
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
      createWorkflowCommandRuntime(pi.events, context.cwd),
  });
}
