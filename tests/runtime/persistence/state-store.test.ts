import * as fs from "node:fs/promises";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  parseWorkflowState,
  type WorkflowState,
} from "../../../src/core/workflow/state.ts";
import {
  StateRevisionConflictError,
  StateStore,
  type StateFileSystem,
} from "../../../src/runtime/persistence/state-store.ts";

const hash = "a".repeat(64);
const roots: string[] = [];

function makeState(): WorkflowState {
  return parseWorkflowState({
    schemaVersion: 1,
    workflowId: "workflow-1",
    stateRevision: 0,
    playbook: "feature",
    phase: "gathering-context",
    taskRef: {
      kind: "task",
      path: "context/task.json",
      schemaVersion: 1,
      sha256: hash,
    },
    planning: {
      context: {},
      currentPlanVersion: 0,
    },
    coding: {
      implementationRevision: 0,
      reviewRound: 0,
    },
    counters: {
      automatedFixRoundsUsed: 0,
      strongerRetriesUsed: 0,
      humanCodeFeedbackRounds: 0,
    },
    external: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

async function makeRunDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-orchestrator-state-"));
  roots.push(root);
  return root;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("StateStore", () => {
  test("writes and loads an invariant-checked state with a monotonically increasing revision", async () => {
    const root = await makeRunDirectory();
    const store = new StateStore(root);

    const first = await store.saveState(makeState());
    expect(first.stateRevision).toBe(1);
    expect(await store.loadState()).toEqual(first);

    const next = await store.saveState({ ...first, phase: "planning" });
    expect(next.stateRevision).toBe(2);
    expect((await store.loadState()).phase).toBe("planning");
  });

  test("rejects a stale writer without replacing the newer state", async () => {
    const root = await makeRunDirectory();
    const store = new StateStore(root);
    await store.saveState(makeState());

    const writerA = await store.loadState();
    const writerB = await store.loadState();
    await store.saveState({ ...writerA, phase: "planning" });

    await expect(
      store.saveState({ ...writerB, phase: "gathering-context" }),
    ).rejects.toBeInstanceOf(StateRevisionConflictError);
    expect((await store.loadState()).phase).toBe("planning");
  });

  test("serializes concurrent saves so one stale writer cannot overwrite the other", async () => {
    const root = await makeRunDirectory();
    const store = new StateStore(root);
    await store.saveState(makeState());
    const writerA = await store.loadState();
    const writerB = await store.loadState();

    const results = await Promise.allSettled([
      store.saveState({ ...writerA, phase: "planning" }),
      store.saveState({ ...writerB, phase: "gathering-context" }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect((await store.loadState()).stateRevision).toBe(2);
  });

  test("rejects malformed or invariant-invalid state on load", async () => {
    const root = await makeRunDirectory();
    const store = new StateStore(root);
    await writeFile(join(root, "state.json"), "{not-json", "utf8");
    await expect(store.loadState()).rejects.toThrow(/state/i);

    await writeFile(
      join(root, "state.json"),
      JSON.stringify({ ...makeState(), phase: "implementing" }),
      "utf8",
    );
    await expect(store.loadState()).rejects.toThrow(/state/i);
  });

  test("does not publish a new state when rename fails", async () => {
    const root = await makeRunDirectory();
    const initialStore = new StateStore(root);
    const initial = await initialStore.saveState(makeState());
    const failingFs: StateFileSystem = {
      mkdir: fs.mkdir,
      open: fs.open,
      rename: async () => {
        throw new Error("simulated rename interruption");
      },
      unlink: fs.unlink,
      lstat: fs.lstat,
      readFile,
    };
    const store = new StateStore(root, { filesystem: failingFs });

    await expect(
      store.saveState({ ...initial, phase: "planning" }),
    ).rejects.toThrow(/rename interruption/);
    expect(await store.loadState()).toEqual(initial);
    expect(
      (await readdir(root)).filter((name) => name.includes("state.json")),
    ).toEqual(["state.json"]);
    expect(await exists(join(root, "state.json"))).toBe(true);
  });

  test("rejects unsafe revisions instead of allowing a non-incrementing save", async () => {
    const root = await makeRunDirectory();
    const store = new StateStore(root);
    await writeFile(
      join(root, "state.json"),
      JSON.stringify({
        ...makeState(),
        stateRevision: Number.MAX_SAFE_INTEGER + 1,
      }),
      "utf8",
    );

    await expect(store.loadState()).rejects.toThrow(/safe integer/i);
  });

  test("validates invariants before writing", async () => {
    const root = await makeRunDirectory();
    const store = new StateStore(root);
    const initial = await store.saveState(makeState());

    await expect(
      store.saveState({
        ...initial,
        phase: "implementing",
        planning: { ...initial.planning, approvedPlanRef: undefined },
      }),
    ).rejects.toThrow(/state|invariant/i);
    expect(await store.loadState()).toEqual(initial);
  });
});
