import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  phaseCWorkflow,
  type PhaseCWorkflow,
} from "../../fakes/phase-c-workflow.ts";
import { parseWorkerAttempt } from "../../../src/runtime/worker/attempt-evidence.ts";
import { FakeSubagentExecutor } from "../../fakes/index.ts";
import { CodingOrchestrator } from "../../../src/runtime/orchestrator/coding-orchestrator.ts";
import { isCodeReviewAttempt } from "../../../src/core/coding/code-review.ts";
import { verifyCodeReviewSource } from "../../../src/runtime/worker/code-review-source.ts";

const workflows: PhaseCWorkflow[] = [];
afterEach(async () => {
  await Promise.all(workflows.splice(0).map((h) => h.cleanup()));
});
async function setup(script: Parameters<typeof phaseCWorkflow>[0] = {}) {
  const h = await phaseCWorkflow({ nonGit: true, ...script });
  workflows.push(h);
  await h.createPlan();
  await h.settlePlan();
  return h;
}
const workers = (h: PhaseCWorkflow) =>
  h.children.filter((child) => child.agent === "worker");
async function latest(h: PhaseCWorkflow) {
  const state = await h.load();
  return parseWorkerAttempt(
    JSON.parse(await h.artifactStore.readText(state.coding.workerAttemptRef!)),
  );
}

test("normal driver crosses non-Git Worker/Validation/reviews/static Code Gate; recovery never reopens or redispatches", async () => {
  const h = await setup({
    workerChanges: [
      { "modified.txt": "final\n", "deleted.txt": null, "added.txt": "new\n" },
    ],
  });
  await writeFile(join(h.repositoryCwd, "modified.txt"), "original\n");
  await writeFile(join(h.repositoryCwd, "deleted.txt"), "remove\n");
  await writeFile(
    join(h.repositoryCwd, "pre-existing.txt"),
    "retain before-existing content\n",
  );
  const completed = await h.drive();
  expect(completed.state.phase).toBe("completed");
  const attempt = await latest(h);
  expect(attempt.status).toBe("succeeded");
  expect(attempt.before.kind).toBe("filesystem");
  expect(attempt.after?.status).toBe("observed");
  const ref = completed.state.coding.codeReviewAttemptRef!;
  const code = JSON.parse(await h.artifactStore.readText(ref));
  expect(isCodeReviewAttempt(code)).toBe(true);
  expect(code.source.type).toBe("filesystem-patch");
  expect(code.source.workerAttemptRef).toEqual(
    completed.state.coding.workerAttemptRef,
  );
  const patch = await readFile(code.source.patchFile, "utf8");
  expect(patch).toContain("-original");
  expect(patch).toContain("+final");
  expect(patch).toContain("-remove");
  expect(patch).toContain("+new");
  expect(patch).not.toContain("pre-existing.txt");
  expect(patch).not.toContain(".pi/orchestrator");
  expect(h.gates.filter((gate) => gate.action === "code-review")).toEqual([
    {
      action: "code-review",
      payload: { cwd: code.source.cwd, patchFile: code.source.patchFile },
    },
  ]);
  await verifyCodeReviewSource(code.source, h.artifactStore.rootDirectory);
  expect((await h.settleCode(true)).state).toEqual(completed.state);
  expect((await h.resume()).state).toEqual(completed.state);
  expect(workers(h)).toHaveLength(1);
  expect(h.gates.filter((gate) => gate.action === "code-review")).toHaveLength(
    1,
  );
});

test("Human feedback Fix keeps the original retained baseline, including cumulative modifications/deletions", async () => {
  const h = await setup({
    codeReviews: ["feedback", "approved"],
    workerChanges: [
      { "source.txt": "first\n", "deleted.txt": null },
      { "source.txt": "second\n" },
    ],
  });
  await writeFile(join(h.repositoryCwd, "source.txt"), "original\n");
  await writeFile(join(h.repositoryCwd, "deleted.txt"), "baseline deletion\n");
  const result = await h.drive();
  expect(result.state.phase).toBe("completed");
  expect(workers(h)).toHaveLength(2);
  const code = JSON.parse(
    await h.artifactStore.readText(result.state.coding.codeReviewAttemptRef!),
  );
  const patch = await readFile(code.source.patchFile, "utf8");
  expect(patch).toContain("-original");
  expect(patch).toContain("+second");
  expect(patch).toContain("-baseline deletion");
  expect(patch).not.toContain("-first");
  expect(result.state.counters.humanCodeFeedbackRounds).toBe(1);
});

test.each(["before-code", "during-code", "before-fix", "provider"])(
  "out-of-band %s drift grants no further authority",
  async (when) => {
    const h = await setup({ codeReviews: ["feedback"] });
    await h.implement();
    await h.validate();
    await h.review();
    await h.evaluate();
    await h.decide();
    const state = await h.load();
    expect(state.phase).toBe("awaiting-code-review");
    if (when === "provider") {
      await promisify(execFile)("git", ["init", "--quiet", h.repositoryCwd]);
      await expect(h.openCode()).rejects.toThrow(/provider|observation/iu);
    } else if (when === "before-code") {
      await writeFile(join(h.repositoryCwd, "unseen.txt"), "out of band");
      await expect(h.openCode()).rejects.toThrow(/changed/iu);
    } else if (when === "before-fix") {
      await h.openCode();
      await writeFile(join(h.repositoryCwd, "unseen.txt"), "out of band");
      await expect(h.implement()).rejects.toThrow(/Workspace changed/iu);
    } else {
      const h2 = await setup({ staleCodeStatus: true });
      const result = await h2.drive();
      expect(result.state.phase).not.toBe("completed");
      expect(result.state.coding.latestCodeReviewRef).toBeUndefined();
      expect(workers(h2)).toHaveLength(1);
    }
    expect(workers(h)).toHaveLength(1);
    expect((await h.load()).phase).not.toBe("completed");
  },
);

test("proven non-dispatch retains the original provider baseline across recovery", async () => {
  const h = await setup();
  const executor = new FakeSubagentExecutor({
    run: {
      type: "result",
      value: { status: "failed", notDispatched: true, error: "unavailable" },
    },
  });
  await expect(
    new CodingOrchestrator({ ...h, subagentExecutor: executor }).execute({
      state: await h.load(),
    }),
  ).rejects.toThrow();
  const before = await h.load();
  expect(before.coding.workspaceBaselineRef).toBeDefined();
  await promisify(execFile)("git", ["init", "--quiet", h.repositoryCwd]);
  const resumed = await h.resume();
  expect(resumed.state.phase).toBe("blocked");
  expect(resumed.state.coding.workspaceBaselineRef).toEqual(
    before.coding.workspaceBaselineRef,
  );
  expect(workers(h)).toHaveLength(0);
});

test("pending Worker recovery preserves filesystem provider; mismatch blocks with zero redispatch", async () => {
  const h = await setup({ workers: ["timeout"] });
  await expect(h.implement()).rejects.toThrow();
  expect((await latest(h)).before.kind).toBe("filesystem");
  const requests = workers(h).length;
  await promisify(execFile)("git", ["init", "--quiet", h.repositoryCwd]);
  const resumed = await h.resume();
  expect(resumed.state.phase).toBe("blocked");
  expect(workers(h)).toHaveLength(requests);
  expect(resumed.state.coding.implementationRef).toBeUndefined();
});

test.each([false, true])(
  "filesystem Worker success-before-State recovery detects out-of-band drift=%s without another Worker",
  async (drifted) => {
    const h = await setup();
    const save = h.stateStore.saveState.bind(h.stateStore);
    h.stateStore.saveState = async (state, revision) => {
      if (state.phase === "validating")
        throw Error("after-success State fault");
      return save(state, revision);
    };
    await expect(h.implement()).rejects.toThrow("after-success State fault");
    h.stateStore.saveState = save;
    if (drifted)
      await writeFile(join(h.repositoryCwd, "unseen.txt"), "not Worker output");
    const result = await h.resume();
    expect(result.state.phase).toBe(drifted ? "blocked" : "completed");
    expect(workers(h)).toHaveLength(1);
    expect((await latest(h)).before.kind).toBe("filesystem");
  },
);

test("missing/tampered retained baseline blocks Code Review and cannot produce an approval", async () => {
  const h = await setup();
  const completed = await h.drive();
  const code = JSON.parse(
    await h.artifactStore.readText(
      completed.state.coding.codeReviewAttemptRef!,
    ),
  );
  await rm(join(h.artifactStore.rootDirectory, code.source.baselineRef.path));
  await expect(
    verifyCodeReviewSource(code.source, h.artifactStore.rootDirectory),
  ).rejects.toThrow();
  await expect(h.settleCode(true)).rejects.toThrow();
  expect(workers(h)).toHaveLength(1);
});
