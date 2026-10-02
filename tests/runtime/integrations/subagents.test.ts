import {
  SubagentsIntegration,
  fakeLaunchResolver,
} from "../../fakes/agent-launch.ts";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { startWorkflow } from "../../fakes/planning.ts";
import { StateStore } from "../../../src/runtime/persistence/state-store.ts";
import { createWorkflowCommandRuntime } from "../../../src/commands/index.ts";
import {
  ArtifactStore,
  createArtifactRef,
} from "../../../src/runtime/persistence/artifact-store.ts";
import type { ArtifactRef } from "../../../src/core/artifacts/references.ts";
import { SUBAGENT_RPC_REQUEST_EVENT } from "../../../src/runtime/integrations/subagents.ts";
import type { AgentRunRequest } from "../../../src/runtime/ports/index.ts";
import {
  childRequest,
  FakeSubagentRpc as FakeEventBus,
} from "../../fakes/subagent-rpc.ts";

const roots: string[] = [];
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orchestrator-agent-input-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("SubagentsIntegration", () => {
  test.each(["startup-projection-pending", "terminal-digest-mismatch"])(
    "persists early receipt but requires exact terminal evidence: %s",
    async (scenario) => {
      const store = new ArtifactStore(await temporaryRoot());
      await store.writeText("task", "task.md", "probe");
      const events = new FakeEventBus((request, rpc) => {
        rpc.receipt(request, "receipt-race");
        const asyncDir = rpc.asyncDirs.get("receipt-race")!;
        const path = join(asyncDir, "status.json");
        const status = JSON.parse(readFileSync(path, "utf8"));
        if (scenario === "startup-projection-pending") {
          delete status.launchContractDigest;
          status.steps = [];
        } else status.launchContractDigest = "wrong-terminal-digest";
        writeFileSync(path, JSON.stringify(status));
      });
      let saved = false;
      const result = await new SubagentsIntegration(events, {
        artifactReader: store,
      }).run({
        agent: "reviewer",
        task: "probe",
        onStarted: async (receipt) => {
          saved = true;
          if (scenario === "startup-projection-pending") {
            const path = join(receipt.asyncDir, "status.json");
            const status = JSON.parse(await readFile(path, "utf8"));
            await writeFile(
              path,
              JSON.stringify({
                ...status,
                launchContractDigest: receipt.launchContractDigest,
              }),
            );
          }
          events.complete(
            childRequest(events.emitted[0].payload),
            receipt.runId,
            "complete",
            "canonical full output",
          );
        },
      });
      expect(saved).toBe(true);
      expect(result.status).toBe(
        scenario === "startup-projection-pending" ? "succeeded" : "ambiguous",
      );
      if (result.status === "succeeded")
        expect(result.output).toBe("canonical full output");
    },
  );
  test.each([undefined, false, true])(
    "uses the public Agent discovery scope for host project trust %s",
    async (projectTrusted) => {
      const events = new FakeEventBus();
      await new SubagentsIntegration(events, { projectTrusted }).run({
        agent: "workflow-scout",
        task: "Read only",
      });
      const request = childRequest(events.emitted[0].payload);
      expect(request.agentScope).toBe(
        projectTrusted === true ? "both" : "user",
      );
      expect(request).not.toHaveProperty("projectTrusted");
      expect(request).not.toHaveProperty("inheritSkills");
      expect(request).not.toHaveProperty("workflowScript");
      expect(request).not.toHaveProperty("workflowScriptPath");
    },
  );
  test.each([false, true])(
    "workflow composition passes host trust to children (%s)",
    async (projectTrusted) => {
      const events = new FakeEventBus();
      const runtime = createWorkflowCommandRuntime(
        events,
        await temporaryRoot(),
        { projectTrusted, launchResolver: fakeLaunchResolver },
      );
      await runtime.start({
        task: "Read-only scout probe",
        playbook: "feature",
        context: { requiresClarification: true },
      });
      expect(childRequest(events.emitted[0].payload).agentScope).toBe(
        projectTrusted ? "both" : "user",
      );
    },
  );

  test("preflights every static fanout identity before any avoidable child dispatch", async () => {
    const events = new FakeEventBus();
    const integration = new SubagentsIntegration(events, {
      launchResolver: async (input, params) => {
        if (input.agent === "ponytail-reviewer")
          throw Error("Required Agent missing");
        return fakeLaunchResolver(input, params);
      },
    });
    await expect(
      integration.runParallel([
        { agent: "reviewer", task: "Review correctness" },
        { agent: "ponytail-reviewer", task: "Review simplicity" },
      ]),
    ).rejects.toThrow("Agent launch preflight rejected");
    expect(events.emitted).toHaveLength(0);
  });

  test("runs reviewer requests in parallel with a fresh context", async () => {
    const events = new FakeEventBus();
    const integration = new SubagentsIntegration(events, {
      ownerRunId: "workflow-1",
    });

    await expect(
      integration.runParallel([
        { agent: "reviewer", task: "Return structured correctness findings." },
        {
          agent: "ponytail-reviewer",
          task: "Return structured simplicity findings.",
        },
      ]),
    ).resolves.toHaveLength(2);

    const requests = events.emitted
      .filter(({ event }) => event === SUBAGENT_RPC_REQUEST_EVENT)
      .map(({ payload }) => childRequest(payload));
    expect(requests.map((request) => request.agent)).toEqual([
      "reviewer",
      "ponytail-reviewer",
    ]);
    expect(requests.every((request) => request.context === "fresh")).toBe(true);
  });

  test("carries verified contents, refs and profile through the public delegation contract", async () => {
    const store = new ArtifactStore(await temporaryRoot());
    const planContent = "# Approved plan\nImplement only this scope.";
    const scoutContent = "# Scout\n既存の実装はありません。";
    const planRef = await store.writeText("plan", "plan-v1.md", planContent);
    const contextRef = await store.writeText("scout", "scout.md", scoutContent);
    const events = new FakeEventBus();
    const input: AgentRunRequest = {
      agent: "worker",
      task: "Implement the approved change.",
      cwd: "/repo",
      inputRefs: [planRef, contextRef],
      executionProfile: {
        provider: "provider-a",
        model: "model-a",
        thinking: "high",
      },
    };

    await expect(
      new SubagentsIntegration(events, {
        ownerRunId: "workflow-1",
        artifactReader: store,
      }).run(input),
    ).resolves.toMatchObject({ status: "succeeded", output: "implemented" });

    const request = childRequest(
      events.emitted.find(({ event }) => event === SUBAGENT_RPC_REQUEST_EVENT)
        ?.payload,
    );
    expect(request).toMatchObject({
      agent: "worker",
      cwd: "/repo",
      model: "provider-a/model-a:high",
      async: true,
      output: false,
      outputMode: "inline",
      outputSchema: false,
    });
    expect(request.context).toBe("fresh");
    expect(request.task).toContain(
      JSON.stringify([
        { ref: planRef, content: planContent },
        { ref: contextRef, content: scoutContent },
      ]),
    );
    expect(request.task).not.toContain(
      "read through the orchestrator ArtifactStore",
    );
    expect(request).not.toHaveProperty("provider");
    expect(request).not.toHaveProperty("inputRefs");
  });

  test.each(["missing-reader", "missing-file", "hash-mismatch", "unsafe-path"])(
    "does not dispatch unreadable artifact inputs: %s",
    async (failure) => {
      const store = new ArtifactStore(await temporaryRoot());
      let ref: ArtifactRef = await store.writeText(
        "task",
        "task.md",
        "original",
      );
      if (failure === "missing-file")
        await rm(join(store.rootDirectory, ref.path));
      if (failure === "hash-mismatch")
        await writeFile(join(store.rootDirectory, ref.path), "changed");
      if (failure === "unsafe-path") ref = { ...ref, path: "../task.md" };
      const events = new FakeEventBus();
      await expect(
        new SubagentsIntegration(
          events,
          failure === "missing-reader" ? {} : { artifactReader: store },
        ).run({
          agent: "pi-ketch.researcher",
          task: "Research",
          inputRefs: [ref],
        }),
      ).rejects.toMatchObject({ name: "SubagentNotDispatchedError" });
      expect(events.emitted).toHaveLength(0);
    },
  );

  test("bounds the full UTF-8 task including artifact contents without truncation", async () => {
    const store = new ArtifactStore(await temporaryRoot());
    const refs = await Promise.all([
      store.writeText("task", "task.md", "あ".repeat(180_000)),
      store.writeText("scout", "scout.md", "い".repeat(180_000)),
    ]);
    const events = new FakeEventBus();
    const integration = new SubagentsIntegration(events, {
      artifactReader: store,
    });
    await expect(
      integration.run({ agent: "reviewer", task: "Review", inputRefs: refs }),
    ).rejects.toThrow("exceeds 1 MiB");
    await expect(
      integration.run({ agent: "reviewer", task: "x".repeat(1024 * 1024 + 1) }),
    ).rejects.toThrow("exceeds 1 MiB");
    expect(events.emitted).toHaveLength(0);
    await expect(
      integration.run({ agent: "reviewer", task: "x".repeat(1024 * 1024) }),
    ).resolves.toMatchObject({ status: "succeeded" });
  });

  test("does not dispatch when the persisted deadline expires during artifact reads", async () => {
    const events = new FakeEventBus();
    const ref = createArtifactRef("task", "context/task.md", "task");
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const dispatch = {
      requestId: "request-1",
      ownerRunId: "workflow-1",
      nodeId: "scout",
      deadline: new Date(now + 60_000).toISOString(),
    };
    const integration = new SubagentsIntegration(events, {
      artifactReader: {
        readText: async () => {
          clock.mockReturnValue(now + 60_001);
          return "task";
        },
      },
    });
    await expect(
      integration.run({
        agent: "workflow-scout",
        task: "Scout",
        inputRefs: [ref],
        dispatch,
      }),
    ).rejects.toThrow("expired subagent dispatch identity");
    expect(events.emitted).toHaveLength(0);
  });

  test("context gathering waits for the researcher's reply and publishes its final result only once", async () => {
    const root = await temporaryRoot();
    let signalResearch:
      | ((request: Record<string, unknown>) => void)
      | undefined;
    const researchStarted = new Promise<Record<string, unknown>>((resolve) => {
      signalResearch = resolve;
    });
    const events = new FakeEventBus((request, rpc) => {
      const id = `${String(request.agent)}-1`;
      rpc.receipt(request, id);
      if (request.agent === "pi-ketch.researcher") signalResearch?.(request);
      else rpc.complete(request, id, "complete", "local facts");
    });
    const runDirectory = join(root, "research-wait");
    let settled = false;
    const start = startWorkflow(
      {
        task: "Reversi",
        playbook: "new-project",
        cwd: root,
        context: { requiresResearch: true, requiresClarification: true },
      },
      {
        runsDirectory: root,
        workflowIdFactory: () => "research-wait",
        subagentExecutor: new SubagentsIntegration(events, {
          cwd: root,
          artifactReader: new ArtifactStore(runDirectory),
        }),
      },
    ).then((result) => {
      settled = true;
      return result;
    });
    const research = await researchStarted;
    const states = new StateStore(runDirectory);
    events.deliver("subagent:control-intercom", {
      runId: "pi-ketch.researcher-1",
      reason: "need_decision",
    });
    const waiting = await states.loadState();
    expect(waiting.phase).toBe("gathering-context");
    expect(waiting.block).toBeUndefined();
    expect(waiting.planning.context.researchRef).toBeUndefined();
    expect(settled).toBe(false);
    expect(events.emitted).toHaveLength(2);
    events.complete(
      research,
      "pi-ketch.researcher-1",
      "complete",
      "research after supervisor reply",
    );
    const result = await start;
    expect(result.state.phase).toBe("clarifying");
    const store = new ArtifactStore(result.runDirectory);
    expect(
      await store.readText(result.state.planning.context.researchRef!),
    ).toBe("research after supervisor reply");
    events.complete(research, "pi-ketch.researcher-1", "complete", "duplicate");
    expect((await states.loadState()).stateRevision).toBe(
      result.state.stateRevision,
    );
    expect(events.emitted).toHaveLength(2);
  });

  test("new-project commands isolate workflows and stop after Scout without workflow-scoped classifier consent", async () => {
    const root = await temporaryRoot();
    const events = new FakeEventBus();
    const runtime = createWorkflowCommandRuntime(events, root, {
      launchResolver: fakeLaunchResolver,
    });
    const tasks = ["ブラウザで遊べるリバーシゲーム", "別のプロジェクトの時計"];
    const started = await Promise.all(
      tasks.map((task) =>
        runtime.start({
          task,
          playbook: "new-project",
          context: { requiresClarification: true },
        }),
      ),
    );
    const requests = events.emitted.map(({ payload }) => childRequest(payload));
    expect(requests).toHaveLength(2);
    for (const [index, workflow] of started.entries()) {
      expect(workflow.state.phase).toBe("blocked");
      expect(workflow.state.block?.reason).toBe("operator-attention-required");
      const children = requests.filter(
        (request) => request.ownerRunId === workflow.workflowId,
      );
      expect(children.map((request) => request.agent)).toEqual([
        "workflow-scout",
      ]);
      for (const child of children) {
        expect(child.cwd).toBe(root);
        expect(child.context).toBe("fresh");
        expect(child.task).toContain(JSON.stringify(tasks[index]));
        expect(child.task).not.toContain(tasks[1 - index]);
        expect(child.task).toContain(JSON.stringify(workflow.taskRef));
      }
      expect(workflow.state.planning.context.scoutRef).toBeDefined();
      expect(workflow.state.planning.stageDecisionRefs).toEqual({});
    }
  });
});
