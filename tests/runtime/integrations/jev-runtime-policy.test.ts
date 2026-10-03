import {
  mkdtemp,
  rm,
  readdir,
  readFile,
  writeFile,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  nativeRuntime,
  firstChoices,
  classification,
} from "../../fakes/classifier.ts";
import {
  JevIntegration,
  type PiClassifierRuntime,
} from "../../../src/runtime/integrations/jev.ts";
import { JevAuthorization } from "../../../src/runtime/orchestrator/jev-authorization.ts";
import { createWorkflow as startWorkflow } from "../../../src/runtime/orchestrator/start-workflow.ts";
import { FakeSubagentExecutor } from "../../fakes/index.ts";
import { StateStore } from "../../../src/runtime/persistence/state-store.ts";
import { succeeded, decisionEvidence } from "../../fakes/coding-scenario.ts";
import { jevPolicy } from "../../fakes/jev-policy.ts";
import { safeWorkflowId } from "../../../src/types.ts";
import type { ExecutionRoutingInput } from "../../../src/runtime/ports/jev-decision-client.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(maxRequests = 4) {
  const root = await mkdtemp(join(tmpdir(), "jev-policy-"));
  roots.push(root);
  const started = await startWorkflow(
    { task: "test policy", playbook: "feature", cwd: root },
    {
      runsDirectory: root,
      workflowIdFactory: () => "policy-workflow",
      subagentExecutor: new FakeSubagentExecutor({ run: succeeded("facts") }),
    },
  );
  return {
    ...started,
    root,
    configuration: jevPolicy(started.state.projectRoot, maxRequests),
  };
}
const request: ExecutionRoutingInput = {
  approvedPlanRef: decisionEvidence.plan.ref,
  planEvidence: { summary: "scope", relevantSections: [] },
  playbook: "feature",
  changeScope: "scope",
  contextRefs: [],
  contextEvidence: [],
  priorRetryCount: 0,
};
function fakeClient(failFirst = false) {
  let calls = 0;
  const client: PiClassifierRuntime = nativeRuntime(async (_model, value) => {
    calls++;
    if (failFirst && calls === 1)
      return classification({}, { stopReason: "aborted" });
    return firstChoices(value);
  });
  return {
    client,
    get calls() {
      return calls;
    },
  };
}

test.each([
  "missing",
  "revoked",
  "workflow",
  "project",
  "destination",
  "categories",
  "exhausted",
])("%s permission makes zero outbound requests", async (mode) => {
  const f = await fixture();
  const configuration = structuredClone(f.configuration);
  if (mode === "missing") delete configuration.runtimePolicy;
  else if (mode === "revoked")
    configuration.runtimePolicy!.grant.active = false;
  else if (mode === "workflow") f.state = { ...f.state, jevUsage: undefined };
  else if (mode === "project")
    configuration.runtimePolicy!.grant.projectRoot = "other";
  else if (mode === "destination")
    configuration.runtimePolicy!.grant.destination = "https://other.test";
  else if (mode === "categories")
    configuration.runtimePolicy!.grant.evidenceCategories = [];
  else configuration.runtimePolicy!.maxRequests = 0;
  const auth = new JevAuthorization(
    f.state,
    configuration,
    f.artifactStore,
    f.stateStore,
    "routing",
    ["plan", "context"],
  );
  const fake = fakeClient();
  await expect(
    new JevIntegration({ modelRegistry: fake.client }).routeExecution(
      request,
      auth.context,
    ),
  ).rejects.toMatchObject({ kind: "policy" });
  expect(fake.calls).toBe(0);
});

test("generated workflow IDs get exact durable consent before the first native request", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-generated-"));
  roots.push(root);
  // Settings exist before any workflow/UUID; no workflowId is part of the grant.
  const configuration = jevPolicy(root, 1);
  const f = await startWorkflow(
    { task: "bounded evidence", playbook: "chore", cwd: root },
    {
      runsDirectory: root,
      subagentExecutor: new FakeSubagentExecutor({ run: succeeded("facts") }),
    },
  );
  expect(f.workflowId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(configuration.runtimePolicy!.grant).not.toHaveProperty("workflowId");
  let calls = 0;
  const client = nativeRuntime(async (_model, input) => {
    calls++;
    const state = await new StateStore(f.runDirectory).loadState();
    const binding = JSON.parse(
      await f.artifactStore.readText!(state.jevUsage!.authorizationRef!),
    );
    const reservation = JSON.parse(
      await f.artifactStore.readText!(state.jevUsage!.latestRequestRef!),
    );
    expect(binding).toMatchObject({
      recordType: "authorization",
      workflowId: f.workflowId,
      projectRoot: await realpath(root),
      grantId: configuration.runtimePolicy!.grant.id,
      destination: "typesafe/jev-latest",
      maxRequests: 1,
    });
    expect(reservation.authorizationRef).toEqual(
      state.jevUsage!.authorizationRef,
    );
    expect(reservation.consentId).toBe(binding.consentId);
    expect(state.jevUsage!.attemptsReserved).toBe(1);
    return firstChoices(input);
  });
  await new JevIntegration({ modelRegistry: client }).routeExecution(
    request,
    new JevAuthorization(
      f.state,
      configuration,
      f.artifactStore,
      f.stateStore,
      "routing",
      ["plan"],
    ).context,
  );
  expect(calls).toBe(1);
});

test.each([
  "workflow",
  "project",
  "classifier-provider",
  "classifier-model",
  "grant",
  "policy",
  "revoked",
  "missing-binding",
  "tampered-binding",
])(
  "persisted consent rejects %s drift without rebinding or dispatch",
  async (mode) => {
    const f = await fixture();
    const original = new JevAuthorization(
      f.state,
      f.configuration,
      f.artifactStore,
      f.stateStore,
      "routing",
      ["plan"],
    );
    await original.assertAllowed();
    let state = await new StateStore(f.runDirectory).loadState();
    const configuration = structuredClone(f.configuration);
    const grant = configuration.runtimePolicy!.grant;
    if (mode === "workflow")
      state = {
        ...state,
        workflowId: safeWorkflowId("copied-workflow"),
      };
    if (mode === "project") {
      state = { ...state, projectRoot: process.cwd() };
      grant.projectRoot = process.cwd();
    }
    if (mode === "classifier-provider") {
      configuration.classifier = {
        provider: "openrouter",
        model: "jev-latest",
      };
      grant.destination = "openrouter/jev-latest";
    }
    if (mode === "classifier-model") {
      configuration.classifier = { provider: "typesafe", model: "jev-other" };
      grant.destination = "typesafe/jev-other";
    }
    if (mode === "grant") grant.id = "replacement";
    if (mode === "policy") grant.policyVersion = "replacement";
    if (mode === "revoked") grant.active = false;
    if (mode === "missing-binding")
      state = {
        ...state,
        jevUsage: {
          attemptsReserved: 1,
          latestRequestRef: state.jevUsage!.authorizationRef,
        },
      };
    if (mode === "tampered-binding")
      await writeFile(
        join(f.runDirectory, state.jevUsage!.authorizationRef!.path),
        "{}",
      );
    const fake = fakeClient();
    const auth = new JevAuthorization(
      state,
      configuration,
      f.artifactStore,
      f.stateStore,
      "routing",
      ["plan"],
    );
    await expect(
      new JevIntegration({
        ...configuration,
        modelRegistry: fake.client,
      }).routeExecution(request, auth.context),
    ).rejects.toMatchObject({ kind: "policy" });
    expect(fake.calls).toBe(0);
    expect(
      (await new StateStore(f.runDirectory).loadState()).jevUsage!
        .attemptsReserved,
    ).toBe(0);
    await expect(auth.assertAllowed(false)).rejects.toMatchObject({
      kind: "policy",
    });
  },
);

test("active grant narrowing and widening cannot broaden captured workflow bounds", async () => {
  const f = await fixture(2);
  f.configuration.runtimePolicy!.grant.evidenceCategories = ["plan"];
  const initial = new JevAuthorization(
    f.state,
    f.configuration,
    f.artifactStore,
    f.stateStore,
    "routing",
    ["plan"],
  );
  await initial.assertAllowed();
  const bindingRef = initial.state.jevUsage!.authorizationRef;
  const widened = structuredClone(f.configuration);
  widened.runtimePolicy!.maxRequests = 100;
  widened.runtimePolicy!.grant.evidenceCategories = ["plan", "context"];
  const fake = fakeClient();
  const adapter = new JevIntegration({ modelRegistry: fake.client });
  await expect(
    adapter.routeExecution(
      request,
      new JevAuthorization(
        initial.state,
        widened,
        f.artifactStore,
        f.stateStore,
        "routing",
        ["context"],
      ).context,
    ),
  ).rejects.toMatchObject({ kind: "policy" });
  const first = new JevAuthorization(
    initial.state,
    widened,
    f.artifactStore,
    f.stateStore,
    "routing",
    ["plan"],
  );
  await adapter.routeExecution(request, first.context);
  const narrowed = structuredClone(widened);
  narrowed.runtimePolicy!.maxRequests = 1;
  await expect(
    adapter.routeExecution(
      request,
      new JevAuthorization(
        first.state,
        narrowed,
        f.artifactStore,
        f.stateStore,
        "routing",
        ["plan"],
      ).context,
    ),
  ).rejects.toMatchObject({ kind: "policy" });
  narrowed.runtimePolicy!.maxRequests = 2;
  narrowed.runtimePolicy!.grant.evidenceCategories = [];
  await expect(
    adapter.routeExecution(
      request,
      new JevAuthorization(
        first.state,
        narrowed,
        f.artifactStore,
        f.stateStore,
        "routing",
        ["plan"],
      ).context,
    ),
  ).rejects.toMatchObject({ kind: "policy" });
  const second = new JevAuthorization(
    first.state,
    widened,
    f.artifactStore,
    f.stateStore,
    "routing",
    ["plan"],
  );
  await adapter.routeExecution(request, second.context);
  await expect(
    adapter.routeExecution(
      request,
      new JevAuthorization(
        second.state,
        widened,
        f.artifactStore,
        f.stateStore,
        "routing",
        ["plan"],
      ).context,
    ),
  ).rejects.toMatchObject({ kind: "policy" });
  expect(fake.calls).toBe(2);
  expect(second.state.jevUsage!.authorizationRef).toEqual(bindingRef);
  await expect(
    new JevAuthorization(
      second.state,
      widened,
      f.artifactStore,
      f.stateStore,
      "routing",
      ["plan"],
    ).assertAllowed(false),
  ).resolves.toBeUndefined();
});

test("reservation failure after consent persistence does not dispatch or reset accounting", async () => {
  const f = await fixture();
  const initial = new JevAuthorization(
    f.state,
    f.configuration,
    f.artifactStore,
    f.stateStore,
    "routing",
    ["plan"],
  );
  await initial.assertAllowed();
  const fake = fakeClient();
  const adapter = new JevIntegration({ modelRegistry: fake.client });
  const failed = new JevAuthorization(
    initial.state,
    f.configuration,
    f.artifactStore,
    {
      saveState: async () => {
        throw Error("disk full");
      },
    },
    "routing",
    ["plan"],
  );
  await expect(
    adapter.routeExecution(request, failed.context),
  ).rejects.toMatchObject({ kind: "policy" });
  await expect(
    adapter.routeExecution(
      request,
      new JevAuthorization(
        initial.state,
        f.configuration,
        f.artifactStore,
        f.stateStore,
        "routing",
        ["plan"],
      ).context,
    ),
  ).rejects.toMatchObject({ kind: "policy" });
  expect(fake.calls).toBe(0);
  expect(
    (await new StateStore(f.runDirectory).loadState()).jevUsage!
      .authorizationRef,
  ).toEqual(initial.state.jevUsage!.authorizationRef);
});

test("each finding and retry is durably charged, including across client recreation", async () => {
  const f = await fixture(3);
  const auth = new JevAuthorization(
    f.state,
    f.configuration,
    f.artifactStore,
    f.stateStore,
    "finding",
    ["plan", "review", "implementation"],
  );
  const fake = fakeClient(true);
  const adapter = new JevIntegration({
    modelRegistry: fake.client,
    maxTransportRetries: 1,
  });
  const finding = {
    id: "C1",
    source: "correctness" as const,
    category: "bug",
    summary: "issue",
    evidence: "proof",
    blocking: false,
  };
  const reviewRef = {
    kind: "correctness-review" as const,
    path: "reviews/correctness-1.json",
    sha256: "a".repeat(64),
    schemaVersion: 1 as const,
  };
  await adapter.evaluateFindings(
    {
      approvedPlanRef: request.approvedPlanRef,
      implementationRevision: 1,
      evidence: decisionEvidence,
      reviewRefs: {
        correctness: reviewRef,
        ponytail: { ...reviewRef, kind: "ponytail-review" },
      },
      findings: [finding, { ...finding, id: "C2" }],
    },
    auth.context,
  );
  expect(fake.calls).toBe(3);
  expect(auth.state.jevUsage?.attemptsReserved).toBe(3);
  const reloaded = await new StateStore(f.runDirectory).loadState();
  const resumed = new JevAuthorization(
    reloaded,
    f.configuration,
    f.artifactStore,
    f.stateStore,
    "routing",
    ["plan"],
  );
  await expect(
    new JevIntegration({ modelRegistry: fake.client }).routeExecution(
      request,
      resumed.context,
    ),
  ).rejects.toMatchObject({ kind: "policy" });
  expect(fake.calls).toBe(3);
  const files = await readdir(join(f.runDirectory, "decisions"));
  expect(files.filter((name) => name.endsWith("reserved.json"))).toHaveLength(
    3,
  );
  expect(files.filter((name) => name.endsWith("usage.json"))).toHaveLength(2);
});

test("reservation save failure and its orphan cannot dispatch", async () => {
  const f = await fixture();
  const fake = fakeClient();
  const auth = new JevAuthorization(
    f.state,
    f.configuration,
    f.artifactStore,
    {
      saveState: async () => {
        throw Error("disk full");
      },
    },
    "routing",
    ["plan"],
  );
  await expect(
    new JevIntegration({ modelRegistry: fake.client }).routeExecution(
      request,
      auth.context,
    ),
  ).rejects.toMatchObject({ kind: "policy" });
  const second = new JevAuthorization(
    f.state,
    f.configuration,
    f.artifactStore,
    f.stateStore,
    "routing",
    ["plan"],
  );
  await expect(
    new JevIntegration({ modelRegistry: fake.client }).routeExecution(
      request,
      second.context,
    ),
  ).rejects.toMatchObject({ kind: "policy" });
  expect(fake.calls).toBe(0);
});

test("competing reservations allow only one outbound request", async () => {
  const f = await fixture();
  const fake = fakeClient();
  const adapter = new JevIntegration({ modelRegistry: fake.client });
  const attempts = [1, 2].map(
    () =>
      new JevAuthorization(
        f.state,
        f.configuration,
        f.artifactStore,
        f.stateStore,
        "routing",
        ["plan"],
      ),
  );
  const results = await Promise.allSettled(
    attempts.map((auth) => adapter.routeExecution(request, auth.context)),
  );
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(fake.calls).toBe(1);
});

test("changing native classifier requires matching consent even when Pi could authenticate", async () => {
  const f = await fixture();
  const auth = new JevAuthorization(
    f.state,
    {
      ...f.configuration,
      classifier: { provider: "openrouter", model: "typesafe/jev-1.13" },
    },
    f.artifactStore,
    f.stateStore,
    "routing",
    ["plan"],
  );
  const fake = fakeClient();
  await expect(
    new JevIntegration({
      classifier: { provider: "openrouter", model: "typesafe/jev-1.13" },
      modelRegistry: fake.client,
    }).routeExecution(request, auth.context),
  ).rejects.toMatchObject({ kind: "policy" });
  expect(fake.calls).toBe(0);
  expect(
    (await new StateStore(f.runDirectory).loadState()).jevUsage
      ?.attemptsReserved,
  ).toBe(0);
});

test("a configured classifier change invalidates an already-created authorization context", async () => {
  const f = await fixture();
  const auth = new JevAuthorization(
    f.state,
    f.configuration,
    f.artifactStore,
    f.stateStore,
    "routing",
    ["plan"],
  );
  await auth.assertAllowed();
  f.configuration.classifier = { provider: "typesafe", model: "other" };
  const fake = fakeClient();
  await expect(
    new JevIntegration({ modelRegistry: fake.client }).routeExecution(
      request,
      auth.context,
    ),
  ).rejects.toMatchObject({ kind: "policy" });
  expect(fake.calls).toBe(0);
  expect(
    (await new StateStore(f.runDirectory).loadState()).jevUsage!
      .attemptsReserved,
  ).toBe(0);
});

test("native result probabilities, identity and request digest survive reload", async () => {
  const f = await fixture();
  const auth = new JevAuthorization(
    f.state,
    f.configuration,
    f.artifactStore,
    f.stateStore,
    "routing",
    ["plan"],
  );
  const fake = fakeClient();
  await new JevIntegration({ modelRegistry: fake.client }).routeExecution(
    request,
    auth.context,
  );
  const state = await new StateStore(f.runDirectory).loadState();
  const result = JSON.parse(
    await f.artifactStore.readText!(state.jevUsage!.latestUsageRef!),
  );
  expect(result).toMatchObject({
    classifier: { provider: "typesafe", model: "jev-latest" },
    decisionSchemaVersion: 1,
    requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    configurationDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    requestRef: state.jevUsage?.latestRequestRef,
    answers: {
      modelTier: {
        choice: "ECONOMY",
        confidence: 0.9,
        probabilities: { ECONOMY: 0.9 },
      },
    },
  });
});

test("timeout consumes the reservation without automatic refund", async () => {
  const f = await fixture(1);
  const auth = new JevAuthorization(
    f.state,
    f.configuration,
    f.artifactStore,
    f.stateStore,
    "routing",
    ["plan"],
  );
  const adapter = new JevIntegration({
    timeoutMs: 10,
    modelRegistry: nativeRuntime(async () => new Promise(() => {})),
  });
  await expect(
    adapter.routeExecution(request, auth.context),
  ).rejects.toMatchObject({ kind: "timeout" });
  expect(auth.state.jevUsage?.attemptsReserved).toBe(1);
  await expect(
    adapter.routeExecution(request, auth.context),
  ).rejects.toMatchObject({ kind: "policy" });
  const text = await readFile(
    join(f.runDirectory, auth.state.jevUsage!.latestRequestRef!.path),
    "utf8",
  );
  expect(text).not.toMatch(/"authorization"|apiKey|headers|TYPESAFE_API_KEY/u);
});
