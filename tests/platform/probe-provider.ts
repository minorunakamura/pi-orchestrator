import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

/** Offline provider: observes the real child's final prompt; no network/model credentials. */
export default function (pi: ExtensionAPI) {
  let projectTrusted: boolean | undefined;
  pi.on("session_start", (_event, ctx) => {
    projectTrusted = ctx.isProjectTrusted();
  });
  pi.on("resources_discover", () => ({
    skillPaths: [join(getAgentDir(), "extension-skills")],
  }));
  pi.registerProvider("platform-smoke", {
    api: "platform-probe",
    apiKey: "offline-fixture",
    baseUrl: "https://unused.invalid",
    models: [
      {
        id: "probe",
        name: "Offline platform probe",
        reasoning: false,
        input: ["text"],
        contextWindow: 32000,
        maxTokens: 1000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const prompt = getCurrentSystemPrompt(context.messages);
      const evidence = {
        projectTrusted,
        selectedSkill: prompt.includes("<name>platform-selected</name>"),
        ambientSkill: prompt.includes("<name>ambient-skill</name>"),
        extensionSkill: prompt.includes("<name>extension-skill</name>"),
        projectSkill: prompt.includes("<name>project-skill</name>"),
        projectPrompt:
          /PROJECT_(SYSTEM|APPEND|PROMPT|SETTINGS)_INJECTION/u.test(
            prompt + JSON.stringify(context.messages),
          ),
        tools: pi
          .getAllTools()
          .map((tool) => tool.name)
          .toSorted(),
        model: `${model.provider}/${model.id}`,
      };
      const message: AssistantMessage = {
        role: "assistant",
        provider: model.provider,
        api: model.api,
        model: model.id,
        timestamp: Date.now(),
        stopReason: "stop",
        content: [{ type: "text", text: JSON.stringify(evidence) }],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      });
      return stream;
    },
  });
}
