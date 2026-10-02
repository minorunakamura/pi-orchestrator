import {
  agentLaunchPolicy,
  type AgentLaunchEvidence,
} from "../../src/core/agent-launch.ts";
import { calculateSha256 } from "../../src/runtime/persistence/artifact-store.ts";
import {
  SubagentsIntegration as ProductionIntegration,
  type SubagentsIntegrationOptions,
  type EventBus,
} from "../../src/runtime/integrations/subagents.ts";
import type { LaunchResolver } from "../../src/runtime/integrations/subagent-launch.ts";
import type { AgentRunRequest } from "../../src/runtime/ports/subagent-executor.ts";

export function fakeLaunchDigest(
  agent: unknown,
  task: unknown,
  cwd: unknown,
  output: unknown,
  model: unknown,
) {
  return calculateSha256(JSON.stringify({ agent, task, cwd, output, model }));
}
export const fakeLaunchResolver: LaunchResolver = async (input, binding) => {
  const policy =
    input.launchPolicy ??
    agentLaunchPolicy(input.agent, input.executionProfile);
  const profile = policy.executionProfile ?? {
    provider: "fake",
    model: "fake",
    thinking: "off",
  };
  const hash = calculateSha256("fixture");
  return {
    schemaVersion: 1,
    policy,
    agent: input.agent,
    source: policy.builtin ? "builtin" : "package",
    sourceDigest: hash,
    definitionDigest: hash,
    definitionProjectionVersion: 1,
    model: `${profile.provider}/${profile.model}`,
    modelApi: "fixture-api",
    thinking: profile.thinking,
    requestedSkills: [...policy.skills],
    skills: policy.skills.map((name) => ({
      name,
      sourceDigest: hash,
      contentDigest: hash,
    })),
    tools: [...policy.allowedTools],
    extensionsDigest: hash,
    inheritProjectContext: policy.inheritProjectContext,
    inheritGlobalContext: false,
    inheritSkills: false,
    projectTrusted: binding.host?.projectTrusted ?? false,
    cwdDigest: calculateSha256(binding.cwd),
    taskDigest: calculateSha256(binding.task),
    outputDigest: calculateSha256(JSON.stringify(binding.output)),
    contractVersion: 3,
    lifecycleArtifactVersion: 3,
    packageVersion: "0.74.0",
    launchContractDigest: fakeLaunchDigest(
      input.agent,
      binding.task,
      binding.cwd,
      binding.output,
      `${profile.provider}/${profile.model}:${profile.thinking}`,
    ),
  };
};

/** Protocol tests fake only preflight; dispatch, correlation, output and recovery remain real adapter code. */
export class SubagentsIntegration extends ProductionIntegration {
  constructor(events: EventBus, options: SubagentsIntegrationOptions = {}) {
    super(events, { launchResolver: fakeLaunchResolver, ...options });
  }
  override run(input: AgentRunRequest) {
    return super.run({
      onPrepared: async (_launch: AgentLaunchEvidence) => {},
      ...input,
    });
  }
}
