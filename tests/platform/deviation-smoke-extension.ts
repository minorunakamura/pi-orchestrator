import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { basename, dirname, join } from "node:path";
import {
  getAgentDir,
  VERSION,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { physicalModelSnapshot } from "../../src/runtime/integrations/subagent-launch.ts";
import {
  SubagentsIntegration,
  SUBAGENT_RPC_REQUEST_EVENT,
} from "../../src/runtime/integrations/subagents.ts";
import { PlannotatorIntegration } from "../../src/runtime/integrations/plannotator.ts";
import { ArtifactStore } from "../../src/runtime/persistence/artifact-store.ts";
import { StateStore } from "../../src/runtime/persistence/state-store.ts";
import { createWorkflow } from "../../src/runtime/orchestrator/start-workflow.ts";
import { driveWorkflow } from "../../src/runtime/orchestrator/drive-workflow.ts";
import { resumeWorkflow } from "../../src/runtime/orchestrator/resume-workflow.ts";
import {
  readPlanDeviation,
  publishPlanDeviation,
} from "../../src/runtime/orchestrator/plan-deviation.ts";
import { validateCompletedWorkerAttempt } from "../../src/runtime/orchestrator/coding-orchestrator.ts";
import { PlanningOrchestrator } from "../../src/runtime/orchestrator/planning-orchestrator.ts";
import { plannotatorReviewId } from "../../src/types.ts";
import { CommandValidationExecutor } from "../../src/runtime/validation/command-executor.ts";
import { ValidationRunner } from "../../src/runtime/orchestrator/validation-runner.ts";
import { parseValidationResult } from "../../src/core/decisions/types.ts";
import { assertValidationAuthority } from "../../src/runtime/orchestrator/coding-evidence.ts";
import { calculateSha256 } from "../../src/runtime/persistence/artifact-store.ts";
import { parseWorkerAttempt } from "../../src/runtime/worker/attempt-evidence.ts";
import { simplicityEvidence } from "../../src/runtime/orchestrator/plan-simplicity.ts";
import { FakeJevDecisionClient, FakeSubagentExecutor } from "../fakes/index.ts";
import { configuration, routing, succeeded } from "../fakes/coding-scenario.ts";
import { jevPolicy } from "../fakes/jev-policy.ts";
import { isRecord } from "../../src/core/schema.ts";
import type {
  AgentRunRequest,
  SubagentExecutor,
} from "../../src/runtime/ports/subagent-executor.ts";

const scriptedRequest = (input: AgentRunRequest) =>
  input.agent === "workflow-scout" || input.dispatch?.nodeId === "plan-v1";

/** Opt-in actual Human-approved stop-only Worker -> actual Planner/simplicity -> fresh pending Human Gate. */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("deviation-smoke-continue", {
    description:
      "Recover exact second Human approval, continue one actual Worker, validate and audit; never reopen/relaunch",
    async handler(args, ctx) {
      const [previousPath, reportPath] = args.trim().split(/\s+/u);
      assert(previousPath && reportPath && previousPath !== reportPath);
      const report: Record<string, unknown> = {
        status: "failed",
        startedAt: new Date().toISOString(),
        pi: VERSION,
        previousReport: previousPath,
        herdrTab: process.env.HERDR_TAB_ID,
        herdrPane: process.env.HERDR_PANE_ID,
      };
      const save = () =>
        writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
      try {
        assert.equal(process.env.HERDR_ENV, "1");
        assert.equal(VERSION, "0.99.1");
        assert.equal(ctx.isProjectTrusted(), false);
        const previous = JSON.parse(await readFile(previousPath, "utf8"));
        assert.equal(previous.status, "passed");
        let priorAudit: Record<string, unknown> | undefined;
        try {
          priorAudit = JSON.parse(await readFile(reportPath, "utf8"));
        } catch (error) {
          if (!isRecord(error) || error.code !== "ENOENT") throw error;
        }
        report.previousAuditError = priorAudit?.error;
        report.approvalBeforeDispatch = priorAudit?.approvalBeforeDispatch;
        const root = dirname(getAgentDir());
        assert(basename(root).startsWith("pi-orchestrator-simplicity-"));
        assert.equal(dirname(dirname(previous.runDirectory)), root);
        const store = new ArtifactStore(previous.runDirectory),
          states = new StateStore(store.rootDirectory);
        const initial = await states.loadState();
        assert.equal(initial.planning.currentPlanVersion, 2);
        assert.equal(
          initial.coding.latestDeviationRef?.sha256,
          previous.deviation
            ? calculateSha256(JSON.stringify(previous.deviation))
            : undefined,
        );
        const deviation = await readPlanDeviation(store, initial);
        assert(deviation);
        const stopped = await store.readJson(
          deviation.workerAttemptRef,
          parseWorkerAttempt,
        );
        assert.equal(stopped.status, "deviated");
        assert(stopped.receipt && stopped.runId);
        const newPlanRef = initial.planning.currentPlanRef!;
        assert.notEqual(newPlanRef.sha256, stopped.approvedPlanRef.sha256);
        const before = await readFile(join(ctx.cwd, "greeting.mjs"), "utf8");
        const spawns: string[] = [],
          gateOpens: string[] = [];
        const events = {
          on: (event: string, listener: (payload: unknown) => void) =>
            pi.events.on(event, listener),
          emit: (event: string, payload: unknown) => {
            if (
              isRecord(payload) &&
              event === SUBAGENT_RPC_REQUEST_EVENT &&
              payload.method === "spawn" &&
              isRecord(payload.params)
            )
              spawns.push(String(payload.params.agent));
            if (
              isRecord(payload) &&
              event === "plannotator:request" &&
              payload.action === "plan-review"
            )
              gateOpens.push(String(payload.requestId));
            pi.events.emit(event, payload);
          },
        };
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
        const actual = new SubagentsIntegration(events, {
          cwd: ctx.cwd,
          launchHost: host,
          artifactReader: store,
          timeoutMs: 120000,
        });
        const gate = new PlannotatorIntegration({ events, planReader: store });
        const stopAfterValidation = new AbortController();
        const executor: SubagentExecutor = {
          preflight: (input) => actual.preflight(input),
          run: async (input) => {
            assert.equal(input.agent, "worker");
            assert.equal(spawns.length, 0);
            const durable = await states.loadState();
            assert.equal(durable.planning.approvedPlanVersion, 2);
            assert.deepEqual(durable.planning.approvedPlanRef, newPlanRef);
            assert(durable.planning.latestPlanReviewRef);
            const approval = JSON.parse(
              await store.readText(durable.planning.latestPlanReviewRef),
            );
            assert.equal(approval.status, "approved");
            assert.deepEqual(approval.planRef, newPlanRef);
            assert.equal(approval.planVersion, 2);
            assert.deepEqual(
              approval.simplicityReviewRef,
              durable.planning.simplicityReviewRef,
            );
            assert(
              input.inputRefs?.some((ref) => ref.sha256 === newPlanRef.sha256),
            );
            assert(
              !input.inputRefs?.some(
                (ref) => ref.sha256 === stopped.approvedPlanRef.sha256,
              ),
            );
            assert.equal(
              await readFile(join(ctx.cwd, "greeting.mjs"), "utf8"),
              before,
            );
            report.approvalBeforeDispatch = {
              ref: durable.planning.latestPlanReviewRef,
              approval,
              stateRevision: durable.stateRevision,
            };
            report.status = "running-worker";
            await save();
            return actual.run(input);
          },
          runParallel: async () => {
            throw Error("Focused smoke must stop before post-code review");
          },
          status: (id, receipt) => actual.status(id, receipt),
          resume: async () => {
            throw Error("Historical Worker relaunch forbidden");
          },
        };
        const deps = {
          artifactStore: store,
          stateStore: states,
          loadState: () => states.loadState(),
          cwd: ctx.cwd,
          subagentExecutor: executor,
          plannotatorGate: gate,
          configuration: {
            ...configuration,
            jev: jevPolicy(ctx.cwd, 8),
            executionProfiles: {
              ECONOMY: { provider: "openai", model: "gpt-6.1-sol" },
              STANDARD: { provider: "openai", model: "gpt-6.1-sol" },
              STRONG: { provider: "openai", model: "gpt-6.1-sol" },
            },
          },
          jevDecisionClient: new FakeJevDecisionClient({
            routeExecution: { type: "result", value: routing },
          }),
          validationExecutor: {
            execute: async (
              contract: Parameters<CommandValidationExecutor["execute"]>[0],
            ) => {
              const result = await new CommandValidationExecutor().execute(
                contract,
              );
              stopAfterValidation.abort();
              return result;
            },
          },
          signal: stopAfterValidation.signal,
        };
        Object.assign(report, {
          runDirectory: store.rootDirectory,
          newPlanRef,
          oldDeviationRef: initial.coding.latestDeviationRef,
          spawns,
          gateOpens,
        });
        await save();
        let state = initial;
        report.mode =
          initial.phase === "awaiting-plan-review" ? "execution" : "audit-only";
        if (initial.phase === "awaiting-plan-review") {
          assert.equal(initial.planning.approvedPlanRef, undefined);
          assert.equal(initial.coding.implementationRevision, 0);
          assert.deepEqual(
            initial.coding.workerAttemptRef,
            deviation.workerAttemptRef,
          );
          const binding = initial.planning.planReview;
          assert(binding);
          const status = await gate.getPlanReview(binding.reviewId, binding);
          report.publicApprovalStatus = status;
          await save();
          assert.equal(
            status.status,
            "approved",
            "Exact second Human approval must already exist; unknown/pending never reopens or grants authority",
          );
          const result = await resumeWorkflow(initial.workflowId, {
            ...deps,
            runDirectory: store.rootDirectory,
          });
          state = result.state;
          assert.deepEqual(spawns, ["worker"]);
        } else {
          // Audit-only after an interrupted report/Validation: a completed Worker is never rerun.
          assert(["validating", "reviewing"].includes(initial.phase));
        }
        assert(
          ["validating", "reviewing"].includes(state.phase),
          JSON.stringify(state.block),
        );
        assert.deepEqual(gateOpens, []);
        assert.equal(state.planning.approvedPlanVersion, 2);
        assert.deepEqual(state.planning.approvedPlanRef, newPlanRef);
        assert.equal(state.coding.implementationRevision, 1);
        const workerRef = state.coding.workerAttemptRef;
        assert(workerRef);
        const worker = await store.readJson(workerRef, parseWorkerAttempt);
        assert(worker.receipt && worker.runId && worker.launch);
        assert.equal(worker.status, "succeeded");
        assert.deepEqual(worker.approvedPlanRef, newPlanRef);
        assert.notEqual(worker.runId, stopped.runId);
        assert.equal(worker.inputRevision, 0);
        assert.equal(worker.targetRevision, 1);
        const recreated = new SubagentsIntegration(events, {
          cwd: ctx.cwd,
          launchHost: host,
          artifactReader: store,
          timeoutMs: 120000,
        });
        assert(
          await validateCompletedWorkerAttempt(
            store,
            state,
            workerRef,
            worker,
            recreated,
          ),
        );
        const recovered = await recreated.status(worker.runId, worker.receipt);
        assert.equal(recovered.status, "succeeded");
        assert(recovered.result?.status === "succeeded");
        const implementation = JSON.parse(
          await store.readText(state.coding.implementationRef!),
        );
        assert.equal(recovered.result.output, implementation.output);
        assert.equal(
          calculateSha256(implementation.output),
          implementation.repository.outputSha256,
        );
        const oldRecovered = await recreated.status(
          stopped.runId,
          stopped.receipt,
        );
        assert.equal(oldRecovered.status, "succeeded");
        assert(oldRecovered.result?.status === "succeeded");
        assert.equal(oldRecovered.result.output, deviation.output);
        if (state.phase === "validating") {
          const validated = await new ValidationRunner({
            ...deps,
            validationExecutor: new CommandValidationExecutor(),
          }).execute({ state });
          assert.equal(validated.validation.status, "passed");
          state = validated.state;
        }
        const validation = await store.readJson(
          state.coding.validationRef!,
          parseValidationResult,
        );
        await assertValidationAuthority(store, state, validation);
        assert.equal(validation.status, "passed");
        assert(validation.checks.every((c) => c.exitCode === 0));
        assert.equal(state.phase, "reviewing");
        await assert.rejects(
          new PlanningOrchestrator(deps).reconcilePlanReview({
            state,
            reviewId: plannotatorReviewId(previous.reviewId),
          }),
        );
        await assert.rejects(
          publishPlanDeviation(
            state,
            deviation.workerAttemptRef,
            stopped,
            deviation.output,
            deps,
          ),
        );
        assert.deepEqual(
          (await readdir(ctx.cwd)).filter((name) => name !== ".git"),
          ["greeting.mjs"],
        );
        // Pi is a compiled executable: process.execPath is Pi, NOT Node.
        const behavior = await promisify(execFile)(
          "node",
          [
            "--input-type=module",
            "-e",
            `import assert from 'node:assert/strict'; const {greet}=await import(${JSON.stringify(pathToFileURL(join(ctx.cwd, "greeting.mjs")).href)}); assert.equal(greet('Ada'),'Hello, Ada!'); assert.equal(greet({first:'Ada',last:'Lovelace'}),'Hello, Ada Lovelace!'); console.log('string/object public behavior PASS');`,
          ],
          { cwd: ctx.cwd },
        );
        const publicStatus = JSON.parse(
          await readFile(join(worker.receipt.asyncDir, "status.json"), "utf8"),
        );
        assert.equal(publicStatus.processTerminal.state, "observed");
        assert(
          publicStatus.processTerminal.instances.every(
            (i: { exitCode: number }) => i.exitCode === 0,
          ),
        );
        const count = spawns.length;
        const replayStop = new AbortController();
        replayStop.abort();
        await resumeWorkflow(state.workflowId, {
          ...deps,
          subagentExecutor: recreated,
          signal: replayStop.signal,
          runDirectory: store.rootDirectory,
        });
        assert.equal(spawns.length, count);
        assert.deepEqual(gateOpens, []);
        assert.equal(
          (await states.loadState()).stateRevision,
          state.stateRevision,
        );
        Object.assign(report, {
          status: "passed",
          finishedAt: new Date().toISOString(),
          phase: state.phase,
          humanReviewRef: state.planning.latestPlanReviewRef,
          implementationRef: state.coding.implementationRef,
          validationRef: state.coding.validationRef,
          validation,
          workerAttemptRef: workerRef,
          receipt: worker.receipt,
          launch: worker.launch,
          processTerminal: publicStatus.processTerminal,
          sourceAtAuditStart: before,
          sourceBeforeDigest: worker.before.untracked.find(
            (entry) => entry.path === "greeting.mjs",
          )?.sha256,
          sourceAfter: await readFile(join(ctx.cwd, "greeting.mjs"), "utf8"),
          behaviorAudit: behavior.stdout.trim(),
          continuationWorkerRuns: 1,
          oldWorkerRunId: stopped.runId,
          workerRunId: worker.runId,
          redispatches: 0,
          reopenedGates: 0,
          limitation:
            "Same prior deviation/actual Planner/simplicity evidence and exact second actual Human approval. Actual Worker resumed under Plan v2; approved deterministic Validation and independent public string/object behavior checks pass. Classifier remains scripted; stop at reviewing, no Code Gate/live Jev/full lifecycle/release PASS.",
        });
      } catch (error) {
        report.status = "failed";
        report.error = error instanceof Error ? error.message : String(error);
      }
      await save();
      ctx.ui.notify(
        `Deviation continuation ${String(report.status)}: ${reportPath}`,
        report.status === "passed" ? "info" : "error",
      );
    },
  });
  pi.registerCommand("deviation-smoke", {
    description:
      "Issue #15 terminal stop / exact recovery / automatic replan smoke; no proposed deviation mutation",
    async handler(reportPath, ctx) {
      const report: Record<string, unknown> = {
        status: "failed",
        pi: VERSION,
        startedAt: new Date().toISOString(),
        herdrTab: process.env.HERDR_TAB_ID,
        herdrPane: process.env.HERDR_PANE_ID,
      };
      const save = () =>
        writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
      const fail = async (error: unknown) => {
        report.status = "failed";
        report.error = error instanceof Error ? error.message : String(error);
        await save();
        ctx.ui.notify(`Deviation smoke failed: ${reportPath}`, "error");
      };
      let unsubscribe: (() => void) | undefined;
      try {
        assert.equal(process.env.HERDR_ENV, "1");
        assert.equal(VERSION, "0.99.1");
        assert.equal(ctx.isProjectTrusted(), false);
        const root = dirname(getAgentDir());
        assert(basename(root).startsWith("pi-orchestrator-simplicity-"));
        const cwd = ctx.cwd,
          before = await readFile(join(cwd, "greeting.mjs"), "utf8");
        const workflowId = `deviation-smoke-${Date.now()}`;
        const store = new ArtifactStore(join(root, "runs", workflowId));
        const states = new StateStore(store.rootDirectory);
        const spawns: string[] = [];
        const events = {
          on: (event: string, listener: (payload: unknown) => void) =>
            pi.events.on(event, listener),
          emit: (event: string, payload: unknown) => {
            if (
              event === SUBAGENT_RPC_REQUEST_EVENT &&
              isRecord(payload) &&
              payload.method === "spawn" &&
              isRecord(payload.params)
            )
              spawns.push(String(payload.params.agent));
            pi.events.emit(event, payload);
          },
        };
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
        const actual = new SubagentsIntegration(events, {
          cwd,
          launchHost: host,
          artifactReader: store,
          timeoutMs: 120000,
        });
        const plan = `# Stop-only approved strategy smoke
## Scope / Requirements
Only in this disposable workspace. Preserve public greet(name) string-only contract. Object input handling is NOT authorized by this version. The task's object-input requirement therefore requires a new Human-approved strategy before implementation.
## Implementation Approach
Inspect greeting.mjs and report a bounded Plan deviation BEFORE writing if the task requires object input. Do not implement the material change, edit files, rollback or commit. Local private details preserving the string-only contract would be allowed, but cannot satisfy object input.
## Expected Change Surface
greeting.mjs only, after a distinct new Human approval. No mutation in this stop-only attempt.
## New Components
none
## New Dependencies
none
## Non-goals
Object input handling under this Plan; new services, files, dependencies and unrelated refactoring.
## Development Method
STANDARD
## Validation Contract
\`\`\`orchestrator-validation
${JSON.stringify({ schemaVersion: 1, checks: [{ id: "syntax", type: "command", command: "node --check greeting.mjs", cwd: ".", required: true, timeoutMs: 10000 }] })}
\`\`\`
`;
        const scripted = new FakeSubagentExecutor({
          run: [
            succeeded(
              "greeting.mjs:1 exports existing public greet(name): export function greet(name) { return `Hello, ${name}!`; }. There is one function and no service/interface/dependency. Replanning can reuse that existing function for string or object input without new components. Workspace contains only greeting.mjs.",
            ),
            succeeded(plan),
          ],
        });
        const executor: SubagentExecutor = {
          preflight: (input) =>
            scriptedRequest(input)
              ? scripted.preflight(input)
              : actual.preflight(input),
          run: (input) =>
            scriptedRequest(input) ? scripted.run(input) : actual.run(input),
          runParallel: (inputs) => actual.runParallel(inputs),
          status: (id, receipt) => actual.status(id, receipt),
          resume: (id, task) => actual.resume(id, task),
        };
        const deps = {
          artifactStore: store,
          stateStore: states,
          loadState: () => states.loadState(),
          subagentExecutor: executor,
          cwd,
          configuration: {
            ...configuration,
            jev: jevPolicy(cwd, 8),
            executionProfiles: {
              ECONOMY: { provider: "openai", model: "gpt-6.1-sol" },
              STANDARD: { provider: "openai", model: "gpt-6.1-sol" },
              STRONG: { provider: "openai", model: "gpt-6.1-sol" },
            },
          },
          jevDecisionClient: new FakeJevDecisionClient({
            routeExecution: { type: "result", value: routing },
          }),
          plannotatorGate: new PlannotatorIntegration({
            events,
            planReader: store,
          }),
        };
        const created = await createWorkflow(
          {
            task: "Disposable smoke: task ultimately needs greet(name) to accept string OR {first,last}, returning Hello, <full name>!. Original Plan intentionally does NOT authorize object input. Worker must read greeting.mjs, identify the public-contract conflict and emit the exact bounded PLAN_DEVIATION stop report without writing any file or contacting supervisor. After stop, Planner should propose a minimal new strategy using the existing function, explicitly allowing object input with no new components/dependencies. Preserve STANDARD and exact Validation Contract. No source writes during planning; no approval inferred.",
            playbook: "chore",
            developmentIntent: "BEHAVIOR_FREE",
            cwd,
          },
          {
            ...deps,
            runsDirectory: join(root, "runs"),
            workflowIdFactory: () => workflowId,
          },
        );
        let active = false;
        const afterHuman = async () => {
          if (active) return;
          const state = await states.loadState();
          if (
            state.phase !== "awaiting-plan-review" ||
            state.planning.currentPlanVersion !== 1
          )
            return;
          active = true;
          try {
            const result = await driveWorkflow(workflowId, deps);
            if (
              result.state.planning.currentPlanVersion === 1 &&
              result.state.phase === "awaiting-plan-review"
            ) {
              active = false;
              return;
            }
            assert.equal(
              result.state.phase,
              "awaiting-plan-review",
              JSON.stringify(result.state.block),
            );
            assert(result.state.planning.currentPlanVersion >= 2);
            assert.equal(result.state.planning.approvedPlanRef, undefined);
            assert.equal(result.state.coding.implementationRef, undefined);
            assert.equal(result.state.coding.implementationRevision, 0);
            assert.equal(result.state.coding.executionRoutingRef, undefined);
            const deviation = await readPlanDeviation(store, result.state);
            assert(deviation);
            const worker = parseWorkerAttempt(
              JSON.parse(await store.readText(deviation.workerAttemptRef)),
            );
            assert(worker.receipt && worker.runId);
            assert.equal(worker.status, "deviated");
            const recovered = await actual.status(worker.runId, worker.receipt);
            assert.equal(recovered.status, "succeeded");
            assert(recovered.result?.status === "succeeded");
            assert.equal(recovered.result.output, deviation.output);
            const review = await simplicityEvidence(result.state, deps);
            assert(review);
            const count = spawns.length;
            const resumed = await resumeWorkflow(workflowId, {
              ...deps,
              runDirectory: store.rootDirectory,
              plannotatorGate: new PlannotatorIntegration({
                events,
                planReader: store,
              }),
            });
            assert.equal(resumed.state.phase, "awaiting-plan-review");
            assert.equal(spawns.length, count);
            assert.equal(spawns.filter((x) => x === "worker").length, 1);
            assert(spawns.includes("planner"));
            assert.equal(
              await readFile(join(cwd, "greeting.mjs"), "utf8"),
              before,
            );
            const receipts = [
              worker.receipt,
              ...Object.values(result.state.planning.agentAttempts ?? {})
                .filter(
                  (a) =>
                    a.launch?.source !== "fixture" &&
                    a.receipt &&
                    spawns.includes(a.receipt.agent),
                )
                .map((a) => a.receipt!),
            ];
            const terminals = await Promise.all(
              receipts
                .filter((r) => r.asyncDir !== "/fixture/async")
                .map(async (receipt) => {
                  const status = JSON.parse(
                    await readFile(
                      join(receipt.asyncDir, "status.json"),
                      "utf8",
                    ),
                  );
                  assert.equal(status.processTerminal.state, "observed");
                  assert(
                    status.processTerminal.instances.every(
                      (i: { exitCode: number }) => i.exitCode === 0,
                    ),
                  );
                  return { receipt, processTerminal: status.processTerminal };
                }),
            );
            Object.assign(report, {
              status: "passed",
              finishedAt: new Date().toISOString(),
              spawns,
              deviation,
              review,
              terminals,
              phase: result.state.phase,
              planVersion: result.state.planning.currentPlanVersion,
              redispatches: 0,
              limitation:
                "Scout/original candidate/classifier are scripted. Actual Human approved original stop-only Plan; actual Worker stopped without mutation; actual Planner/fresh simplicity and second actual Human Gate pending. No second approval, implementation continuation, Code Gate, live Jev or full lifecycle production PASS.",
            });
            unsubscribe?.();
            await save();
            ctx.ui.notify(
              `Deviation smoke passed (second Gate remains pending): ${reportPath}`,
              "info",
            );
          } catch (error) {
            unsubscribe?.();
            await fail(error);
          }
        };
        unsubscribe = pi.events.on("plannotator:review-result", () => {
          void afterHuman();
        });
        const first = await driveWorkflow(created.workflowId, deps);
        assert.equal(first.state.phase, "awaiting-plan-review");
        assert.equal(spawns.filter((x) => x === "worker").length, 0);
        Object.assign(report, {
          status: "awaiting-human-plan-review",
          runDirectory: store.rootDirectory,
          spawns,
          reviewId: first.state.planning.planReview?.reviewId,
        });
        await save();
        ctx.ui.notify(
          "Deviation smoke: please approve the disposable STOP-ONLY Plan in Plannotator. Worker will only inspect and stop; it cannot implement the proposed object API before the second Human Gate.",
          "info",
        );
        await afterHuman();
      } catch (error) {
        unsubscribe?.();
        await fail(error);
      }
    },
  });
}
