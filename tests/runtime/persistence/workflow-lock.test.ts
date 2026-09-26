import * as fs from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  WorkflowLock,
  WorkflowLockUnavailableError,
  type WorkflowLockFileSystem,
} from "../../../src/runtime/persistence/workflow-lock.ts";

const roots: string[] = [];

async function makeRunDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-orchestrator-lock-"));
  roots.push(root);
  return root;
}

function barrier(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("WorkflowLock", () => {
  test("allows one holder and rejects concurrent holders until release", async () => {
    const root = await makeRunDirectory();
    const first = new WorkflowLock(root);
    const second = new WorkflowLock(root);

    const release = await first.acquire();
    await expect(second.acquire()).rejects.toBeInstanceOf(
      WorkflowLockUnavailableError,
    );

    await release();
    const secondRelease = await second.acquire();
    await secondRelease();
  });

  test("releases the lock when a protected section throws", async () => {
    const root = await makeRunDirectory();
    const lock = new WorkflowLock(root);

    await expect(
      lock.withLock(async () => {
        throw new Error("side effect failed");
      }),
    ).rejects.toThrow(/side effect failed/);

    await expect(lock.acquire()).resolves.toBeTypeOf("function");
  });

  test("does not remove a pre-existing lock when acquisition fails", async () => {
    const root = await makeRunDirectory();
    await fs.writeFile(join(root, ".workflow.lock"), "owner", "utf8");
    const lock = new WorkflowLock(root);

    await expect(lock.acquire()).rejects.toBeInstanceOf(
      WorkflowLockUnavailableError,
    );
    await expect(
      fs.readFile(join(root, ".workflow.lock"), "utf8"),
    ).resolves.toBe("owner");
  });

  test.each(["hard-link", "exclusive-open"])(
    "fails closed for concurrent dead-owner reclamation (%s)",
    async (publication) => {
      const root = await makeRunDirectory();
      const lockPath = join(root, ".workflow.lock");
      const deadPid = 2_147_483_647;
      const staleMetadata = JSON.stringify({
        pid: deadPid,
        token: "dead-owner",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      });
      await fs.writeFile(lockPath, staleMetadata);
      const kill = process.kill.bind(process);
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === deadPid) {
          throw Object.assign(new Error("dead owner"), { code: "ESRCH" });
        }
        return kill(pid, signal);
      });

      const bothRead = barrier();
      const firstSettled = barrier();
      let staleReads = 0;
      let lockUnlinks = 0;
      const attempts = [0, 1].map((index) => {
        const filesystem: WorkflowLockFileSystem = {
          mkdir: fs.mkdir,
          open: fs.open,
          ...(publication === "hard-link" ? { link: fs.link } : {}),
          lstat: fs.lstat,
          readFile: async (path) => {
            const bytes = await fs.readFile(path);
            if (path === lockPath && bytes.toString() === staleMetadata) {
              // Old code: both contenders read the same dead owner.
              staleReads += 1;
              if (staleReads === 2) bothRead.resolve();
              await bothRead.promise;
            }
            return bytes;
          },
          unlink: async (path) => {
            if (path === lockPath) {
              lockUnlinks += 1;
              // Old code: B deletes A's replacement only after A acquires it.
              if (index === 1) await firstSettled.promise;
            }
            await fs.unlink(path);
          },
        };
        return new WorkflowLock(root, { filesystem }).acquire().finally(() => {
          // Fail-closed acquisition never reads metadata; do not wait for it.
          bothRead.resolve();
          if (index === 0) firstSettled.resolve();
        });
      });
      const results = await Promise.allSettled(attempts);
      try {
        expect(
          results.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(0);
        for (const result of results) {
          if (result.status === "rejected") {
            expect(result.reason).toBeInstanceOf(WorkflowLockUnavailableError);
          }
        }
        expect(lockUnlinks).toBe(0);
        expect(await fs.readFile(lockPath, "utf8")).toBe(staleMetadata);
      } finally {
        bothRead.resolve();
        firstSettled.resolve();
        await Promise.all(
          results.map((result) =>
            result.status === "fulfilled"
              ? result.value().catch(() => undefined)
              : Promise.resolve(),
          ),
        );
      }
    },
  );

  test("cleans up a lock when writing its owner metadata fails", async () => {
    const root = await makeRunDirectory();
    const failingFs: WorkflowLockFileSystem = {
      mkdir: fs.mkdir,
      open: async (path, flags, mode) => {
        const handle = await fs.open(path, flags, mode);
        if (!path.endsWith(".workflow.lock")) return handle;
        return {
          writeFile: async () => {
            throw new Error("metadata write failed");
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
      unlink: fs.unlink,
      readFile: fs.readFile,
      lstat: fs.lstat,
    };
    const failingLock = new WorkflowLock(root, { filesystem: failingFs });

    await expect(failingLock.acquire()).rejects.toThrow(
      /metadata write failed/,
    );
    await expect(fs.stat(join(root, ".workflow.lock"))).rejects.toThrow();
    await expect(new WorkflowLock(root).acquire()).resolves.toBeTypeOf(
      "function",
    );
  });

  test("can retry release after an unlink failure", async () => {
    const root = await makeRunDirectory();
    let failUnlink = true;
    const flakyFs: WorkflowLockFileSystem = {
      mkdir: fs.mkdir,
      open: fs.open,
      unlink: async (path) => {
        if (failUnlink && path.endsWith(".workflow.lock")) {
          failUnlink = false;
          throw new Error("unlink failed");
        }
        await fs.unlink(path);
      },
      readFile: fs.readFile,
      lstat: fs.lstat,
    };
    const lock = new WorkflowLock(root, { filesystem: flakyFs });
    const release = await lock.acquire();

    await expect(release()).rejects.toThrow(/unlink failed/);
    await expect(release()).resolves.toBeUndefined();
    await expect(lock.acquire()).resolves.toBeTypeOf("function");
  });

  test("never releases another owner's replacement lock", async () => {
    const root = await makeRunDirectory();
    const first = new WorkflowLock(root);
    const second = new WorkflowLock(root);
    const third = new WorkflowLock(root);
    const firstRelease = await first.acquire();
    await fs.unlink(first.lockPath);
    const secondRelease = await second.acquire();

    await expect(firstRelease()).rejects.toThrow(/ownership/);
    await expect(third.acquire()).rejects.toBeInstanceOf(
      WorkflowLockUnavailableError,
    );
    await secondRelease();
  });
});
