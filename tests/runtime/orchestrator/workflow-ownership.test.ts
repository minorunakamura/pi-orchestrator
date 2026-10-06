// Disposable workspaces and state authority are prepared sequentially.
// oxlint-disable eslint/no-await-in-loop
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  cp,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createWorkflowCommandRuntime } from "../../../src/commands/index.ts";
import { WorkflowOwnership } from "../../../src/runtime/orchestrator/workflow-ownership.ts";
import { registerWorkflowOwnership } from "../../../src/runtime/integrations/workflow-ownership.ts";
import { createWorkflow } from "../../../src/runtime/orchestrator/start-workflow.ts";
import { driveWorkflow } from "../../../src/runtime/orchestrator/drive-workflow.ts";
import { resumeWorkflow } from "../../../src/runtime/orchestrator/resume-workflow.ts";
import { advanceWorkflow } from "../../../src/runtime/orchestrator/advance-workflow.ts";
import { ArtifactStore } from "../../../src/runtime/persistence/artifact-store.ts";
import { StateStore } from "../../../src/runtime/persistence/state-store.ts";
import { FakeSubagentExecutor } from "../../fakes/index.ts";
import {
  makeExtensionApiFixture,
  makeExtensionCommandContextFixture,
  makeInvalidPayload,
} from "../../fakes/typed-boundaries.ts";

const roots: string[] = [];
async function fixture(git = false, owned = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ownership-")));
  roots.push(root);
  const cwd = join(root, "project");
  await mkdir(cwd);
  await writeFile(join(cwd, "source.ts"), "export const untouched = true;\n");
  if (git) await promisify(execFile)("git", ["init", "-q", cwd]);
  const runDirectory = join(cwd, ".pi", "orchestrator", "runs", "workflow-1");
  const artifacts = new ArtifactStore(runDirectory);
  const states = new StateStore(runDirectory);
  const executor = new FakeSubagentExecutor();
  const owner = new WorkflowOwnership(cwd, "root-1");
  const created = await owner.start(() =>
    createWorkflow(
      { cwd, task: "Owned task", playbook: "feature" },
      {
        runsDirectory: owner.runsDirectory,
        workflowIdFactory: () => "workflow-1",
        artifactStore: artifacts,
        stateStore: states,
        subagentExecutor: executor,
      },
    ),
  );
  const state = owned
    ? await owner.initialize(created.state, states)
    : created.state;
  return { cwd, root, owner, state, artifacts, states, executor, runDirectory };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test.each([false, true])(
  "%s Git ownership persists before execution and detects pre-Worker drift without adopting it",
  async (git) => {
    const h = await fixture(git);
    expect(h.executor.calls.run).toHaveLength(0);
    const initial = JSON.parse(
      await h.artifacts.readText(h.state.ownershipRef!),
    );
    expect(initial.rootSessionId).toBe("root-1");
    expect(initial.workspace.kind).toBe(git ? "git" : "filesystem");
    expect(await h.owner.validate(h.state, h.states)).toEqual(h.state);
    await writeFile(join(h.cwd, "source.ts"), "out-of-band implementation\n");
    const driven = await driveWorkflow(h.state.workflowId, {
      artifactStore: h.artifacts,
      stateStore: h.states,
      loadState: () => h.states.loadState(),
      subagentExecutor: h.executor,
      ownership: h.owner,
    });
    expect(driven.status).toBe("blocked");
    expect(driven.state.block?.blockedFrom).toBe("gathering-context");
    expect(driven.state.workspaceCheckpointRef).toBeUndefined();
    expect(driven.state.coding.workspaceBaselineRef).toBeUndefined();
    expect(h.executor.calls.run).toHaveLength(0);
    expect(
      await h.artifacts.readText(driven.state.block!.evidenceRef!),
    ).toContain("Out-of-band");
  },
);

test("production command runtime without an installed host boundary persists a block and dispatches nothing", async () => {
  const h = await fixture();
  const cwd = join(h.root, "no-host");
  await mkdir(cwd);
  const emit = vi.fn();
  const runtime = createWorkflowCommandRuntime(
    { emit, on: () => () => {} },
    cwd,
  );
  const started = await runtime.start({
    task: "Must not run without host enforcement",
    playbook: "feature",
  });
  expect(started.state.phase).toBe("blocked");
  expect(started.state.block?.reason).toBe("operator-attention-required");
  expect(started.state.ownershipRef).toBeUndefined();
  expect(emit).not.toHaveBeenCalled();
});

test("resume cannot turn source drift into Worker or recovery authority", async () => {
  const h = await fixture();
  await writeFile(join(h.cwd, "source.ts"), "drift");
  const resumed = await resumeWorkflow(h.state.workflowId, {
    runDirectory: h.runDirectory,
    artifactStore: h.artifacts,
    stateStore: h.states,
    subagentExecutor: h.executor,
    ownership: h.owner,
  });
  expect(resumed.status).toBe("blocked");
  expect(h.executor.calls.run).toHaveLength(0);
  await expect(
    resumeWorkflow(h.state.workflowId, {
      runDirectory: h.runDirectory,
      artifactStore: h.artifacts,
      stateStore: h.states,
      subagentExecutor: h.executor,
      ownership: h.owner,
    }),
  ).rejects.toThrow(/Out-of-band/iu);
});

test("owner conflicts including another root session cannot replace an active workflow; terminal workflow releases start boundary", async () => {
  const h = await fixture();
  const create = vi.fn();
  await expect(
    new WorkflowOwnership(h.cwd, "another-root").start(create),
  ).rejects.toThrow(/active workflow/iu);
  expect(create).not.toHaveBeenCalled();
  const failed = await advanceWorkflow(
    h.state,
    { type: "FAIL", reason: "authority-inconsistent" },
    h.states,
  );
  expect(failed.phase).toBe("failed");
  await h.owner.start(create);
  expect(create).toHaveBeenCalledOnce();
});

test.each(["missing", "root-session", "copied-root", "corrupt-artifact"])(
  "%s ownership fails closed before any child",
  async (kind) => {
    const h = await fixture(false, kind !== "missing");
    let owner = h.owner;
    if (kind === "root-session")
      owner = new WorkflowOwnership(h.cwd, "different-session");
    if (kind === "copied-root") {
      const other = join(h.root, "other");
      await cp(h.cwd, other, { recursive: true });
      owner = new WorkflowOwnership(other, "root-1");
    }
    if (kind === "corrupt-artifact")
      await writeFile(
        join(h.runDirectory, h.state.ownershipRef!.path),
        "corrupt",
      );
    const blocked = await owner.validate(h.state, h.states);
    expect(blocked.phase).toBe("blocked");
    expect(h.executor.calls.run).toHaveLength(0);
  },
);

test("switching to a nested workspace cannot hide its ancestor owner", async () => {
  const h = await fixture(true);
  const nested = join(h.cwd, "nested");
  await mkdir(nested);
  const owner = new WorkflowOwnership(nested, "other-root");
  expect((await owner.active()).map((state) => state.workflowId)).toEqual([
    h.state.workflowId,
  ]);
  const create = vi.fn();
  await expect(owner.start(create)).rejects.toThrow(/active workflow/iu);
  expect(create).not.toHaveBeenCalled();
});

test("initial ownership State publication failure cannot begin downstream execution or silently adopt a baseline", async () => {
  const h = await fixture(false, false);
  const saveState = vi.fn(async () => {
    throw Error("ownership State save failed");
  });
  await expect(h.owner.initialize(h.state, { saveState })).rejects.toThrow(
    /save failed/iu,
  );
  expect((await h.states.loadState()).ownershipRef).toBeUndefined();
  expect(h.executor.calls.run).toHaveLength(0);
  expect(
    (await h.owner.validate(await h.states.loadState(), h.states)).phase,
  ).toBe("blocked");
});

test("symlinked runtime directories cannot hide or redirect an owner", async () => {
  const h = await fixture();
  const other = join(h.root, "other");
  await mkdir(other);
  await symlink(join(h.cwd, ".pi"), join(other, ".pi"));
  const owner = new WorkflowOwnership(other, "root-1");
  await expect(owner.active()).rejects.toThrow(/Unsafe/iu);
  const create = vi.fn();
  await expect(owner.start(create)).rejects.toThrow(/Unsafe/iu);
  expect(create).not.toHaveBeenCalled();
});

test("public session breadcrumb precedes side effects and survives reload/whole runtime-directory loss without allowing a new owner", async () => {
  const h = await fixture(false, false);
  type Entries = ReturnType<ExtensionContext["sessionManager"]["getEntries"]>;
  const entries: Entries = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = makeExtensionApiFixture({
    appendEntry: (customType: string, data: unknown) =>
      entries.push(
        makeInvalidPayload<Entries[number]>({
          type: "custom",
          customType,
          data,
        }),
      ),
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, handler);
      return () => {};
    },
  });
  const ctx = makeExtensionCommandContextFixture({
    cwd: h.cwd,
    sessionManager: { getSessionId: () => "root-1", getEntries: () => entries },
  });
  const boundary = registerWorkflowOwnership(pi)(ctx);
  await boundary.initialize(h.state, {
    saveState: (state, revision) => {
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        data: { ownershipRef: state.ownershipRef },
      });
      return h.states.saveState(state, revision);
    },
  });
  await rm(join(h.cwd, ".pi", "orchestrator"), { recursive: true });
  const restored = registerWorkflowOwnership(pi)(ctx); // New runtime, same public session history.
  expect(
    await handlers.get("tool_call")!({ toolName: "write" }, ctx),
  ).toMatchObject({ block: true });
  const create = vi.fn();
  await expect(restored.start(create)).rejects.toThrow(
    /not found|does not exist|ENOENT/iu,
  );
  expect(create).not.toHaveBeenCalled();
  expect(h.executor.calls.run).toHaveLength(0);
});

test("Main receives current ownership/blocked context before a completion wake, with no stale restriction after terminal release", async () => {
  const h = await fixture();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  registerWorkflowOwnership(
    makeExtensionApiFixture({
      appendEntry: vi.fn(),
      on: (
        name: string,
        handler: (event: unknown, ctx: unknown) => unknown,
      ) => {
        handlers.set(name, handler);
        return () => {};
      },
    }),
  );
  const ctx = makeExtensionCommandContextFixture({
    cwd: h.cwd,
    sessionManager: { getSessionId: () => "root-1", getEntries: () => [] },
  });
  const message = {
    role: "user",
    content: "Background completion",
    timestamp: 0,
  };
  const event = { messages: [message] };
  const response = await handlers.get("context")!(event, ctx);
  expect(response).toMatchObject({
    messages: [
      message,
      {
        role: "custom",
        customType: "orchestrator-ownership-context",
        content: expect.stringContaining('"phase":"gathering-context"'),
      },
    ],
  });
  expect(JSON.stringify(response)).toContain("not a request to implement");
  expect(JSON.stringify(response)).toContain(
    "without that request, do not initiate clarification",
  );
  const blocked = await advanceWorkflow(
    h.state,
    { type: "BLOCK", reason: "operator-attention-required" },
    h.states,
  );
  const blockedContext = await handlers.get("context")!(event, ctx);
  expect(blockedContext).toMatchObject({
    messages: [
      message,
      {
        content: expect.stringContaining('"phase":"blocked"'),
      },
    ],
  });
  expect(JSON.stringify(blockedContext)).toContain(
    '\\"reason\\":\\"operator-attention-required\\"',
  );
  expect(JSON.stringify(blockedContext)).toContain(
    "report this state and stop",
  );
  const active = await advanceWorkflow(
    blocked,
    { type: "BLOCK_RESOLVED" },
    h.states,
  );
  await advanceWorkflow(
    active,
    { type: "FAIL", reason: "authority-inconsistent" },
    h.states,
  );
  expect(await handlers.get("context")!(event, ctx)).toBeUndefined();
  expect(event.messages).toEqual([message]);
  expect(h.executor.calls.run).toHaveLength(0);
});

test("host denies every raw/unknown/nested mutation provider regardless of trust, hints, or modified args; Human chat is not blocked", async () => {
  const h = await fixture();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = makeExtensionApiFixture({
    appendEntry: vi.fn(),
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, handler);
      return () => {};
    },
  });
  registerWorkflowOwnership(pi);
  let trusted = false;
  const ctx = makeExtensionCommandContextFixture({
    cwd: h.cwd,
    isProjectTrusted: () => trusted,
    sessionManager: { getSessionId: () => "other-root", getEntries: () => [] },
  });
  for (const trust of [false, true]) {
    trusted = trust;
    await handlers.get("before_agent_start")!(
      { systemPromptOptions: { sections: {} } },
      ctx,
    );
    for (const name of [
      "write",
      "edit",
      "read",
      "bash",
      "codemode",
      "subagent",
      "mcp_unknown",
      "custom_readonly_hint",
      "wf_clarification_complete",
    ]) {
      expect(
        await handlers.get("tool_call")!(
          {
            toolName: name,
            input: { path: "CONTEXT.md" },
            parentToolCallId: "outer",
          },
          ctx,
        ),
      ).toMatchObject({ block: true });
    }
    expect(
      await handlers.get("user_bash")!(
        { command: "echo mutation > source.ts" },
        ctx,
      ),
    ).toMatchObject({ result: { exitCode: 1 } });
  }
  expect(h.executor.calls.run).toHaveLength(0);
  expect(await handlers.get("session_start")!({}, ctx)).toBeUndefined();
  await writeFile(join(h.runDirectory, "state.json"), "corrupt");
  expect(
    await handlers.get("tool_call")!({ toolName: "read" }, ctx),
  ).toMatchObject({ block: true });
});
