import { safeWorkflowId } from "../../src/types.ts";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { configuration } from "./coding-scenario.ts";
import { jevPolicy } from "./jev-policy.ts";
import { FakeJevDecisionClient } from "./index.ts";
import type { PlaybookContext } from "../../src/core/playbooks/policy.ts";
import type { WorkflowState } from "../../src/core/workflow/state.ts";
import {
  startWorkflow as start,
  type StartWorkflowInput,
  type StartWorkflowOptions,
} from "../../src/runtime/orchestrator/start-workflow.ts";

/** Explicit scripted classifier + project grant for unrelated stage/gate fixtures. */
export function planningDependencies(
  state: Pick<WorkflowState, "workflowId" | "projectRoot">,
  choices: PlaybookContext = {},
) {
  return {
    configuration: {
      ...configuration,
      jev: jevPolicy(state.projectRoot),
    },
    jevDecisionClient: new FakeJevDecisionClient({
      stages: {
        research: choices.requiresResearch ? "RUN" : "SKIP",
        clarification: choices.requiresClarification ? "RUN" : "SKIP",
        architecture: choices.requiresArchitecture ? "RUN" : "SKIP",
      },
    }),
  };
}
export async function startWorkflow(
  input: StartWorkflowInput,
  options: StartWorkflowOptions,
) {
  const workflowId = options.workflowIdFactory?.() ?? randomUUID();
  const deps = planningDependencies(
    {
      workflowId: safeWorkflowId(workflowId),
      projectRoot: resolve(input.cwd ?? process.cwd()),
    },
    input.context,
  );
  const result = await start(input, {
    ...deps,
    ...options,
    workflowIdFactory: () => workflowId,
  });
  return { ...result, ...deps };
}
