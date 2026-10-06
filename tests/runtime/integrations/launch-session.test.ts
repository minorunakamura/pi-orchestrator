import { expect, test, vi } from "vitest";
import {
  registerSubagentCapabilityCeiling,
  resolveCurrentSubagentCapabilityCeiling,
} from "pi-subagents/capability-ceiling";
import piOrchestrator from "../../../src/index.ts";
import {
  createWorkflowCommandRuntime,
  registerWorkflowCommands,
} from "../../../src/commands/index.ts";
import { agentLaunchPolicy } from "../../../src/core/agent-launch.ts";
import { restrictAgentLaunch } from "../../../src/runtime/integrations/subagent-launch.ts";
import { configuration } from "../../fakes/coding-scenario.ts";
import {
  makeExtensionApiFixture,
  makeExtensionCommandContextFixture,
} from "../../fakes/typed-boundaries.ts";

vi.mock("../../../src/commands/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/commands/index.ts")>()),
  registerWorkflowCommands: vi.fn(),
  createWorkflowCommandRuntime: vi.fn(),
}));
vi.mock("../../../src/runtime/configuration/load-configuration.ts", () => ({
  loadProductionConfiguration: () => configuration,
}));

test.each(["/tmp/pi-launch/session.jsonl", undefined])(
  "production launch ceiling uses the RPC identity (%s), not the ownership UUID",
  (sessionFile) => {
    vi.clearAllMocks();
    const sessionId = "root-session-uuid";
    const rpcIdentity = sessionFile ?? sessionId;
    const pi = makeExtensionApiFixture({
      on: vi.fn(),
      registerTool: vi.fn(),
      events: { on: vi.fn(() => () => {}), emit: vi.fn() },
    });
    piOrchestrator(pi);
    const options = vi.mocked(registerWorkflowCommands).mock.calls[0][1]!;
    const ctx = makeExtensionCommandContextFixture({
      cwd: "/tmp/pi-launch",
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => sessionFile,
      },
      isProjectTrusted: () => false,
      modelRegistry: { getAvailable: () => [] },
      scopedModels: [],
    });
    options.createRuntime!(ctx);
    const runtime = vi.mocked(createWorkflowCommandRuntime).mock.calls[0][2]!;
    expect(runtime.ownership?.rootSessionId).toBe(sessionId);
    expect(runtime.launchHost?.sessionId).toBe(rpcIdentity);
    const otherOwner = registerSubagentCapabilityCeiling({
      sessionId: rpcIdentity,
      source: "other-owner",
      ceiling: { allowedTools: ["read"] },
    });
    const restriction = restrictAgentLaunch(
      {
        agent: "workflow-scout",
        task: "Read-only evidence",
        launchPolicy: agentLaunchPolicy("workflow-scout"),
      },
      runtime.launchHost,
    );
    try {
      expect(resolveCurrentSubagentCapabilityCeiling(rpcIdentity)).toEqual({
        version: 1,
        allowedTools: ["read"],
        denyExtensions: true,
        sources: ["other-owner", "pi-orchestrator"],
      });
    } finally {
      restriction?.dispose();
      expect(
        resolveCurrentSubagentCapabilityCeiling(rpcIdentity)?.sources,
      ).toEqual(["other-owner"]);
      otherOwner.dispose();
    }
    expect(
      resolveCurrentSubagentCapabilityCeiling(rpcIdentity),
    ).toBeUndefined();
  },
);
