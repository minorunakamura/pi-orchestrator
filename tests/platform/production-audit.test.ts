import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { phaseCWorkflow } from "../fakes/phase-c-workflow.ts";
import { auditProductionWorkflow } from "./production-audit.ts";

test.each([false, true])(
  "read-only Git/non-Git audit (%s) requires both Gates and rejects corrupt retained evidence",
  async (nonGit) => {
    const h = await phaseCWorkflow({
      nonGit,
      task: "[regression] Implement the approved feature",
    });
    try {
      await h.drive();
      await expect(auditProductionWorkflow(h.repositoryCwd)).rejects.toThrow(
        /Both Human Gates/u,
      );
      await h.drive();
      const before = h.children.length;
      const audit = await auditProductionWorkflow(h.repositoryCwd);
      expect(audit.state.phase).toBe("completed");
      expect(audit.codeAttempt.source.type).toBe(
        nonGit ? "filesystem-patch" : "git-patch",
      );
      expect(Object.keys(audit.refs).length).toBeGreaterThan(20);
      expect(h.children).toHaveLength(before);
      const state = await h.load();
      const originalTask = state.taskRef;
      state.taskRef = { ...originalTask, path: "../outside.md" };
      await h.stateStore.saveState(state, state.stateRevision);
      await expect(auditProductionWorkflow(h.repositoryCwd)).rejects.toThrow(
        /Invalid artifact path/u,
      );
      const restored = await h.load();
      restored.taskRef = originalTask;
      await h.stateStore.saveState(restored, restored.stateRevision);
      await writeFile(
        join(audit.root, audit.worker.approvedPlanRef.path),
        "tampered",
      );
      await expect(auditProductionWorkflow(h.repositoryCwd)).rejects.toThrow();
      expect(h.children).toHaveLength(before);
    } finally {
      await h.cleanup();
    }
  },
  20000,
);
