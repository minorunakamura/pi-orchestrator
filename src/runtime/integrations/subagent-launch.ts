import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { KnownApi } from "@earendil-works/pi-ai";
import {
  resolveSubagentLaunchContract,
  type SubagentLaunchContractInput,
} from "pi-subagents/preflight";
import {
  registerSubagentCapabilityCeiling,
  resolveCurrentSubagentCapabilityCeiling,
} from "pi-subagents/capability-ceiling";
import {
  agentLaunchPolicy,
  parseAgentLaunchEvidence,
  type AgentLaunchEvidence,
} from "../../core/agent-launch.ts";
import {
  SubagentNotDispatchedError,
  type AgentRunRequest,
} from "../ports/subagent-executor.ts";
import { calculateSha256 } from "../persistence/artifact-store.ts";

const physicalApis: readonly KnownApi[] = [
  "openai-completions",
  "mistral-conversations",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-vertex",
  "pi-messages",
];

/** Positive physical transport identity; virtual/unknown routers are not v1 authority. */
export function physicalModelSnapshot(
  registry: Pick<ModelRegistry, "getAvailable" | "getRegisteredProviderConfig">,
) {
  return registry
    .getAvailable()
    .filter(
      (model) =>
        physicalApis.some((api) => api === model.api) ||
        registry.getRegisteredProviderConfig(model.provider)?.api === model.api,
    );
}

/** Public host snapshots, never credentials or raw settings. */
export interface AgentLaunchHost {
  sessionId: string;
  projectTrusted: boolean;
  availableModels: ReadonlyArray<{
    provider: string;
    id: string;
    api?: string;
    fullId?: string;
    reasoning?: boolean;
  }>;
  parentModel?: SubagentLaunchContractInput["parentModel"];
  scopedModelIds?: readonly string[];
  runtimeSnapshotHost?: SubagentLaunchContractInput["runtimeSnapshotHost"];
}
export type LaunchResolver = (
  input: AgentRunRequest,
  binding: {
    task: string;
    cwd: string;
    output: string | false;
    host?: AgentLaunchHost;
    sessionDir?: string;
  },
) => Promise<AgentLaunchEvidence>;

export async function resolveAgentLaunch(
  input: AgentRunRequest,
  binding: Parameters<LaunchResolver>[1],
): Promise<AgentLaunchEvidence> {
  const { host } = binding;
  if (!host?.sessionId || !host.availableModels.length)
    throw new SubagentNotDispatchedError(
      "Public launch host/model snapshot required",
      { diagnosticCode: "host-model-unavailable" },
    );
  const policy =
    input.launchPolicy ??
    agentLaunchPolicy(input.agent, input.executionProfile);
  if (
    policy.agent !== input.agent ||
    JSON.stringify(policy.executionProfile) !==
      JSON.stringify(input.executionProfile)
  )
    throw new SubagentNotDispatchedError("Launch policy/profile mismatch", {
      diagnosticCode: "invalid-launch-policy",
    });
  const profile = policy.executionProfile;
  const model = profile
    ? `${profile.provider}/${profile.model}:${profile.thinking}`
    : undefined;
  const launchInput: SubagentLaunchContractInput = {
    agent: input.agent,
    task: binding.task,
    cwd: binding.cwd,
    output: binding.output,
    outputMode: "inline",
    outputSchema: false,
    agentScope: host.projectTrusted ? "both" : "user",
    context: policy.context,
    ...(model ? { model } : {}),
    skill: [...policy.skills],
    intercomBridge: { mode: "off" },
    parentSessionId: host.sessionId,
    sessionDir: binding.sessionDir,
    parentModel: host.parentModel,
    availableModels: host.availableModels,
    scopedModelIds: host.scopedModelIds,
    runtimeSnapshotHost: host.runtimeSnapshotHost,
    capabilityCeiling: resolveCurrentSubagentCapabilityCeiling(host.sessionId),
  };
  const result = await resolveSubagentLaunchContract(launchInput);
  if (!result.ok)
    throw new SubagentNotDispatchedError("Agent preflight failed", {
      diagnosticCode: result.code,
    });
  let c = result.contract;
  // RPC pins thinking in the model suffix. Resolve that exact transport too,
  // rather than compare an ambient candidate list to a physical dispatch.
  if (c.model && c.thinking) {
    const pinned = await resolveSubagentLaunchContract({
      ...launchInput,
      model: `${c.model.replace(/:(off|minimal|low|medium|high|xhigh|max)$/u, "")}:${c.thinking}`,
    });
    if (!pinned.ok)
      throw new SubagentNotDispatchedError("Pinned Agent preflight failed", {
        diagnosticCode: pinned.code,
      });
    c = pinned.contract;
  }
  const tools = [
    ...new Set([...c.tools.effectiveAllowlist, ...c.tools.effectiveMcpTools]),
  ].toSorted();
  const physical = c.model?.replace(
    /:(off|minimal|low|medium|high|xhigh|max)$/u,
    "",
  );
  const physicalModel = host.availableModels.find(
    (available) => `${available.provider}/${available.id}` === physical,
  );
  if (
    c.version !== 3 ||
    c.protocol.lifecycleArtifactVersion !== 3 ||
    c.protocol.packageVersion !== "0.74.0" ||
    c.agent.name !== policy.agent ||
    (policy.builtin && c.agent.source !== "builtin") ||
    c.context !== "fresh" ||
    c.inheritProjectContext !== policy.inheritProjectContext ||
    c.inheritSkills !== policy.inheritSkills ||
    !physical ||
    !physicalModel?.api ||
    !c.thinking ||
    (c.thinking !== "off" && physicalModel.reasoning !== true) ||
    (profile &&
      (physical !== `${profile.provider}/${profile.model}` ||
        c.thinking !== profile.thinking)) ||
    c.skills.missing.length ||
    policy.skills.some((s) => !c.skills.resolved.some((r) => r.name === s)) ||
    c.skills.resolved.some((s) => !policy.skills.includes(s.name)) ||
    policy.requiredTools.some((t) => !tools.includes(t)) ||
    tools.some(
      (t) =>
        !policy.allowedTools.includes(t) || policy.forbiddenTools.includes(t),
    ) ||
    (policy.denyExtensions && !c.tools.capabilityCeiling?.denyExtensions) ||
    (policy.allowedTools.includes("codemode") &&
      c.tools.capabilityCeiling?.denyExtensions !== false) ||
    c.diagnostics.some(
      (d) => d.severity === "error" || d.severity === "host-required",
    )
  )
    throw new SubagentNotDispatchedError(
      "Resolved Agent launch violates policy or has unresolved host capability",
      {
        diagnosticCode: !physicalModel?.api
          ? "host-model-unavailable"
          : policy.denyExtensions && !c.tools.capabilityCeiling?.denyExtensions
            ? "extension-ceiling-unverified"
            : c.diagnostics.some((d) => d.severity === "host-required")
              ? "host-capability-unavailable"
              : "launch-policy-rejected",
      },
    );
  let codemodeDigest: string | undefined;
  if (
    policy.agent === "plan-simplicity-reviewer" &&
    tools.includes("codemode")
  ) {
    const extension = await realpath(
      fileURLToPath(new URL("./readonly-codemode.ts", import.meta.url)),
    );
    if (
      !c.tools.disableAmbientExtensions ||
      c.tools.configuredExtensions.length !== 1 ||
      (await realpath(c.tools.configuredExtensions[0])) !== extension ||
      c.tools.toolExtensionPaths.length ||
      c.tools.requiredExtensionIds.length ||
      c.tools.mcp.length ||
      c.tools.fanoutAuthorized ||
      c.tools.internalTools.length
    )
      throw Error("Codemode requires the exact isolated child replacement");
    codemodeDigest = calculateSha256(await readFile(extension));
  }
  const skills = await Promise.all(
    c.skills.resolved.map(async (s) => {
      const bytes = await readFile(s.path);
      if (bytes.length > 1024 * 1024) throw Error("Oversized required skill");
      return {
        name: s.name,
        sourceDigest: calculateSha256(JSON.stringify([s.path, s.source])),
        contentDigest: calculateSha256(bytes.toString("utf8")),
      };
    }),
  );
  return parseAgentLaunchEvidence({
    schemaVersion: 1,
    policy,
    agent: c.agent.name,
    source: c.agent.source,
    sourceDigest: calculateSha256(c.agent.filePath),
    definitionDigest: c.agent.definitionDigest,
    definitionProjectionVersion: c.agent.definitionProjectionVersion,
    model: physical,
    modelApi: physicalModel.api,
    thinking: c.thinking,
    requestedSkills: c.skills.requested.toSorted(),
    skills: skills.toSorted((a, b) => a.name.localeCompare(b.name)),
    tools,
    extensionsDigest: calculateSha256(
      JSON.stringify({
        tools: c.tools,
        bridge: c.intercomBridge,
        ...(codemodeDigest ? { codemodeDigest } : {}),
      }),
    ),
    inheritProjectContext: c.inheritProjectContext,
    inheritGlobalContext: c.inheritGlobalContext,
    inheritSkills: c.inheritSkills,
    projectTrusted: host.projectTrusted,
    cwdDigest: calculateSha256(binding.cwd),
    taskDigest: calculateSha256(binding.task),
    outputDigest: calculateSha256(JSON.stringify(binding.output)),
    contractVersion: c.version,
    ...c.protocol,
    launchContractDigest: c.launchContractDigest,
  });
}

/** Public ceilings are session-scoped and intersect with every other owner. */
export function restrictAgentLaunch(
  input: AgentRunRequest,
  host?: AgentLaunchHost,
): { dispose(): void } | undefined {
  if (!host) return undefined;
  const policy =
    input.launchPolicy ??
    agentLaunchPolicy(input.agent, input.executionProfile);
  return registerSubagentCapabilityCeiling({
    sessionId: host.sessionId,
    source: "pi-orchestrator",
    ceiling: {
      allowedTools: policy.allowedTools,
      denyExtensions: policy.denyExtensions,
    },
  });
}
