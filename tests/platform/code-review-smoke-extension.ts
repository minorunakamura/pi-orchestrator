import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { phaseCWorkflow } from "../fakes/phase-c-workflow.ts";
import { PlannotatorIntegration } from "../../src/runtime/integrations/plannotator.ts";
import { isCodeReviewAttempt } from "../../src/core/coding/code-review.ts";
import { parseCodeReviewArtifact } from "../../src/runtime/orchestrator/coding-orchestrator.ts";
import { calculateSha256 } from "../../src/runtime/persistence/artifact-store.ts";
import { isRecord } from "../../src/core/schema.ts";

/** Focused actual Human Code UI; all preceding agents/classifiers/Plan approval are fixtures. */
export default function (pi: ExtensionAPI) {
  for (const nonGit of [false, true])
    pi.registerCommand(
      nonGit ? "non-git-code-review-smoke" : "code-review-smoke",
      {
        description:
          "Actual synchronous Human Code Gate / exact Git or filesystem patch / recovery smoke",
        async handler(reportPath, ctx) {
          const report: Record<string, unknown> = {
            status: "failed",
            pi: VERSION,
            startedAt: new Date().toISOString(),
            herdrTab: process.env.HERDR_TAB_ID,
            herdrPane: process.env.HERDR_PANE_ID,
          };
          try {
            assert.equal(process.env.HERDR_ENV, "1");
            assert.equal(VERSION, "0.99.1");
            assert.equal(ctx.isProjectTrusted(), false);
            const h = await phaseCWorkflow(
              nonGit
                ? {
                    nonGit: true,
                    workerChanges: [
                      {
                        "modified.txt": "final\n",
                        "deleted.txt": null,
                        "added.txt": "added\n",
                      },
                    ],
                  }
                : {},
            );
            report.provider = nonGit ? "filesystem" : "git";
            report.fixtureRoot = h.root;
            report.workflowRoot = h.artifactStore.rootDirectory;
            await h.createPlan();
            await h.settlePlan();
            if (nonGit) {
              await writeFile(
                join(h.repositoryCwd, "modified.txt"),
                "baseline\n",
              );
              await writeFile(
                join(h.repositoryCwd, "deleted.txt"),
                "deleted baseline\n",
              );
              await writeFile(
                join(h.repositoryCwd, "pre-existing.txt"),
                "unchanged pre-existing content\n",
              );
            }
            await h.implement();
            await h.validate();
            await h.review();
            await h.evaluate();
            await h.decide();
            assert.equal((await h.load()).phase, "awaiting-code-review");
            const before = await readFile(
              join(h.repositoryCwd, "implementation.txt"),
            );
            const actions: string[] = [];
            let rawResponse: unknown;
            let openedAt = 0;
            const events = {
              emit: async (channel: string, payload: unknown) => {
                assert.equal(channel, "plannotator:request");
                assert(isRecord(payload));
                assert.equal(payload.action, "code-review");
                actions.push(payload.action);
                const state = await h.load();
                assert(state.coding.codeReviewAttemptRef);
                const attempt = JSON.parse(
                  await h.artifactStore.readText(
                    state.coding.codeReviewAttemptRef,
                  ),
                );
                assert(isCodeReviewAttempt(attempt));
                assert.equal(payload.requestId, attempt.requestId);
                assert(isRecord(payload.payload));
                assert.deepEqual(Object.keys(payload.payload).toSorted(), [
                  "cwd",
                  "patchFile",
                ]);
                assert.equal(
                  payload.payload.patchFile,
                  attempt.source.patchFile,
                );
                const patch = await readFile(attempt.source.patchFile);
                assert.equal(
                  calculateSha256(patch),
                  attempt.source.patchSha256,
                );
                assert(patch.toString().includes("+implementation revision 1"));
                assert.equal(
                  attempt.source.type,
                  nonGit ? "filesystem-patch" : "git-patch",
                );
                if (nonGit) {
                  assert(patch.toString().includes("-baseline"));
                  assert(patch.toString().includes("+final"));
                  assert(patch.toString().includes("-deleted baseline"));
                  assert(patch.toString().includes("+added"));
                  assert(!patch.toString().includes("pre-existing.txt"));
                  report.workspaceBaselineRef =
                    state.coding.workspaceBaselineRef;
                  report.workerAttemptRef = state.coding.workerAttemptRef;
                }
                report.attempt = attempt;
                report.attemptRef = state.coding.codeReviewAttemptRef;
                report.status = "waiting-for-human";
                openedAt = Date.now();
                await writeFile(
                  reportPath.trim(),
                  JSON.stringify(report, null, 2),
                );
                const respond = payload.respond;
                assert.equal(typeof respond, "function");
                pi.events.emit(channel, {
                  ...payload,
                  respond: (response: unknown) => {
                    rawResponse = response;
                    if (typeof respond === "function") respond(response);
                  },
                });
              },
            };
            const actual = new PlannotatorIntegration({
              events,
              planReader: h.artifactStore,
            });
            const stop = new AbortController();
            const result = await h.drive({
              signal: stop.signal,
              plannotatorGate: {
                openPlanReview: actual.openPlanReview.bind(actual),
                getPlanReview: actual.getPlanReview.bind(actual),
                openCodeReview: async (input) => {
                  const answer = await actual.openCodeReview(input);
                  if (!answer.approved) stop.abort();
                  return answer;
                },
              },
            });
            assert(isRecord(rawResponse));
            assert.equal(rawResponse.status, "handled");
            assert(isRecord(rawResponse.result));
            assert.equal(typeof rawResponse.result.approved, "boolean");
            assert.equal(rawResponse.result.reviewId, undefined);
            const state = await h.load();
            assert(state.coding.latestCodeReviewRef);
            const artifact = parseCodeReviewArtifact(
              JSON.parse(
                await h.artifactStore.readText(
                  state.coding.latestCodeReviewRef,
                ),
              ),
            );
            assert.equal(artifact.result.approved, rawResponse.result.approved);
            assert.deepEqual(
              artifact.attemptRef,
              state.coding.codeReviewAttemptRef,
            );
            assert.deepEqual(
              artifact.implementationRef,
              state.coding.implementationRef,
            );
            assert.equal(
              state.phase,
              artifact.result.approved ? "completed" : "fixing",
            );
            assert.deepEqual(result.state, state);
            assert.deepEqual(
              await readFile(join(h.repositoryCwd, "implementation.txt")),
              before,
            );
            const recovered = await h.settleCode(true);
            assert.deepEqual(recovered.state, state);
            assert.deepEqual(actions, ["code-review"]);
            assert.equal(
              h.children.filter((child) => child.agent === "worker").length,
              1,
            );
            assert.equal(
              Object.keys(state.external).some((key) =>
                key.startsWith("plannotator.code-review."),
              ),
              false,
            );
            const elapsedMs = Date.now() - openedAt;
            assert(
              elapsedMs > 5000,
              "Human must deliberate beyond five seconds for the duration proof",
            );
            Object.assign(report, {
              status: "passed",
              finishedAt: new Date().toISOString(),
              elapsedMs,
              actions,
              rawResponse,
              resultArtifact: artifact,
              resultRef: state.coding.latestCodeReviewRef,
              stateRevision: state.stateRevision,
              phase: state.phase,
              actualCodeRequests: 1,
              codePolls: 0,
              reopens: 0,
              fixtureWorkerRequests: 1,
              actualWorkerRequests: 0,
              liveClassifierRequests: 0,
            });
          } catch (error) {
            report.error = error instanceof Error ? error.stack : String(error);
          }
          await writeFile(reportPath.trim(), JSON.stringify(report, null, 2));
          ctx.ui.notify(
            `Code Review smoke: ${String(report.status)}; ${reportPath.trim()}`,
            report.status === "passed" ? "info" : "error",
          );
        },
      },
    );
}
