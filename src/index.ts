import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

export default function piOrchestrator(_pi: ExtensionAPI): void {
  // Agent discovery is manifest-owned. Commands and runtime activation belong
  // to ORCH-019; package loading must not start workflows or external requests.
}
