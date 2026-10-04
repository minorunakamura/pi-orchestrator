import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { scenario, routing, gate } from "../../fakes/coding-scenario.ts";
import {
  FakeJevDecisionClient,
  FakePlannotatorGate,
  failure,
} from "../../fakes/index.ts";
import {
  CodingOrchestrator,
  parseCodeReviewArtifact,
} from "../../../src/runtime/orchestrator/coding-orchestrator.ts";
import { RoundDecisionRunner } from "../../../src/runtime/orchestrator/round-decision.ts";
import type { CodeReviewResult } from "../../../src/runtime/ports/index.ts";
import { isCodeReviewAttempt } from "../../../src/core/coding/code-review.ts";
import { safeWorkflowId } from "../../../src/types.ts";
import { StateStore } from "../../../src/runtime/persistence/state-store.ts";
import { ArtifactStore } from "../../../src/runtime/persistence/artifact-store.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function ready() {
  const f = await scenario(
    new FakeJevDecisionClient({
      routeExecution: { type: "result", value: routing },
      decideRound: {
        type: "result",
        value: { decision: "COMPLETE", confidence: 0.99 },
      },
    }),
  );
  roots.push(f.root);
  const round = await new RoundDecisionRunner(f).execute({
    state: f.evaluated.state,
    validation: f.validated.validation,
  });
  return {
    ...f,
    artifactStore: new ArtifactStore(f.runDirectory),
    stateStore: new StateStore(f.runDirectory),
    state: round.state,
  };
}
async function waiting(f: Awaited<ReturnType<typeof ready>>) {
  let resolve!: (result: CodeReviewResult) => void;
  const promise = new Promise<CodeReviewResult>((settle) => {
    resolve = settle;
  });
  const deferred = { promise, resolve };
  const openCodeReview = vi.fn(async () => {
    const state = await f.stateStore.loadState();
    expect(state.coding.codeReviewAttemptRef).toBeDefined();
    expect(state.phase).toBe("awaiting-code-review");
    const attempt = JSON.parse(
      await f.artifactStore.readText(state.coding.codeReviewAttemptRef!),
    );
    expect(isCodeReviewAttempt(attempt)).toBe(true);
    expect(attempt.authority.implementationRef).toEqual(
      state.coding.implementationRef,
    );
    return deferred.promise;
  });
  const coding = new CodingOrchestrator({
    ...f,
    plannotatorGate: { ...gate, openCodeReview },
  });
  const pending = coding.openCodeReview({ state: f.state });
  // Attach a rejection handler before injecting failures into the live request.
  void pending.catch(() => {});
  await vi.waitFor(() => expect(openCodeReview).toHaveBeenCalledOnce());
  const state = await f.stateStore.loadState();
  return {
    coding,
    pending,
    deferred,
    state,
    attemptId: state.coding.codeReview!.attemptId,
    openCodeReview,
  };
}

test.each([true, false])(
  "durably binds settled approval=%s and retains Human notes/annotations",
  async (approved) => {
    const f = await ready();
    const w = await waiting(f);
    const result = {
      approved,
      feedback: "Human notes",
      annotations: [{ line: 1 }],
    };
    w.deferred.resolve(result);
    const settled = await w.pending;
    expect(settled.state.phase).toBe(approved ? "completed" : "fixing");
    expect(settled.state.counters.humanCodeFeedbackRounds).toBe(
      approved ? 0 : 1,
    );
    expect(settled.state.counters.automatedFixRoundsUsed).toBe(0);
    const artifact = parseCodeReviewArtifact(
      JSON.parse(
        await f.artifactStore.readText(
          settled.state.coding.latestCodeReviewRef!,
        ),
      ),
    );
    expect(artifact.result).toEqual(result);
    expect(artifact.attemptRef).toEqual(w.state.coding.codeReviewAttemptRef);
    expect(artifact.implementationRef).toEqual(
      f.state.coding.implementationRef,
    );
    expect(
      Object.keys(settled.state.external).filter((key) =>
        key.startsWith("plannotator.code-review."),
      ),
    ).toEqual([]);
  },
);

test.each(["attempt-artifact", "attempt-state"])(
  "%s failure causes zero Code calls and no automatic retry",
  async (fault) => {
    const f = await ready();
    const fake = new FakePlannotatorGate({
      openCodeReview: { type: "result", value: { approved: true } },
    });
    const coding = new CodingOrchestrator({
      ...f,
      plannotatorGate: fake,
      ...(fault === "attempt-artifact"
        ? {
            artifactStore: {
              rootDirectory: f.artifactStore.rootDirectory,
              readText: f.artifactStore.readText.bind(f.artifactStore),
              writeText: f.artifactStore.writeText.bind(f.artifactStore),
              writeJson: async () => {
                throw Error("intent Artifact failed");
              },
            },
          }
        : {
            stateStore: {
              saveState: async () => {
                throw Error("intent State failed");
              },
            },
          }),
    });
    await expect(coding.openCodeReview({ state: f.state })).rejects.toThrow(
      /intent/iu,
    );
    expect(fake.calls.openCodeReview).toHaveLength(0);
    if (fault === "attempt-state") {
      await expect(
        new CodingOrchestrator({ ...f, plannotatorGate: fake }).openCodeReview({
          state: f.state,
        }),
      ).rejects.toThrow(/unresolved/iu);
      expect(fake.calls.openCodeReview).toHaveLength(0);
    }
  },
);

test("pending/lost result cannot poll, infer approval or reopen after recreation", async () => {
  const f = await ready();
  const w = await waiting(f);
  const fake = new FakePlannotatorGate();
  const recreated = new CodingOrchestrator({ ...f, plannotatorGate: fake });
  await expect(recreated.openCodeReview({ state: w.state })).rejects.toThrow(
    /unresolved/iu,
  );
  const missingBinding = structuredClone(w.state);
  delete missingBinding.coding.codeReview;
  await expect(
    recreated.openCodeReview({ state: missingBinding }),
  ).rejects.toThrow(/unresolved/iu);
  await expect(
    recreated.reconcileCodeReview({ state: w.state, attemptId: w.attemptId }),
  ).rejects.toThrow(/explicit recovery/iu);
  expect(fake.calls.openCodeReview).toHaveLength(0);
  expect(fake.calls.getPlanReview).toHaveLength(0);
  w.deferred.resolve({ approved: true });
  await w.pending;
});

test.each(["workspace", "patch", "implementation", "attempt"])(
  "rejects %s tampering during Human wait",
  async (damage) => {
    const f = await ready();
    const w = await waiting(f);
    const attempt = JSON.parse(
      await f.artifactStore.readText(w.state.coding.codeReviewAttemptRef!),
    );
    if (damage === "workspace")
      await writeFile(join(f.repositoryCwd, "changed.txt"), "unseen");
    else if (damage === "patch")
      await writeFile(attempt.source.patchFile, "tampered patch");
    else if (damage === "attempt")
      await writeFile(
        join(
          f.artifactStore.rootDirectory,
          w.state.coding.codeReviewAttemptRef!.path,
        ),
        "{}",
      );
    else
      await writeFile(
        join(
          f.artifactStore.rootDirectory,
          f.state.coding.implementationRef!.path,
        ),
        "{}",
      );
    w.deferred.resolve({ approved: true });
    await expect(w.pending).rejects.toThrow();
    const current = await f.stateStore.loadState();
    expect(current.phase).toBe("awaiting-code-review");
    expect(current.coding.latestCodeReviewRef).toBeUndefined();
  },
);

test.each(["attemptId", "implementationRef", "revision", "workflow"])(
  "rejects %s mismatch, using current durable State rather than a stale callback snapshot",
  async (dimension) => {
    const f = await ready();
    const w = await waiting(f);
    if (dimension === "attemptId") {
      await expect(
        w.coding.applyCodeReview({
          state: w.state,
          attemptId: "different",
          result: { approved: true },
        }),
      ).rejects.toThrow(/binding/iu);
      w.deferred.resolve({ approved: true });
      await w.pending;
      return;
    }
    const changed = structuredClone(w.state);
    if (dimension === "implementationRef")
      changed.coding.implementationRef = {
        ...changed.coding.implementationRef!,
        sha256: "f".repeat(64),
      };
    if (dimension === "revision") changed.coding.implementationRevision++;
    if (dimension === "workflow") changed.workflowId = safeWorkflowId("other");
    // Simulate out-of-process corruption; StateStore rightly rejects inconsistent writes.
    await writeFile(
      join(f.artifactStore.rootDirectory, "state.json"),
      JSON.stringify(changed),
    );
    w.deferred.resolve({ approved: true });
    await expect(w.pending).rejects.toThrow();
  },
);

test("result-before-State publication failure recovers exact durable result with zero Gate calls", async () => {
  const f = await ready();
  let failed = false;
  const coding = new CodingOrchestrator({
    ...f,
    stateStore: {
      saveState: async (state, revision) => {
        if (state.phase === "completed" && !failed) {
          failed = true;
          expect(state.coding.latestCodeReviewRef).toBeDefined();
          await f.artifactStore.readText(state.coding.latestCodeReviewRef!);
          throw Error("result State failed");
        }
        return f.stateStore.saveState(state, revision);
      },
    },
  });
  await expect(coding.openCodeReview({ state: f.state })).rejects.toThrow(
    "result State failed",
  );
  const state = await f.stateStore.loadState();
  expect(state.phase).toBe("awaiting-code-review");
  const fake = new FakePlannotatorGate();
  const recovered = await new CodingOrchestrator({
    ...f,
    plannotatorGate: fake,
  }).reconcileCodeReview({
    state,
    attemptId: state.coding.codeReview!.attemptId,
  });
  expect(recovered.state.phase).toBe("completed");
  expect(fake.calls.openCodeReview).toHaveLength(0);
});

test("result Artifact failure grants no authority and cannot reopen", async () => {
  const f = await ready();
  let calls = 0;
  const coding = new CodingOrchestrator({
    ...f,
    plannotatorGate: {
      ...gate,
      openCodeReview: async () => {
        calls++;
        return { approved: true };
      },
    },
    artifactStore: {
      rootDirectory: f.artifactStore.rootDirectory,
      readText: f.artifactStore.readText.bind(f.artifactStore),
      writeText: f.artifactStore.writeText.bind(f.artifactStore),
      writeJson: async (kind, name, value, parser) => {
        if (name.startsWith("result-")) throw Error("result Artifact failed");
        return f.artifactStore.writeJson(kind, name, value, parser);
      },
    },
  });
  await expect(coding.openCodeReview({ state: f.state })).rejects.toThrow(
    "result Artifact failed",
  );
  const state = await f.stateStore.loadState();
  expect(state.phase).toBe("awaiting-code-review");
  expect(state.coding.latestCodeReviewRef).toBeUndefined();
  await expect(coding.openCodeReview({ state })).rejects.toThrow(
    /unresolved/iu,
  );
  expect(calls).toBe(1);
});

test("identical duplicates preserve current advanced State; changed settled results reject", async () => {
  const f = await ready();
  const w = await waiting(f);
  w.deferred.resolve({ approved: true });
  const settled = await w.pending;
  const before = await readFile(
    join(f.artifactStore.rootDirectory, "state.json"),
    "utf8",
  );
  const duplicate = await w.coding.applyCodeReview({
    state: w.state,
    attemptId: w.attemptId,
    result: { approved: true },
  });
  expect(duplicate.state).toEqual(settled.state);
  expect(
    await readFile(join(f.artifactStore.rootDirectory, "state.json"), "utf8"),
  ).toBe(before);
  await expect(
    w.coding.applyCodeReview({
      state: settled.state,
      attemptId: w.attemptId,
      result: { approved: false },
    }),
  ).rejects.toThrow(/Changed settled/iu);
  expect(
    (await readdir(join(f.artifactStore.rootDirectory, "code-reviews"))).filter(
      (path) => path.startsWith("result-"),
    ),
  ).toHaveLength(1);
});

test("explicit unavailable transport blocks and leaves the attempt as a recovery barrier", async () => {
  const f = await ready();
  const fake = new FakePlannotatorGate({
    openCodeReview: failure("infrastructure", "unavailable"),
  });
  const result = await new CodingOrchestrator({
    ...f,
    plannotatorGate: fake,
  }).openCodeReview({ state: f.state });
  expect(result.state.block?.reason).toBe("human-gate-unavailable");
  expect(result.state.coding.codeReviewAttemptRef).toBeDefined();
});

test("legacy external Code identity cannot be silently translated into local authority", async () => {
  const f = await ready();
  f.state.external["plannotator.code-review.r1"] = "legacy";
  const fake = new FakePlannotatorGate();
  await expect(
    new CodingOrchestrator({ ...f, plannotatorGate: fake }).openCodeReview({
      state: f.state,
    }),
  ).rejects.toThrow(/unresolved/iu);
  expect(fake.calls.openCodeReview).toHaveLength(0);
});
