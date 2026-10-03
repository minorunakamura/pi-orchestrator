import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  PiClassifierDecisionClient,
  type PiClassifierRuntime,
} from "../../src/runtime/integrations/jev.ts";
import { JevAuthorization } from "../../src/runtime/orchestrator/jev-authorization.ts";
import { ArtifactStore } from "../../src/runtime/persistence/artifact-store.ts";
import { StateStore } from "../../src/runtime/persistence/state-store.ts";
import { createWorkflow } from "../../src/runtime/orchestrator/start-workflow.ts";
import { FakeSubagentExecutor } from "../fakes/index.ts";
import type { JevConfiguration } from "../../src/core/configuration.ts";

/** Operator invokes this command to grant one harmless live classification. No Worker/Gate. */
export default function classifierSmoke(pi: ExtensionAPI) {
  pi.registerCommand("classifier-preflight", {
    description:
      "Read-only native classifier availability/auth metadata; no classification",
    handler: async (_args, ctx) => {
      const auth = ctx.modelRegistry.getProviderAuthStatus("typesafe");
      await writeFile(
        "/tmp/pi-orchestrator-issue19-preflight.json",
        JSON.stringify({
          pi: VERSION,
          modelPresent: Boolean(
            ctx.modelRegistry.findOfType(
              "classifier",
              "typesafe",
              "jev-latest",
            ),
          ),
          authConfigured: auth.configured,
          authSource: auth.source,
        }),
      );
    },
  });
  pi.registerCommand("classifier-smoke", {
    description:
      "Authorize one live typesafe/jev-latest request with synthetic task evidence and generated workflow consent (Issue #11)",
    handler: async (args, ctx) => {
      const reportPath = args.trim();
      if (!reportPath.startsWith("/tmp/"))
        throw Error("Use /classifier-smoke /tmp/<report>.json");
      const report: Record<string, unknown> = {
        status: "failed",
        pi: VERSION,
        herdrTab: process.env.HERDR_TAB_ID,
        herdrPane: process.env.HERDR_PANE_ID,
      };
      try {
        assert.equal(VERSION, "0.99.1");
        assert.equal(process.env.HERDR_ENV, "1");
        const root = await mkdtemp(join(tmpdir(), "pi-classifier-smoke-"));
        report.evidenceRoot = root;
        const configuration: JevConfiguration = {
          timeoutMs: 15000,
          maxTransportRetries: 0,
          runtimePolicy: {
            maxRequests: 1,
            grant: {
              id: "operator-invoked-classifier-smoke",
              policyVersion: "issue11-smoke-1",
              active: true,
              projectRoot: await realpath(ctx.cwd),
              destination: "typesafe/jev-latest",
              evidenceCategories: ["task"],
            },
          },
        };
        // The grant exists before createWorkflow generates its UUID. No child is run.
        const created = await createWorkflow(
          {
            task: "Synthetic documentation-only spelling correction; supplied facts are complete. No external research needed.",
            playbook: "chore",
            cwd: ctx.cwd,
          },
          { runsDirectory: root, subagentExecutor: new FakeSubagentExecutor() },
        );
        const { state, taskRef } = created;
        const artifacts = new ArtifactStore(created.runDirectory);
        const states = new StateStore(created.runDirectory);
        assert.match(state.workflowId, /^[0-9a-f-]{36}$/u);
        assert.equal(
          Object.hasOwn(configuration.runtimePolicy!.grant, "workflowId"),
          false,
        );
        report.workflowId = state.workflowId;
        report.runDirectory = created.runDirectory;
        let requests = 0;
        const registry: PiClassifierRuntime = {
          findOfType: (type, provider, id) =>
            ctx.modelRegistry.findOfType(type, provider, id),
          classify: async (model, request, options) => {
            requests++;
            const reserved = await states.loadState();
            assert.equal(reserved.jevUsage?.attemptsReserved, requests);
            assert.ok(reserved.jevUsage?.latestRequestRef);
            assert.ok(reserved.jevUsage?.authorizationRef);
            const binding = JSON.parse(
              await artifacts.readText(reserved.jevUsage.authorizationRef),
            );
            assert.equal(binding.workflowId, state.workflowId);
            assert.equal(binding.projectRoot, await realpath(ctx.cwd));
            assert.equal(binding.destination, "typesafe/jev-latest");
            assert.deepEqual(binding.evidenceCategories, ["task"]);
            assert.equal(binding.maxRequests, 1);
            const record = JSON.parse(
              await artifacts.readText(reserved.jevUsage.latestRequestRef),
            );
            assert.deepEqual(
              record.authorizationRef,
              reserved.jevUsage.authorizationRef,
            );
            assert.equal(record.consentId, binding.consentId);
            assert.equal(record.destination, "typesafe/jev-latest");
            assert.equal(record.recordType, "reservation");
            assert.equal(options?.maxRetries, 0);
            assert.ok(options.signal);
            return ctx.modelRegistry.classify(model, request, options);
          },
        };
        const adapter = new PiClassifierDecisionClient({
          ...configuration,
          modelRegistry: registry,
        });
        const input = {
          playbook: "chore" as const,
          stage: "research" as const,
          policy: "conditional" as const,
          inputRefs: [taskRef],
          evidence: {
            task: { ref: taskRef, content: await artifacts.readText(taskRef) },
          },
        };
        const denied = new JevAuthorization(
          state,
          {
            ...configuration,
            runtimePolicy: {
              ...configuration.runtimePolicy!,
              grant: {
                ...configuration.runtimePolicy!.grant,
                active: false,
              },
            },
          },
          artifacts,
          states,
          "stage",
          ["task"],
        );
        await assert.rejects(adapter.routeStage(input, denied.context));
        assert.equal(requests, 0, "Pi credentials are not consent");
        const auth = new JevAuthorization(
          state,
          configuration,
          artifacts,
          states,
          "stage",
          ["task"],
        );
        const decision = await adapter.routeStage(input, auth.context);
        assert.ok(["RUN", "SKIP", "ESCALATE"].includes(decision.value));
        assert.equal(requests, 1);
        const durable = await states.loadState();
        assert.equal(durable.jevUsage?.attemptsReserved, 1);
        assert.ok(durable.jevUsage?.latestUsageRef);
        const result = JSON.parse(
          await artifacts.readText(durable.jevUsage.latestUsageRef),
        );
        assert.equal(result.answers.decision.choice, decision.value);
        assert.equal(result.answers.decision.confidence, decision.confidence);
        assert.equal(
          Object.keys(result.answers.decision.probabilities).length,
          3,
        );
        await assert.rejects(
          new PiClassifierDecisionClient({
            ...configuration,
            modelRegistry: registry,
          }).routeStage(
            input,
            new JevAuthorization(
              durable,
              configuration,
              artifacts,
              states,
              "stage",
              ["task"],
            ).context,
          ),
        );
        assert.equal(
          requests,
          1,
          "authorization recreation/budget cannot relaunch",
        );
        assert.equal(
          durable.phase,
          "gathering-context",
          "classifier does not grant Workflow authority",
        );
        Object.assign(report, {
          status: "passed",
          classifier: result.classifier,
          requests,
          decision,
          probabilities: result.answers.decision.probabilities,
          authorizationRef: durable.jevUsage.authorizationRef,
          reservationRef: durable.jevUsage.latestRequestRef,
          resultRef: durable.jevUsage.latestUsageRef,
          requestDigest: result.requestDigest,
          configurationDigest: result.configurationDigest,
          decisionSchemaVersion: result.decisionSchemaVersion,
          usage: result.usage,
          checks: [
            "live Pi native classifier",
            "grant before generated workflow UUID",
            "exact durable workflow authorization before request",
            "denied consent: zero calls",
            "reservation before classify",
            "maxRetries:0",
            "durable probabilities/confidence",
            "finite budget across recreation",
            "no Workflow authority",
          ],
        });
      } catch {
        report.error =
          "Classifier smoke failed; credentials/provider/accounting must be checked without exposing secrets";
      }
      report.observedAt = new Date().toISOString();
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      ctx.ui.notify(
        `Classifier smoke ${String(report.status)}: ${reportPath}`,
        report.status === "passed" ? "info" : "error",
      );
    },
  });
}
