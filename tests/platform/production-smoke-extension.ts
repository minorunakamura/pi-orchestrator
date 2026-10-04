import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../src/core/schema.ts";
import { auditProductionWorkflow } from "./production-audit.ts";
import { parsePlan } from "../../src/runtime/planning/plan-parser.ts";
import { auditTddTranscript } from "./tdd-evidence.ts";
import { isAgentRunReceipt } from "../../src/core/planning/agent-attempt.ts";

/** Observer only. Load the unmodified production package alongside this extension. */
export default function (pi: ExtensionAPI) {
  const requests: unknown[] = [];
  const responses: unknown[] = [];
  pi.events.on("subagents:rpc:v1:request", (value) => {
    if (isRecord(value)) requests.push(value);
  });
  // Observe the public response without replacing any request, result or authority.
  pi.events.on("plannotator:review-result", (value) => responses.push(value));
  pi.registerCommand("production-audit", {
    description: "Read-only Issue #12 audit; never resume, dispatch or approve",
    async handler(reportPath, ctx) {
      const report: Record<string, unknown> = {
        status: "failed",
        pi: VERSION,
        recordedAt: new Date().toISOString(),
        herdrTab: process.env.HERDR_TAB_ID,
        herdrPane: process.env.HERDR_PANE_ID,
        projectTrusted: ctx.isProjectTrusted(),
        fixturePorts: false,
      };
      try {
        assert.equal(process.env.HERDR_ENV, "1");
        assert.equal(ctx.mode, "tui");
        assert.equal(VERSION, "0.99.1");
        // Record the actual public trust decision; never infer it from fixture settings.
        assert(
          ctx.modelRegistry.findOfType("classifier", "typesafe", "jev-latest"),
        );
        const audit = await auditProductionWorkflow(ctx.cwd);
        const { state, worker } = audit;
        const plan = parsePlan(audit.plan);
        assert.equal(plan.developmentMethod, "TDD");
        assert(plan.testSeams);
        assert(worker.launch);
        assert.equal(worker.launch.packageVersion, "0.74.0");
        assert.equal(worker.launch.lifecycleArtifactVersion, 3);
        assert.equal(worker.launch.inheritSkills, false);
        assert.equal(worker.launch.projectTrusted, ctx.isProjectTrusted());
        assert.deepEqual(
          worker.launch.skills.map((skill) => skill.name),
          ["tdd"],
        );
        assert(state.planning.context.clarificationRef);
        assert(state.planning.clarificationRequestRef);
        const clarification = JSON.parse(
          await audit.store.readText(state.planning.clarificationRequestRef),
        );
        const completion = JSON.parse(
          await audit.store.readText(state.planning.context.clarificationRef),
        );
        assert.equal(completion.status, "completed");
        assert.deepEqual(
          completion.requestRef,
          state.planning.clarificationRequestRef,
        );
        const nonGit = audit.codeAttempt.source.type === "filesystem-patch";
        assert(worker.receipt);
        const transcript = (
          await readFile(`${worker.receipt.asyncDir}/events.jsonl`, "utf8")
        )
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const verticalSlices = auditTddTranscript(transcript);
        assert.equal(
          clarification.mode,
          nonGit ? "GRILL_WITH_DOCS" : "GRILL_ME",
        );
        const publicStatus = JSON.parse(
          await readFile(`${worker.receipt.asyncDir}/status.json`, "utf8"),
        );
        assert.equal(publicStatus.lifecycleArtifactVersion, 3);
        assert.equal(
          publicStatus.launchContractDigest,
          worker.launch.launchContractDigest,
        );
        assert.equal(publicStatus.processTerminal.state, "observed");
        assert.equal(publicStatus.state, "complete");
        const receipts = new Map(
          [
            worker.receipt,
            ...Object.values(state.planning.agentAttempts ?? {}).flatMap(
              (attempt) => (attempt.receipt ? [attempt.receipt] : []),
            ),
            ...audit.evidence.filter(isAgentRunReceipt),
          ].map((receipt) => [receipt.runId, receipt]),
        );
        const childTerminalProofs = await Promise.all(
          [...receipts.values()].map(async (receipt) => {
            const status = JSON.parse(
              await readFile(`${receipt.asyncDir}/status.json`, "utf8"),
            );
            assert.equal(status.runId, receipt.runId);
            assert.equal(status.sessionId, receipt.sessionId);
            assert.equal(
              status.launchContractDigest,
              receipt.launchContractDigest,
            );
            assert.equal(status.state, "complete");
            assert.equal(status.processTerminal.state, "observed");
            assert(
              status.processTerminal.instances.every(
                (instance: { exitCode: number }) => instance.exitCode === 0,
              ),
            );
            return {
              agent: receipt.agent,
              runId: receipt.runId,
              processTerminal: status.processTerminal,
            };
          }),
        );
        for (const request of requests) {
          assert(isRecord(request));
          assert.equal(request.method, "spawn");
          assert(isRecord(request.params));
          assert.equal(request.params.workflowScript, undefined);
          assert.equal(request.params.workflowScriptPath, undefined);
        }
        Object.assign(report, {
          status: "passed",
          subagents: worker.launch.packageVersion,
          piTypesafe: "removed by #19; transitional tests remain historical",
          workflowRoot: audit.root,
          workflowId: state.workflowId,
          phase: state.phase,
          stateRevision: state.stateRevision,
          provider: nonGit ? "filesystem" : "git",
          clarificationMode: clarification.mode,
          reservations: state.jevUsage?.attemptsReserved,
          refs: audit.refs,
          worker: worker.runId,
          verticalSlices,
          planRef: state.planning.approvedPlanRef,
          codeResultRef: state.coding.latestCodeReviewRef,
          observedSpawnsSinceLoad: requests.length,
          workerTerminalProof: publicStatus.processTerminal,
          childTerminalProofs,
          observedPlanResults: responses,
        });
      } catch (error) {
        report.error = error instanceof Error ? error.stack : String(error);
      }
      await writeFile(reportPath.trim(), JSON.stringify(report, null, 2));
      ctx.ui.notify(
        `Production audit ${String(report.status)}: ${reportPath.trim()}`,
        report.status === "passed" ? "info" : "error",
      );
    },
  });
}
