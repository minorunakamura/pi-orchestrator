import type {
  WorkflowEvent,
  WorkflowState,
} from "../../core/workflow/state.ts";
import { transition } from "../../core/workflow/transition.ts";

export interface WorkflowStateWriter {
  saveState(
    state: WorkflowState,
    expectedRevision?: number,
    options?: { lockHeld?: boolean },
  ): Promise<WorkflowState>;
}

/** Apply one domain event, then persist the resulting State before any caller continues. */
export async function advanceWorkflow(
  state: WorkflowState,
  event: WorkflowEvent,
  stateStore: WorkflowStateWriter,
): Promise<WorkflowState> {
  const result = transition(state, event);
  if (!result.ok) throw result.error;
  return stateStore.saveState(result.state, state.stateRevision);
}

export const persistTransition = advanceWorkflow;
