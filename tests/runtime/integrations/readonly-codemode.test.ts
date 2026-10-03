/* oxlint-disable typescript/no-unsafe-type-assertion -- minimal public tool contexts, no Pi private runtime */
import { expect, test, vi } from "vitest";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
  ToolLoadout,
} from "@earendil-works/pi-coding-agent";
import readonlyCodemode from "../../../src/runtime/integrations/readonly-codemode.ts";

function fixture() {
  let definition!: ToolDefinition;
  const handlers = new Map<string, Function>();
  const registered = [{ name: "read" }, { name: "codemode" }];
  void readonlyCodemode({
    registerTool: (tool: ToolDefinition) => {
      definition = tool;
    },
    on: (event: string, handler: Function) => {
      handlers.set(event, handler);
    },
    getAllTools: () => registered,
    getSettings: () => ({}),
  } as unknown as ExtensionAPI);
  const read = createReadTool(process.cwd());
  const executeTool = vi.fn(async (_name: string, args: { path: string }) => ({
    toolCall: { type: "toolCall", id: "c/1", name: "read", arguments: args },
    result: {
      content: [{ type: "text", text: `${args.path}:1 source fact` }],
      details: {},
    },
    isError: false,
  }));
  const classify = vi.fn();
  const ctx = {
    tools: [read],
    executeTool,
    modelRegistry: { classify },
    sessionManager: { getBranch: () => [] },
  } as unknown as ExtensionToolContext;
  const loadout = {
    registered: [read, definition],
    declared: [read, definition],
    callable: [read],
    getExposure: (name: string) =>
      name === "codemode" ? "model-only" : "direct",
    getNamespace: () => undefined,
  } as unknown as ToolLoadout;
  return {
    definition,
    handlers,
    registered,
    ctx,
    loadout,
    executeTool,
    classify,
  };
}

test("official models:false Codemode batches reads and retains provenance without classifier access", async () => {
  const f = fixture();
  expect(f.definition.exposure).toBe("model-only");
  expect(f.definition.prepareLoadout!(f.loadout)).toBeDefined();
  const result = await f.definition.execute(
    "c",
    {
      code: `const facts = await Promise.all(["a.ts", "b.ts"].map(async path => ({path, evidence: await tools.read({path})}))); return {facts, models: typeof models, tools: ALL_TOOLS};`,
    },
    undefined,
    undefined,
    f.ctx,
  );
  const text = JSON.stringify(result.content);
  expect(text).toContain("Script completed");
  expect(text).toContain("a.ts:1 source fact");
  expect(text).toContain("b.ts:1 source fact");
  expect(text).toContain("undefined");
  expect(f.executeTool).toHaveBeenCalledTimes(2);
  expect(f.classify).not.toHaveBeenCalled();
});

test.each([
  "write",
  "edit",
  "bash",
  "subagent",
  "subagents_enable",
  "subagent_supervisor",
  "contact_supervisor",
  "structured_output",
  "codemode",
  "mcp__fs__write",
])("script cannot call %s", async (name) => {
  const f = fixture();
  const result = await f.definition.execute(
    "c",
    {
      code: `return await tools[${JSON.stringify(name)}]({path:"victim", content:"bad"});`,
    },
    undefined,
    undefined,
    f.ctx,
  );
  expect(JSON.stringify(result.content)).toContain("Script failed");
  expect(f.executeTool).not.toHaveBeenCalled();
  expect(f.classify).not.toHaveBeenCalled();
});

test("models.classify is actually unavailable, not merely omitted from declarations", async () => {
  const f = fixture();
  const result = await f.definition.execute(
    "c",
    { code: `return await models.classify("typesafe/jev-latest", {});` },
    undefined,
    undefined,
    f.ctx,
  );
  expect(JSON.stringify(result.content)).toContain("Script failed");
  expect(f.classify).not.toHaveBeenCalled();
});

test.each(["direct", "deferred", "codemode", "model-only", "hidden"])(
  "unexpected registered %s capability fails before building model loadout",
  (exposure) => {
    const f = fixture();
    expect(() =>
      f.definition.prepareLoadout!({
        ...f.loadout,
        registered: [
          ...f.loadout.registered,
          { ...f.loadout.registered[0], name: "mcp__fs__write" },
        ],
        getExposure: () => exposure,
      } as ToolLoadout),
    ).toThrow("Unverified read-only");
    expect(f.executeTool).not.toHaveBeenCalled();
  },
);

test("callable registry drift is rejected before script execution; nested hooks deny controls", async () => {
  const f = fixture();
  f.registered.push({ name: "write" });
  await expect(
    f.definition.execute(
      "c",
      { code: `return 1;` },
      undefined,
      undefined,
      f.ctx,
    ),
  ).rejects.toThrow("capability drift");
  expect(
    f.handlers.get("tool_call")!({ toolName: "write", parentToolCallId: "c" }),
  ).toMatchObject({ block: true });
  expect(
    f.handlers.get("tool_call")!({
      toolName: "codemode",
      parentToolCallId: "c",
    }),
  ).toMatchObject({ block: true });
  expect(
    f.handlers.get("tool_call")!({ toolName: "read", parentToolCallId: "c" }),
  ).toBeUndefined();
});

test("model options cannot expand the output ceiling", async () => {
  const f = fixture();
  const result = await f.definition.execute(
    "c",
    {
      code: `// @options: {"max_output_tokens":100000,"timeout_ms":999999}\nreturn "x".repeat(100000);`,
    },
    undefined,
    undefined,
    f.ctx,
  );
  expect(JSON.stringify(result.content).length).toBeLessThan(20000);
});
