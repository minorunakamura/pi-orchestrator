import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  getAgentDir,
  VERSION,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  agentLaunchPolicy,
  parseAgentLaunchEvidence,
  type AgentLaunchEvidence,
} from "../../src/core/agent-launch.ts";
import { physicalModelSnapshot } from "../../src/runtime/integrations/subagent-launch.ts";
import {
  SubagentsIntegration,
  SUBAGENT_RPC_REQUEST_EVENT,
} from "../../src/runtime/integrations/subagents.ts";
import { ArtifactStore } from "../../src/runtime/persistence/artifact-store.ts";
import type { AgentRunReceipt } from "../../src/runtime/ports/subagent-executor.ts";

/** Explicit opt-in in a new Herdr tab; no production workflow or mutation authority. */
export default function (pi: ExtensionAPI) {
  pi.registerVirtualModel({
    provider: "platform-smoke",
    id: "virtual-probe",
    name: "Unapproved virtual probe",
    route: (_request, ctx) => ({
      model: ctx.modelRegistry.find("platform-smoke", "probe")!,
      thinkingLevel: "off",
    }),
  });
  pi.registerCommand("launch-smoke", {
    description:
      "Issue #21 public preflight/persistence/receipt/recovery smoke",
    async handler(reportPath, ctx) {
      const report: Record<string, unknown> = {
        status: "failed",
        pi: VERSION,
        recordedAt: new Date().toISOString(),
      };
      try {
        assert.equal(process.env.HERDR_ENV, "1");
        assert.equal(VERSION, "0.99.1");
        assert.equal(ctx.isProjectTrusted(), false);
        const root = dirname(getAgentDir());
        assert(
          basename(root).startsWith("pi-orchestrator-platform-"),
          "Disposable platform fixture required",
        );
        const cwd = join(root, "project");
        const store = new ArtifactStore(
          join(root, "launch-artifacts", randomUUID()),
        );
        await store.writeText("task", "task.md", "Offline launch probe only");
        const host = {
          sessionId: ctx.sessionManager.getSessionId(),
          projectTrusted: ctx.isProjectTrusted(),
          availableModels: physicalModelSnapshot(ctx.modelRegistry),
          parentModel: ctx.model,
          scopedModelIds: ctx.scopedModels.map(
            ({ model }) => `${model.provider}/${model.id}`,
          ),
          runtimeSnapshotHost: pi,
        };
        assert(
          ctx.modelRegistry
            .getAvailable()
            .some((model) => model.id === "virtual-probe"),
        );
        assert(
          !host.availableModels.some((model) => model.id === "virtual-probe"),
        );
        let spawns = 0;
        const events = {
          on: (event: string, listener: (payload: unknown) => void) =>
            pi.events.on(event, listener),
          emit: (event: string, payload: unknown) => {
            if (event === SUBAGENT_RPC_REQUEST_EVENT) spawns += 1;
            pi.events.emit(event, payload);
          },
        };
        const adapter = new SubagentsIntegration(events, {
          cwd,
          launchHost: host,
          artifactReader: store,
          timeoutMs: 60_000,
        });
        const profile = {
          provider: "platform-smoke",
          model: "probe",
          thinking: "off",
        };
        // The only extra extension is the offline provider: explicit test policy,
        // not an exception to production role defaults or a fake child execution.
        const policy = {
          ...agentLaunchPolicy("workflow-scout", profile, [
            "platform-selected",
          ]),
          agent: "platform-isolated",
          inheritProjectContext: false,
          denyExtensions: false,
        };
        for (const invalid of [
          { ...profile, thinking: "high" },
          { ...profile, model: "virtual-probe" },
        ]) {
          // Both capabilities must fail before any child dispatch.
          // oxlint-disable-next-line eslint/no-await-in-loop
          await assert.rejects(
            adapter.preflight({
              agent: policy.agent,
              launchPolicy: { ...policy, executionProfile: invalid },
              executionProfile: invalid,
              cwd,
              task: "Denied launch probe",
              dispatch: {
                requestId: randomUUID(),
                ownerRunId: "launch-smoke",
                nodeId: "denied",
                deadline: new Date(Date.now() + 60_000).toISOString(),
              },
              onStarted: async () => {},
            }),
          );
        }
        // Synthetic definition in the disposable fixture only; no product Agent activation.
        await writeFile(
          join(getAgentDir(), "agents/workflow-scout.md"),
          `---\nname: workflow-scout\ndescription: Codemode inspection probe\nmodel: platform-smoke/probe\nthinking: off\ntools: read, codemode, edit, write, bash\nextensions:\ninheritSkills: false\ninheritProjectContext: false\n---\nReturn read-only evidence.\n`,
        );
        const base = agentLaunchPolicy("workflow-scout", profile);
        const codemodePolicy = {
          ...base,
          inheritProjectContext: false,
          denyExtensions: false,
          allowedTools: [...base.allowedTools, "codemode"],
          requiredTools: ["read", "codemode"],
          forbiddenTools: base.forbiddenTools.filter(
            (tool) => tool !== "codemode",
          ),
        };
        const inspectionRequest = {
          agent: codemodePolicy.agent,
          launchPolicy: codemodePolicy,
          executionProfile: profile,
          cwd,
          task: "Codemode inspection only",
          dispatch: {
            requestId: randomUUID(),
            ownerRunId: "launch-smoke",
            nodeId: "inspection",
            deadline: new Date(Date.now() + 60_000).toISOString(),
          },
          onStarted: async () => {},
        };
        const inspected = await adapter.preflight(inspectionRequest);
        assert.deepEqual(inspected.tools, ["codemode", "read"]);
        parseAgentLaunchEvidence(inspected);
        const inspectionRef = await store.writeJson(
          "agent-launch",
          "codemode-inspection.json",
          inspected,
          parseAgentLaunchEvidence,
        );
        assert.deepEqual(
          await store.readJson(inspectionRef, parseAgentLaunchEvidence),
          inspected,
        );
        let prepared = false;
        await assert.rejects(
          adapter.run({
            ...inspectionRequest,
            launch: inspected,
            onPrepared: async () => {
              prepared = true;
            },
          }),
          /runtime isolation/iu,
        );
        assert.equal(prepared, false);
        assert.equal(spawns, 0);
        Object.assign(report, {
          codemodeInspection: {
            status: "passed",
            tools: inspected.tools,
            launchContractDigest: inspected.launchContractDigest,
            persistence: "bounded projection round-trip matched",
            dispatch: "denied without runtime isolation",
            rpcSpawns: spawns,
            scriptsExecuted: false,
          },
        });
        let launch: AgentLaunchEvidence | undefined;
        let receipt: AgentRunReceipt | undefined;
        const result = await adapter.run({
          agent: policy.agent,
          launchPolicy: policy,
          executionProfile: profile,
          cwd,
          task: "/project-prompt",
          dispatch: {
            requestId: randomUUID(),
            ownerRunId: "launch-smoke",
            nodeId: "probe",
            deadline: new Date(Date.now() + 60_000).toISOString(),
          },
          onPrepared: async (value) => {
            launch = value;
            const launchRef = await store.writeJson(
              "agent-launch",
              "launch.json",
              value,
              parseAgentLaunchEvidence,
            );
            await writeFile(
              join(store.rootDirectory, "intent.json"),
              JSON.stringify({ status: "intent", launchRef }),
            );
          },
          onStarted: async (value) => {
            receipt = value;
            await writeFile(
              join(store.rootDirectory, "receipt.json"),
              JSON.stringify(value),
            );
          },
        });
        assert.equal(spawns, 1);
        assert.equal(result.status, "succeeded", JSON.stringify(result));
        assert(launch);
        assert(receipt);
        assert.equal(receipt.launchContractDigest, launch.launchContractDigest);
        if (result.status !== "succeeded") throw Error("No canonical result");
        const evidence = JSON.parse(result.output);
        assert.equal(evidence.projectTrusted, false);
        assert.equal(evidence.selectedSkill, true);
        assert.equal(evidence.ambientSkill, false);
        assert.equal(evidence.extensionSkill, false);
        assert.equal(evidence.projectSkill, false);
        assert.equal(evidence.projectPrompt, false);
        for (const tool of ["write", "edit", "bash", "codemode", "subagent"])
          assert(!evidence.tools.includes(tool));
        const recovered = await adapter.status(result.runId, receipt);
        assert.equal(recovered.status, "succeeded", JSON.stringify(recovered));
        assert.deepEqual(recovered.result, {
          status: "succeeded",
          runId: result.runId,
          output: result.output,
        });
        Object.assign(report, {
          status: "passed",
          subagents: launch.packageVersion,
          launch,
          receipt,
          evidence,
          recovery: "exact historical contract and full output matched",
          virtualAndUnsupportedThinking: "denied before dispatch",
          herdrTab: process.env.HERDR_TAB_ID,
          herdrPane: process.env.HERDR_PANE_ID,
          network: "offline provider only",
          limitations:
            "Test-only provider requires denyExtensions:false; stock production role ceilings use denyExtensions:true. Full lifecycle/Human Gates remain #12.",
        });
      } catch (error) {
        report.error = error instanceof Error ? error.message : String(error);
        if (error instanceof Error && error.cause instanceof Error)
          report.cause = error.cause.message;
      }
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      ctx.ui.notify(
        `Launch smoke ${String(report.status)}: ${reportPath}`,
        report.status === "passed" ? "info" : "error",
      );
    },
  });
}
