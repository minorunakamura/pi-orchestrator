import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
import type { WorkflowState } from "../../src/core/workflow/state.ts";
import type { JevConfiguration } from "../../src/core/configuration.ts";
import { workflowId } from "../../src/types.ts";

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
      "Authorize one live typesafe/jev-latest request with synthetic non-secret evidence (Issue #19)",
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
        const artifacts = new ArtifactStore(root);
        const states = new StateStore(root);
        const taskRef = await artifacts.writeText(
          "task",
          "task.md",
          "Documentation-only spelling correction; repository inspection supplied all relevant facts. No external research needed.",
        );
        const now = new Date().toISOString();
        const initial: WorkflowState = {
          schemaVersion: 1,
          workflowId: workflowId(`issue19-native-smoke-${randomUUID()}`),
          projectRoot: await realpath(ctx.cwd),
          stateRevision: 0,
          playbook: "chore",
          phase: "planning",
          taskRef,
          planning: { context: {}, currentPlanVersion: 0 },
          coding: { implementationRevision: 0, reviewRound: 0 },
          counters: {
            automatedFixRoundsUsed: 0,
            strongerRetriesUsed: 0,
            humanCodeFeedbackRounds: 0,
          },
          jevUsage: { attemptsReserved: 0 },
          external: {},
          createdAt: now,
          updatedAt: now,
        };
        const state = await states.saveState(initial, 0);
        const configuration: JevConfiguration = {
          timeoutMs: 15000,
          maxTransportRetries: 0,
          runtimePolicy: {
            maxRequests: 1,
            consent: {
              id: "operator-invoked-classifier-smoke",
              policyVersion: "issue19-smoke-1",
              active: true,
              workflowId: state.workflowId,
              projectRoot: state.projectRoot!,
              destination: "typesafe/jev-latest",
              evidenceCategories: ["task"],
            },
          },
        };
        let requests = 0;
        const registry: PiClassifierRuntime = {
          findOfType: (type, provider, id) =>
            ctx.modelRegistry.findOfType(type, provider, id),
          classify: async (model, request, options) => {
            requests++;
            const reserved = await states.loadState();
            assert.equal(reserved.jevUsage?.attemptsReserved, requests);
            assert.ok(reserved.jevUsage?.latestRequestRef);
            const record = JSON.parse(
              await artifacts.readText(reserved.jevUsage.latestRequestRef),
            );
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
              consent: {
                ...configuration.runtimePolicy!.consent,
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
          adapter.routeStage(
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
          "planning",
          "classifier does not grant Workflow authority",
        );
        Object.assign(report, {
          status: "passed",
          classifier: result.classifier,
          requests,
          decision,
          probabilities: result.answers.decision.probabilities,
          reservationRef: durable.jevUsage.latestRequestRef,
          resultRef: durable.jevUsage.latestUsageRef,
          requestDigest: result.requestDigest,
          configurationDigest: result.configurationDigest,
          decisionSchemaVersion: result.decisionSchemaVersion,
          usage: result.usage,
          checks: [
            "live Pi native classifier",
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
