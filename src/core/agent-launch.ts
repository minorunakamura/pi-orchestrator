import type { ResolvedExecutionProfile } from "./configuration.ts";
import { hasOnlyKeys, isRecord } from "./schema.ts";

/** Domain policy, deliberately independent of Pi transport types. */
export interface AgentLaunchPolicy {
  agent: string;
  authorityRole: "evidence" | "advisory" | "implementation" | "review";
  context: "fresh";
  modelPolicy: "resolved-physical";
  executionProfile?: ResolvedExecutionProfile;
  skills: readonly string[];
  requiredTools: readonly string[];
  allowedTools: readonly string[];
  forbiddenTools: readonly string[];
  inheritProjectContext: boolean;
  inheritSkills: false;
  builtin?: true;
  denyExtensions: boolean;
}

const repositoryTools = ["read", "grep", "find", "ls"];
const researchTools = [
  "ketch_search",
  "ketch_scrape",
  "ketch_docs",
  "ketch_code",
];
export function agentLaunchPolicy(
  agent: string,
  executionProfile?: ResolvedExecutionProfile,
  skills: readonly string[] = [],
): AgentLaunchPolicy {
  const implementation = agent === "worker";
  const advisory = agent === "oracle";
  const review = [
    "reviewer",
    "ponytail-reviewer",
    "plan-simplicity-reviewer",
  ].includes(agent);
  if (
    !implementation &&
    !advisory &&
    !review &&
    !["workflow-scout", "planner", "pi-ketch.researcher"].includes(agent)
  )
    throw Error("No orchestrator launch policy for Agent");
  const research = agent === "pi-ketch.researcher";
  const codemode = agent === "plan-simplicity-reviewer";
  return {
    agent,
    authorityRole: implementation
      ? "implementation"
      : advisory
        ? "advisory"
        : review
          ? "review"
          : "evidence",
    context: "fresh",
    modelPolicy: "resolved-physical",
    ...(executionProfile ? { executionProfile } : {}),
    skills: [...skills],
    requiredTools: research
      ? researchTools
      : implementation
        ? ["read", "bash", "edit", "write"]
        : codemode
          ? ["read", "codemode"]
          : ["read"],
    allowedTools: research
      ? researchTools
      : [
          ...repositoryTools,
          ...(codemode ? ["codemode"] : []),
          ...(implementation
            ? ["bash", "edit", "write", "contact_supervisor"]
            : []),
        ],
    forbiddenTools: implementation
      ? ["subagent", "subagents_enable", "codemode"]
      : [
          "bash",
          "edit",
          "write",
          "subagent",
          "subagents_enable",
          ...(!codemode ? ["codemode"] : []),
        ],
    inheritProjectContext: !research,
    inheritSkills: false,
    ...(implementation || advisory || agent === "reviewer"
      ? { builtin: true as const }
      : {}),
    denyExtensions: !research && !codemode,
  };
}

/** Bounded, non-secret resolved intent; paths/prompts/settings are represented by hashes. */
export interface AgentLaunchEvidence {
  schemaVersion: 1;
  policy: AgentLaunchPolicy;
  agent: string;
  source: string;
  sourceDigest: string;
  definitionDigest: string;
  definitionProjectionVersion: number;
  model: string;
  modelApi: string;
  thinking: string;
  requestedSkills: string[];
  skills: { name: string; sourceDigest: string; contentDigest: string }[];
  tools: string[];
  extensionsDigest: string;
  inheritProjectContext: boolean;
  inheritGlobalContext: boolean;
  inheritSkills: boolean;
  projectTrusted: boolean;
  cwdDigest: string;
  taskDigest: string;
  outputDigest: string;
  contractVersion: 3;
  lifecycleArtifactVersion: 3;
  packageVersion: string;
  launchContractDigest: string;
}

const name = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 256 &&
  /^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$/u.test(value) &&
  !value.includes("://") &&
  !/^(?:sk-|gh[pousr]_|xox[baprs]-)/u.test(value);
const digest = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const names = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 128 && value.every(name);
export function isAgentLaunchEvidence(
  value: unknown,
): value is AgentLaunchEvidence {
  if (
    !isRecord(value) ||
    new TextEncoder().encode(JSON.stringify(value)).length > 32_768
  )
    return false;
  const policy = value.policy;
  if (!isRecord(policy)) return false;
  const allowedTools = policy.allowedTools;
  const forbiddenTools = policy.forbiddenTools;
  const requiredTools = policy.requiredTools;
  const selectedSkills = policy.skills;
  const tools = value.tools;
  const skills = value.skills;
  const profile = policy.executionProfile;
  return (
    hasOnlyKeys(value, [
      "schemaVersion",
      "policy",
      "agent",
      "source",
      "sourceDigest",
      "definitionDigest",
      "definitionProjectionVersion",
      "model",
      "modelApi",
      "thinking",
      "requestedSkills",
      "skills",
      "tools",
      "extensionsDigest",
      "inheritProjectContext",
      "inheritGlobalContext",
      "inheritSkills",
      "projectTrusted",
      "cwdDigest",
      "taskDigest",
      "outputDigest",
      "contractVersion",
      "lifecycleArtifactVersion",
      "packageVersion",
      "launchContractDigest",
    ]) &&
    value.schemaVersion === 1 &&
    value.contractVersion === 3 &&
    value.lifecycleArtifactVersion === 3 &&
    [
      value.agent,
      value.source,
      value.model,
      value.modelApi,
      value.thinking,
      value.packageVersion,
    ].every(name) &&
    [
      value.sourceDigest,
      value.definitionDigest,
      value.extensionsDigest,
      value.cwdDigest,
      value.taskDigest,
      value.outputDigest,
      value.launchContractDigest,
    ].every(digest) &&
    Number.isSafeInteger(value.definitionProjectionVersion) &&
    Number(value.definitionProjectionVersion) > 0 &&
    [
      value.inheritProjectContext,
      value.inheritGlobalContext,
      value.inheritSkills,
      value.projectTrusted,
    ].every((v) => typeof v === "boolean") &&
    names(value.requestedSkills) &&
    names(tools) &&
    Array.isArray(skills) &&
    skills.length <= 128 &&
    skills.every(
      (skill) =>
        isRecord(skill) &&
        hasOnlyKeys(skill, ["name", "sourceDigest", "contentDigest"]) &&
        name(skill.name) &&
        digest(skill.sourceDigest) &&
        digest(skill.contentDigest),
    ) &&
    hasOnlyKeys(policy, [
      "agent",
      "authorityRole",
      "context",
      "modelPolicy",
      "executionProfile",
      "skills",
      "requiredTools",
      "allowedTools",
      "forbiddenTools",
      "inheritProjectContext",
      "inheritSkills",
      "builtin",
      "denyExtensions",
    ]) &&
    name(policy.agent) &&
    policy.agent === value.agent &&
    ["evidence", "advisory", "implementation", "review"].includes(
      String(policy.authorityRole),
    ) &&
    policy.context === "fresh" &&
    policy.modelPolicy === "resolved-physical" &&
    names(selectedSkills) &&
    names(requiredTools) &&
    names(allowedTools) &&
    names(forbiddenTools) &&
    typeof policy.inheritProjectContext === "boolean" &&
    policy.inheritSkills === false &&
    typeof policy.denyExtensions === "boolean" &&
    (policy.builtin === undefined || policy.builtin === true) &&
    value.inheritProjectContext === policy.inheritProjectContext &&
    value.inheritSkills === policy.inheritSkills &&
    (policy.builtin !== true || value.source === "builtin") &&
    tools.every(
      (tool) => allowedTools.includes(tool) && !forbiddenTools.includes(tool),
    ) &&
    requiredTools.every((tool) => tools.includes(tool)) &&
    selectedSkills.every((skill) =>
      skills.some((entry: unknown) => isRecord(entry) && entry.name === skill),
    ) &&
    skills.every(
      (skill) => isRecord(skill) && selectedSkills.includes(String(skill.name)),
    ) &&
    (value.agent === "worker"
      ? policy.authorityRole === "implementation" &&
        policy.builtin === true &&
        policy.executionProfile !== undefined
      : policy.authorityRole !== "implementation") &&
    (value.agent === "oracle"
      ? policy.authorityRole === "advisory" && policy.builtin === true
      : policy.authorityRole !== "advisory") &&
    (policy.authorityRole === "implementation" ||
      !allowedTools.some((tool) =>
        [
          "bash",
          "edit",
          "write",
          "subagent",
          "subagents_enable",
          "contact_supervisor",
        ].includes(tool),
      )) &&
    // Capability contract only: the adapter must verify child runtime isolation.
    (!allowedTools.includes("codemode") ||
      ([
        "workflow-scout",
        "plan-simplicity-reviewer",
        "reviewer",
        "ponytail-reviewer",
      ].includes(policy.agent) &&
        ["evidence", "review"].includes(String(policy.authorityRole)) &&
        requiredTools.includes("codemode") &&
        tools.includes("codemode") &&
        !policy.denyExtensions &&
        allowedTools.every((tool) =>
          [...repositoryTools, "codemode"].includes(tool),
        ))) &&
    (profile === undefined ||
      (isRecord(profile) &&
        hasOnlyKeys(profile, ["provider", "model", "thinking"]) &&
        name(profile.provider) &&
        name(profile.model) &&
        name(profile.thinking) &&
        value.model === `${profile.provider}/${profile.model}` &&
        value.thinking === profile.thinking))
  );
}

export function parseAgentLaunchEvidence(value: unknown): AgentLaunchEvidence {
  if (!isAgentLaunchEvidence(value))
    throw Error("Invalid or oversized Agent launch evidence");
  return value;
}
