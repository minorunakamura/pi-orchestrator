import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../core/schema.ts";
import { join } from "node:path";
import { ArtifactStore } from "../persistence/artifact-store.ts";
import { planningInputDiagnostic } from "../orchestrator/planning-routing.ts";
import { isWorkflowId } from "../../types.ts";
import { isArtifactRef } from "../../core/artifacts/references.ts";
import { sameArtifactRef } from "../../core/workflow/invariants.ts";
import type { WorkflowState } from "../../core/workflow/state.ts";
import {
  WorkflowOwnership,
  type OwnershipHint,
} from "../orchestrator/workflow-ownership.ts";

export const OWNERSHIP_SESSION_ENTRY = "orchestrator-workflow-owner";

/** Session entries are deny/reconciliation breadcrumbs, never execution authority. */
export function registerWorkflowOwnership(pi: ExtensionAPI) {
  const sessions = new Map<string, Map<string, OwnershipHint>>();
  const hints = (ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    let known = sessions.get(sessionId);
    if (!known) sessions.set(sessionId, (known = new Map()));
    for (const entry of ctx.sessionManager.getEntries()) {
      if (
        entry.type !== "custom" ||
        entry.customType !== OWNERSHIP_SESSION_ENTRY
      )
        continue;
      const data = entry.data;
      if (
        !isRecord(data) ||
        !isWorkflowId(data.workflowId) ||
        typeof data.projectRoot !== "string" ||
        (data.ownershipRef !== undefined &&
          (!isArtifactRef(data.ownershipRef) ||
            data.ownershipRef.kind !== "reconciliation"))
      )
        throw Error("Invalid persisted host ownership breadcrumb");
      const hint: OwnershipHint = {
        workflowId: data.workflowId,
        projectRoot: data.projectRoot,
        ...(data.ownershipRef
          ? {
              ownershipRef: {
                ...data.ownershipRef,
                kind: "reconciliation" as const,
              },
            }
          : {}),
      };
      known.set(`${hint.projectRoot}\0${hint.workflowId}`, hint);
    }
    return known;
  };
  const remember = (ctx: ExtensionContext, state: WorkflowState) => {
    const known = hints(ctx);
    const key = `${state.projectRoot}\0${state.workflowId}`;
    const previous = known.get(key);
    if (
      previous?.ownershipRef &&
      state.ownershipRef &&
      !sameArtifactRef(previous.ownershipRef, state.ownershipRef)
    )
      throw Error("Host ownership identity cannot be replaced");
    const hint: OwnershipHint = {
      workflowId: state.workflowId,
      projectRoot: state.projectRoot,
      ...(state.ownershipRef ? { ownershipRef: state.ownershipRef } : {}),
    };
    if (JSON.stringify(previous) === JSON.stringify(hint)) return;
    pi.appendEntry(OWNERSHIP_SESSION_ENTRY, hint);
    known.set(key, hint);
  };
  const boundary = (ctx: ExtensionContext) =>
    new WorkflowOwnership(ctx.cwd, ctx.sessionManager.getSessionId(), {
      known: () => [...hints(ctx).values()],
      remember: (state) => remember(ctx, state),
    });
  const ownedClarification = new Set([
    "wf_clarification_round",
    "wf_clarification_complete",
  ]);
  const inspect = (ctx: ExtensionContext) => boundary(ctx).active();
  pi.on("session_start", async (_event, ctx) => {
    await inspect(ctx);
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    await inspect(ctx);
  });
  // Completion wakes need request-local context, not only ordinary startup checks.
  // This transient explanation is not authority; tool_call still enforces the boundary.
  pi.on("context", async (event, ctx) => {
    const owners = await inspect(ctx);
    if (!owners.length) return undefined;
    const state = owners.length === 1 ? owners[0] : undefined;
    const diagnostic = state
      ? await planningInputDiagnostic(
          state,
          new ArtifactStore(
            join(ctx.cwd, ".pi", "orchestrator", "runs", state.workflowId),
          ),
        )
      : undefined;
    return {
      messages: [
        ...event.messages,
        {
          role: "custom" as const,
          customType: "orchestrator-ownership-context",
          display: false,
          timestamp: Date.now(),
          content: `Active Workflow owns this workspace. Current controller state: ${JSON.stringify(state ? { workflowId: state.workflowId, phase: state.phase, reason: state.block?.reason, diagnostic } : { conflict: true })}. You are Main, not Worker. Background child completion is evidence for the controller, not a request to implement or take over. Raw tools (including read, bash, children, MCP and questions) are denied. Do not try or retry them, guess requestHash, or infer approval. Human chat remains available; this current persisted state supersedes older tool transition snapshots. When blocked, report this state and stop; include its diagnostic. While the driver is progressing, do not describe a transition snapshot as a stopped Workflow. The Human may use /wf-status. Only during clarifying, follow the exact Orchestrator-owned request using wf_clarification_round / wf_clarification_complete. A verified request restored from durable State is the active request; a new notification is not required; without that request, do not initiate clarification or invent answers. This status grants no mutation or Human Gate authority.`,
        },
      ],
    };
  });
  pi.on("tool_call", async (event, ctx) => {
    try {
      const owners = await inspect(ctx);
      if (!owners.length) return undefined;
      // Execute revalidates effective inputs; later hook mutations cannot widen permission.
      if (
        owners.length === 1 &&
        owners[0].ownershipRef &&
        owners[0].phase === "clarifying" &&
        ownedClarification.has(event.toolName)
      )
        return undefined;
      return {
        block: true,
        reason:
          "Active workflow owns this workspace; Main tools cannot implement or launch bypass children. Do not retry tools. Human interaction and /wf-status remain available; the clarification bridge requires phase=clarifying and an exact owned request.",
      };
    } catch {
      return {
        block: true,
        reason: "Workflow ownership observation unavailable; execution denied",
      };
    }
  });
  pi.on("user_bash", async (_event, ctx) => {
    try {
      if (!(await inspect(ctx)).length) return undefined;
    } catch {
      /* Missing/corrupt ownership is not permission to execute a shell. */
    }
    return {
      result: {
        output:
          "Active workflow owns this workspace; root shell execution denied",
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    };
  });
  pi.on("session_shutdown", () => {
    sessions.clear();
  });
  return boundary;
}
