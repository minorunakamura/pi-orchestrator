import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Evaluation, Questions, SystemOneRequest } from "pi-typesafe";
import { TypeSafeIntegrationError } from "pi-typesafe";
import type { ReviewFinding } from "../../src/core/coding/finding.ts";
import type {
  ModelTier,
  ReasoningTier,
  RoundAction,
  EscalationReason,
  ValidationContract,
  ValidationCheckStatus,
} from "../../src/core/decisions/types.ts";
import type { WorkflowArtifactWriter } from "../../src/runtime/orchestrator/planning-orchestrator.ts";
import type { ArtifactRef } from "../../src/core/artifacts/references.ts";
import type { WorkflowState } from "../../src/core/workflow/state.ts";
import { ArtifactStore } from "../../src/runtime/persistence/artifact-store.ts";
import { StateStore } from "../../src/runtime/persistence/state-store.ts";
import {
  JevIntegration,
  type JevClient,
} from "../../src/runtime/integrations/jev.ts";
import { PlannotatorIntegration } from "../../src/runtime/integrations/plannotator.ts";
import {
  SubagentsIntegration,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  type EventBus,
} from "../../src/runtime/integrations/subagents.ts";
import { startWorkflow } from "../../src/runtime/orchestrator/start-workflow.ts";
import { PlanningOrchestrator } from "../../src/runtime/orchestrator/planning-orchestrator.ts";
import { CodingOrchestrator } from "../../src/runtime/orchestrator/coding-orchestrator.ts";
import {
  ValidationRunner,
  type ValidationRunResult,
} from "../../src/runtime/orchestrator/validation-runner.ts";
import { ReviewRunner } from "../../src/runtime/orchestrator/review-runner.ts";
import { FindingEvaluationRunner } from "../../src/runtime/orchestrator/finding-evaluation.ts";
import { RoundDecisionRunner } from "../../src/runtime/orchestrator/round-decision.ts";
import {
  resumeWorkflow,
  type ResumeWorkflowOptions,
} from "../../src/runtime/orchestrator/resume-workflow.ts";
import type {
  ClarificationRequest,
  ValidationExecutor,
} from "../../src/runtime/ports/index.ts";
import { configuration as defaults, plan } from "./coding-scenario.ts";
import { jevPolicy } from "./jev-policy.ts";

export interface RoundReply {
  action: RoundAction;
  reason?: EscalationReason;
  confidence?: number;
  reasonConfidence?: number;
}
export interface WorkflowScript {
  rounds?: RoundReply[];
  routes?: { model: ModelTier; reasoning: ReasoningTier }[];
  reviews?: ReviewFinding[][];
  findings?: Record<
    string,
    { human?: boolean; planConflict?: boolean; confidence?: number }
  >;
  validations?: (ValidationCheckStatus | "throw")[];
  workers?: ("success" | "timeout" | "ambiguous" | "failed")[];
  codeReviews?: ("approved" | "feedback")[];
  silentReviewer?: boolean;
  maxRequests?: number;
  consent?: boolean;
  stopOnInfrastructureFailure?: boolean;
  maxFixes?: number;
  maxStronger?: number;
  jevFailures?: number;
  transportRetries?: number;
  codeGateUnavailable?: boolean;
  staleCodeStatus?: boolean;
}
interface ChildRequest {
  requestId: string;
  ownerRunId: string;
  nodeId: string;
  agent: string;
  task: string;
  context: string;
  cwd: string;
  model?: string;
  thinking?: string;
}
interface GateRequest {
  action: string;
  payload: Record<string, unknown>;
  respond: (response: unknown) => void;
}

/** Explicit public stage calls only: no transition engine, recovery loop, or synthetic authority. */
export async function phaseCWorkflow(script: WorkflowScript = {}) {
  const root = await mkdtemp(join(tmpdir(), "phase-c-e2e-"));
  const repositoryCwd = join(root, "repo");
  await mkdir(repositoryCwd);
  await promisify(execFile)("git", ["init", "--quiet", repositoryCwd]);
  const workflowId = "full-fake";
  const runDirectory = join(root, "runs", workflowId);
  const artifactStore = new ArtifactStore(runDirectory);
  const stateStore = new StateStore(runDirectory);
  const configuration = structuredClone(defaults);
  configuration.jev =
    script.consent === false
      ? {}
      : jevPolicy(workflowId, repositoryCwd, script.maxRequests ?? 100);
  configuration.jev.maxTransportRetries = script.transportRetries ?? 0;
  configuration.validation.stopOnInfrastructureFailure =
    script.stopOnInfrastructureFailure ?? true;
  configuration.retries.maxAutomatedFixRounds = script.maxFixes ?? 3;
  configuration.retries.maxStrongerRetries = script.maxStronger ?? 1;
  const faults = {
    routingArtifact: false,
    routingState: false,
    intentState: false,
    codeIdentityState: false,
    codeApprovalState: false,
  };
  const artifactWriter: WorkflowArtifactWriter = {
    rootDirectory: artifactStore.rootDirectory,
    readText: artifactStore.readText.bind(artifactStore),
    writeText: artifactStore.writeText.bind(artifactStore),
    writeJson: async (kind, name, value, schema) => {
      if (faults.routingArtifact && kind === "execution-routing") {
        faults.routingArtifact = false;
        throw Error("injected routing Artifact failure");
      }
      return artifactStore.writeJson(kind, name, value, schema);
    },
  };
  const stateWriter = {
    saveState: async (state: WorkflowState, revision?: number) => {
      if (faults.routingState && state.coding.executionRoutingRef) {
        faults.routingState = false;
        throw Error("injected routing State failure");
      }
      if (faults.codeApprovalState && state.phase === "completed") {
        faults.codeApprovalState = false;
        throw Error("injected Code Approval State failure");
      }
      if (faults.intentState && state.coding.workerAttemptRef) {
        faults.intentState = false;
        throw Error("injected intent State failure");
      }
      if (faults.codeIdentityState && state.coding.codeReview) {
        faults.codeIdentityState = false;
        throw Error("injected Code Review identity State failure");
      }
      return stateStore.saveState(state, revision);
    },
  };
  const children: ChildRequest[] = [];
  const childCounts = new Map<string, number>();
  const listeners = new Set<(value: unknown) => void>();
  const deliver = (request: ChildRequest, status: string, output?: string) => {
    for (const listener of listeners)
      listener({
        requestId: request.requestId,
        ownerRunId: request.ownerRunId,
        nodeId: request.nodeId,
        status,
        runId: `${request.agent}-${childCounts.get(request.agent)}`,
        ...(output === undefined
          ? {}
          : { result: { kind: "text", text: output } }),
      });
  };
  const handleChild = async (request: ChildRequest) => {
    const nth = childCounts.get(request.agent)!;
    if (request.agent === "worker") {
      const durable = await stateStore.loadState();
      if (
        !durable.coding.workerAttemptRef ||
        !durable.coding.executionRoutingRef
      )
        throw Error("Worker called before durable intent/routing");
      const intent = JSON.parse(
        await artifactStore.readText(durable.coding.workerAttemptRef),
      );
      if (
        intent.status !== "intent" ||
        intent.dispatch.requestId !== request.requestId
      )
        throw Error("Worker dispatch does not match durable intent");
      await writeFile(
        join(repositoryCwd, "implementation.txt"),
        `implementation revision ${nth}\n`,
      );
      const outcome = script.workers?.[nth - 1] ?? "success";
      if (outcome === "timeout") return;
      deliver(
        request,
        outcome === "success"
          ? "completed"
          : outcome === "ambiguous"
            ? "unknown"
            : "failed",
        `Worker evidence ${nth}`,
      );
      return;
    }
    if (request.agent === "reviewer" || request.agent === "ponytail-reviewer") {
      if (script.silentReviewer && request.agent === "ponytail-reviewer")
        return;
      const round = Number(/"round":(\d+)/u.exec(request.task)?.[1]);
      if (!round) throw Error("Review request lacks a round");
      const source = request.agent === "reviewer" ? "correctness" : "ponytail";
      deliver(
        request,
        "completed",
        JSON.stringify({
          schemaVersion: 1,
          round,
          source,
          findings: (script.reviews?.[round - 1] ?? []).filter(
            (finding) => finding.source === source,
          ),
        }),
      );
      return;
    }
    const output =
      request.agent === "planner"
        ? nth === 1
          ? plan
          : plan.replace(
              "Preserve the public API.",
              `Preserve the public API with approved clarification ${nth}.`,
            )
        : "Repository facts";
    deliver(request, "completed", output);
  };
  const events: EventBus = {
    on: (event, listener) => {
      if (event !== SUBAGENT_DELEGATION_RESPONSE_EVENT)
        throw Error("Unexpected response channel");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event, payload) => {
      if (event !== SUBAGENT_DELEGATION_REQUEST_EVENT) return;
      const request = payload as ChildRequest;
      children.push(request);
      childCounts.set(request.agent, (childCounts.get(request.agent) ?? 0) + 1);
      void handleChild(request).catch(() => deliver(request, "failed"));
    },
  };
  const subagentExecutor = new SubagentsIntegration(events, {
    cwd: repositoryCwd,
    timeoutMs:
      script.workers?.includes("timeout") || script.silentReviewer ? 100 : 5000,
  });
  const gates: { action: string; payload: Record<string, unknown> }[] = [];
  const externalReviews = new Map<
    string,
    {
      approved: boolean;
      feedback?: string;
      implementationRef?: ArtifactRef<"implementation">;
      implementationRevision?: number;
    }
  >();
  let planGates = 0,
    codeGates = 0;
  const gateEvents = {
    emit: async (_channel: string, payload: unknown) => {
      const request = payload as GateRequest;
      gates.push({ action: request.action, payload: request.payload });
      if (request.action === "review-status") {
        const result = externalReviews.get(String(request.payload.reviewId));
        request.respond({
          status: "handled",
          result: result
            ? {
                status: "completed",
                reviewId: request.payload.reviewId,
                ...result,
              }
            : { status: "missing" },
        });
        return;
      }
      if (request.action === "code-review" && script.codeGateUnavailable) {
        request.respond({ status: "unavailable" });
        return;
      }
      const durable = await stateStore.loadState();
      const code = request.action === "code-review";
      if (
        durable.phase !==
        (code ? "awaiting-code-review" : "awaiting-plan-review")
      )
        throw Error("Gate opened before durable phase");
      if (
        code &&
        (request.payload.implementationRevision !==
          durable.coding.implementationRevision ||
          JSON.stringify(request.payload.implementationRef) !==
            JSON.stringify(durable.coding.implementationRef))
      )
        throw Error("Gate opened with stale implementation");
      const reviewId = code ? `code-${++codeGates}` : `plan-${++planGates}`;
      const feedback =
        code && script.codeReviews?.[codeGates - 1] === "feedback";
      externalReviews.set(reviewId, {
        approved: !feedback,
        ...(feedback
          ? { feedback: "Add the requested regression coverage" }
          : {}),
        ...(code && script.staleCodeStatus
          ? {
              implementationRef: {
                ...(request.payload
                  .implementationRef as ArtifactRef<"implementation">),
                sha256: "f".repeat(64),
              },
              implementationRevision: Number(
                request.payload.implementationRevision,
              ),
            }
          : {}),
      });
      request.respond({
        status: "handled",
        result: { status: "pending", reviewId },
      });
    },
  };
  const newGate = () =>
    new PlannotatorIntegration({
      events: gateEvents,
      planReader: artifactStore,
      timeoutMs: 5000,
    });
  const jevRequests: SystemOneRequest[] = [];
  let roundCalls = 0,
    routeCalls = 0;
  const client: JevClient = {
    evaluate: async <Q extends Questions>(
      request: SystemOneRequest<Q>,
    ): Promise<Evaluation<Q>> => {
      jevRequests.push(request);
      const durable = await stateStore.loadState();
      if (
        !durable.jevUsage?.latestRequestRef ||
        durable.jevUsage.attemptsReserved !== jevRequests.length
      )
        throw Error("Jev called before durable reservation");
      await artifactStore.readText(durable.jevUsage.latestRequestRef);
      if (jevRequests.length <= (script.jevFailures ?? 0))
        throw new TypeSafeIntegrationError("connection", "scripted Jev outage");
      const state = request.state as Record<string, unknown>;
      const kind =
        "modelTier" in request.questions
          ? "routing"
          : "decision" in request.questions
            ? "round"
            : "finding";
      const route =
        kind === "routing"
          ? (script.routes?.[routeCalls++] ?? {
              model: "STANDARD",
              reasoning: "MEDIUM",
            })
          : undefined;
      const round =
        kind === "round"
          ? (script.rounds?.[roundCalls++] ?? { action: "COMPLETE" })
          : undefined;
      const finding =
        kind === "finding"
          ? script.findings?.[String((state.finding as { id: string }).id)]
          : undefined;
      const values: Record<string, string> = {
        modelTier: route?.model ?? "STANDARD",
        reasoningTier: route?.reasoning ?? "MEDIUM",
        decision: round?.action ?? "COMPLETE",
        escalationReason: round?.reason ?? "implementation-capability",
        evidenceSupported: "true",
        conflictsWithApprovedPlan: String(finding?.planConflict ?? false),
        conflictsWithArchitecture: "false",
        inScope: "true",
        requiresHumanDecision: String(finding?.human ?? false),
      };
      const answers = Object.fromEntries(
        Object.entries(request.questions).map(([key, question]) => {
          const options = Object.keys(question.criteria ?? {});
          const choice = values[key];
          if (!choice || !options.includes(choice))
            throw Error("Unexpected Jev Choice contract");
          const confidence =
            kind === "finding"
              ? (finding?.confidence ?? 0.99)
              : key === "escalationReason"
                ? (round?.reasonConfidence ?? 0.99)
                : (round?.confidence ?? 0.99);
          return [
            key,
            {
              type: "choice",
              choice,
              confidence,
              probabilities: Object.fromEntries(
                options.map((option) => [
                  option,
                  option === choice
                    ? confidence
                    : (1 - confidence) / (options.length - 1),
                ]),
              ),
            },
          ];
        }),
      );
      return {
        answers,
        model: "fake-jev",
        usage: { input_tokens: 10, output_tokens: 1 },
        elapsedMs: 1,
      } as Evaluation<Q>;
    },
  };
  const jevDecisionClient = new JevIntegration({
    ...configuration.jev,
    client,
  });
  const validations: ValidationContract[] = [];
  const validationExecutor: ValidationExecutor = {
    execute: async (contract) => {
      validations.push(structuredClone(contract));
      const status = script.validations?.[validations.length - 1] ?? "passed";
      if (status === "throw") throw Error("scripted spawn failure");
      return {
        status,
        checks: contract.checks.map(({ id }) => ({
          id,
          status,
          ...(status === "infrastructure-error"
            ? { evidence: "scripted infrastructure failure" }
            : { exitCode: status === "passed" ? 0 : 1 }),
        })),
      };
    },
  };
  const clarifications: ClarificationRequest[] = [];
  const clarificationPort = {
    request: async (input: ClarificationRequest) => {
      clarifications.push(input);
      return {
        status: "provided" as const,
        answer: `Approved scope choice ${clarifications.length}`,
      };
    },
  };
  const deps = {
    artifactStore: artifactWriter,
    stateStore: stateWriter,
    repositoryCwd,
    subagentExecutor,
    jevDecisionClient,
    configuration,
    validationExecutor,
    clarificationPort,
    plannotatorGate: newGate(),
  };
  const planning = new PlanningOrchestrator(deps);
  const coding = (freshGate = false) =>
    new CodingOrchestrator({
      ...deps,
      ...(freshGate ? { plannotatorGate: newGate() } : {}),
    });
  let validation: ValidationRunResult | undefined;
  try {
    await startWorkflow(
      {
        task: "Implement the approved feature",
        playbook: "feature",
        cwd: repositoryCwd,
      },
      {
        runsDirectory: join(root, "runs"),
        workflowIdFactory: () => workflowId,
        artifactStore,
        stateStore: stateWriter,
        subagentExecutor,
      },
    );
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    repositoryCwd,
    artifactStore,
    stateStore,
    configuration,
    subagentExecutor,
    jevDecisionClient,
    validationExecutor,
    clarificationPort,
    faults,
    children,
    gates,
    jevRequests,
    validations,
    clarifications,
    coding,
    load: () => stateStore.loadState(),
    cleanup: () => rm(root, { recursive: true, force: true }),
    resume: (overrides: Partial<ResumeWorkflowOptions> = {}) =>
      resumeWorkflow(workflowId, {
        runDirectory,
        artifactStore: artifactWriter,
        stateStore: stateWriter,
        subagentExecutor,
        jevDecisionClient,
        validationExecutor,
        clarificationPort,
        plannotatorGate: newGate(),
        configuration,
        repositoryCwd,
        ...overrides,
      }),
    createPlan: async () =>
      planning.createPlan({
        state: await stateStore.loadState(),
        cwd: repositoryCwd,
      }),
    settlePlan: async () => {
      const state = await stateStore.loadState();
      if (!state.planning.planReview) throw Error("No durable Plan Gate");
      return planning.reconcilePlanReview({
        state,
        reviewId: state.planning.planReview.reviewId,
      });
    },
    clarify: async () =>
      planning.requestClarification({
        state: await stateStore.loadState(),
        prompt: "Resolve the scope decision",
      }),
    implement: async (changeScope?: string) =>
      coding().execute({
        state: await stateStore.loadState(),
        ...(changeScope ? { changeScope } : {}),
      }),
    validate: async (contract?: ValidationContract) => {
      validation = await new ValidationRunner(deps).execute({
        state: await stateStore.loadState(),
        ...(contract ? { contract } : {}),
      });
      return validation;
    },
    review: async () =>
      new ReviewRunner(deps).execute({
        state: await stateStore.loadState(),
        cwd: repositoryCwd,
      }),
    evaluate: async () =>
      new FindingEvaluationRunner(deps).execute({
        state: await stateStore.loadState(),
      }),
    decide: async () => {
      if (!validation) throw Error("No validation result from the runner");
      return new RoundDecisionRunner(deps).execute({
        state: await stateStore.loadState(),
        validation: validation.validation,
        validationRef: validation.validationRef,
      });
    },
    openCode: async () =>
      coding().openCodeReview({ state: await stateStore.loadState() }),
    settleCode: async (freshGate = false) => {
      const state = await stateStore.loadState();
      if (!state.coding.codeReview) throw Error("No durable Code Gate");
      return coding(freshGate).reconcileCodeReview({
        state,
        reviewId: state.coding.codeReview.reviewId,
      });
    },
    listenerCount: () => listeners.size,
    roundCalls: () => roundCalls,
  };
}
export type PhaseCWorkflow = Awaited<ReturnType<typeof phaseCWorkflow>>;
export function reviewFinding(
  id: string,
  source: ReviewFinding["source"] = "correctness",
): ReviewFinding {
  return {
    id,
    source,
    category: "regression",
    summary: `${id}: preserve behavior`,
    evidence: `${id}: concrete changed-path evidence`,
    blocking: true,
  };
}
