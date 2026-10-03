import {
  createCodemodeExtension,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const reads = ["read", "grep", "find", "ls"];

/** Child-only replacement of Pi's replaceable Codemode; never loaded by src/index.ts. */
export default function (pi: ExtensionAPI) {
  const installed = createCodemodeExtension({ models: false, mode: "on" })({
    ...pi,
    registerTool(definition) {
      if (definition.name !== "codemode")
        throw Error("Unexpected Codemode factory");
      pi.registerTool({
        ...definition,
        prepareLoadout(loadout) {
          // Check registered/deferred tools, not just declarations. Throwing here
          // prevents building the provider loadout, before any model request.
          if (
            loadout.registered.some(
              (tool) => ![...reads, "codemode"].includes(tool.name),
            ) ||
            loadout.callable.some((tool) => !reads.includes(tool.name)) ||
            !loadout.declared.some((tool) => tool.name === "codemode")
          )
            throw Error("Unverified read-only Codemode loadout");
          return definition.prepareLoadout?.(loadout);
        },
        async execute(id, params, signal, onUpdate, ctx) {
          if (
            ctx.tools.some((tool) => !reads.includes(tool.name)) ||
            pi
              .getAllTools()
              .some((tool) => ![...reads, "codemode"].includes(tool.name))
          )
            throw Error("Read-only Codemode capability drift");
          // Independent of model-supplied hints: finite script deadline/output.
          return definition.execute(
            id,
            {
              ...params,
              code: `// @options: {"timeout_ms":30000,"max_output_tokens":4000}\n${params.code.replace(/^\s*\/\/\s*@options:[^\n]*(?:\n|$)/u, "")}`,
            },
            signal,
            onUpdate,
            ctx,
          );
        },
      });
    },
  });
  pi.on("tool_call", (event) => {
    if (
      ![...reads, "codemode"].includes(event.toolName) ||
      (event.toolName === "codemode" && event.parentToolCallId)
    )
      return {
        block: true,
        reason: "Read-only evidence tools only; no nested controls",
      };
    return undefined;
  });
  return installed;
}
