import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  ArtifactStore,
  type ArtifactFileSystem,
  validateArtifactRef,
} from "../../../src/runtime/persistence/artifact-store.ts";

const roots: string[] = [];

function parsePayload(value: unknown): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1
  ) {
    throw new Error("invalid payload");
  }
  return value;
}

async function makeRunDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-orchestrator-artifacts-"));
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

describe("ArtifactStore", () => {
  test("writes atomically, returns a content-verified ref, and creates only the needed directory", async () => {
    const root = await makeRunDirectory();
    const store = new ArtifactStore(root);
    const content = "# Plan\n\nImplement the artifact store.\n";

    expect(await readdir(root)).toEqual([]);

    const ref = await store.writeText("plan", "plan-v1.md", content);

    expect(ref).toEqual({
      kind: "plan",
      path: "plans/plan-v1.md",
      schemaVersion: 1,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
    expect(await store.readText(ref)).toBe(content);
    expect(await exists(join(root, "plans"))).toBe(true);
    expect(await exists(join(root, "architecture"))).toBe(false);
    expect(validateArtifactRef(ref)).toEqual(ref);
  });

  test("validates JSON before commit and validates it again when read", async () => {
    const root = await makeRunDirectory();
    const store = new ArtifactStore(root);
    const payload = { schemaVersion: 1, planVersion: 1 };

    const ref = await store.writeJson(
      "execution-routing",
      "execution-routing-1.json",
      payload,
      parsePayload,
    );

    expect(await store.readJson(ref, parsePayload)).toEqual(payload);

    await expect(
      store.writeJson("plan", "plan-v1.md", payload, parsePayload),
    ).rejects.toThrow(/\.json/);

    await expect(
      store.write("execution-routing", "invalid.json", '{"schemaVersion":', {
        schema: parsePayload,
      }),
    ).rejects.toThrow();
    expect(await exists(join(root, "decisions", "invalid.json"))).toBe(false);
  });

  test("treats a predicate returning false as schema failure before commit", async () => {
    const root = await makeRunDirectory();
    const store = new ArtifactStore(root);

    await expect(
      store.writeJson(
        "execution-routing",
        "invalid-predicate.json",
        { schemaVersion: 1 },
        () => false,
      ),
    ).rejects.toThrow(/schema/i);
    expect(
      await exists(join(root, "decisions", "invalid-predicate.json")),
    ).toBe(false);
  });

  test("rejects a hash mismatch instead of returning corrupted content", async () => {
    const root = await makeRunDirectory();
    const store = new ArtifactStore(root);
    const ref = await store.writeText("scout", "scout.md", "original");

    await fs.writeFile(join(root, ref.path), "tampered", "utf8");

    await expect(store.readText(ref)).rejects.toThrow(/hash/i);
  });

  test("rejects a reference whose path does not match its kind", async () => {
    const root = await makeRunDirectory();
    const store = new ArtifactStore(root);
    const ref = await store.writeText("plan", "plan-v1.md", "plan");

    expect(() => validateArtifactRef({ ...ref, kind: "scout" })).toThrow(
      /does not match kind/,
    );
  });

  test("rejects immutable overwrites", async () => {
    const root = await makeRunDirectory();
    const store = new ArtifactStore(root);
    const ref = await store.writeText("plan", "plan-v1.md", "first");

    await expect(
      store.writeText("plan", "plan-v1.md", "second"),
    ).rejects.toThrow(/immutable/i);
    expect(await store.readText(ref)).toBe("first");
  });

  test("cleans up an interrupted temporary write without publishing a ref", async () => {
    const root = await makeRunDirectory();
    const interruptedFs: ArtifactFileSystem = {
      mkdir: fs.mkdir,
      open: async (path, flags, mode) => {
        const handle = await fs.open(path, flags, mode);
        return {
          writeFile: async (data: Uint8Array) => {
            await handle.writeFile(data.subarray(0, 2));
            throw new Error("simulated interruption");
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
      link: fs.link,
      unlink: fs.unlink,
      lstat: fs.lstat,
      readFile,
    };
    const store = new ArtifactStore(root, { filesystem: interruptedFs });

    await expect(
      store.writeText("plan", "plan-v1.md", "complete content"),
    ).rejects.toThrow(/interruption/i);

    expect(await exists(join(root, "plans", "plan-v1.md"))).toBe(false);
    expect(await readdir(join(root, "plans"))).toEqual([]);
  });
});
