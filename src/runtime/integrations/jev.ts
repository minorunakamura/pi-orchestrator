import {
  ask,
  choice,
  createTypeSafe,
  type Questions,
  type SystemOneRequest,
  type TypeSafe,
  type TypeSafeOptions,
} from "pi-typesafe";
import {
  jevDestination,
  type JevConfiguration,
} from "../../core/configuration.ts";
import type {
  JevCallAuthorization,
  JevRequestFamily,
} from "../ports/jev-decision-client.ts";
import { isConfidence, isRecord } from "../../core/schema.ts";
import type { ReviewFinding } from "../../core/coding/finding.ts";
import type {
  ExecutionRoutingInput,
  ExecutionRoutingRawDecision,
  FindingEvaluationInput,
  FindingEvaluationRawDecision,
  JevDecisionClient,
  RoundDecisionInput,
  RoundDecisionRawDecision,
} from "../ports/jev-decision-client.ts";
import { RuntimePortError } from "../ports/errors.ts";

export const DEFAULT_JEV_TIMEOUT_MS = 15_000;

export type JevClient = Pick<TypeSafe, "evaluate">;
export type JevTransport = NonNullable<TypeSafeOptions["fetch"]>;

export interface JevIntegrationOptions extends JevConfiguration {
  client?: JevClient;
  createClient?: () => JevClient;
  transport?: JevTransport;
}

type JevRequest = SystemOneRequest;

const modelTiers = ["ECONOMY", "STANDARD", "STRONG"] as const;
const reasoningTiers = ["LOW", "MEDIUM", "HIGH"] as const;
const booleanChoices = ["true", "false"] as const;
const roundActions = ["COMPLETE", "RETRY", "ESCALATE"] as const;
const escalationReasons = [
  "implementation-capability",
  "plan-conflict",
  "human-decision",
  "uncertain",
] as const;

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRetriable(code: string | undefined): boolean {
  return code === "timeout" || code === "connection";
}

function normalizeFailure(
  code: string | undefined,
  message: string,
): RuntimePortError {
  return new RuntimePortError(
    code === "timeout" || code === "aborted" ? "timeout" : "infrastructure",
    `Jev integration failed: ${message}`,
  );
}

function request(state: unknown, questions: Questions): JevRequest {
  return { state: state as JevRequest["state"], questions };
}

function findingState(finding: ReviewFinding): Record<string, unknown> {
  return {
    id: finding.id,
    source: finding.source,
    category: finding.category,
    ...(finding.location === undefined ? {} : { location: finding.location }),
    summary: finding.summary,
    evidence: finding.evidence,
    blocking: finding.blocking,
  };
}

function routeState(input: ExecutionRoutingInput): Record<string, unknown> {
  return {
    approvedPlanRef: input.approvedPlanRef,
    planEvidence: input.planEvidence,
    playbook: input.playbook,
    changeScope: input.changeScope,
    contextRefs: input.contextRefs,
    contextEvidence: input.contextEvidence,
    priorRetryCount: input.priorRetryCount,
  };
}

function findingRequest(
  input: FindingEvaluationInput,
  finding: ReviewFinding,
): JevRequest {
  return request(
    {
      approvedPlanRef: input.approvedPlanRef,
      implementationRevision: input.implementationRevision,
      finding: findingState(finding),
      reviewRef: input.reviewRefs[finding.source],
      evidence: input.evidence,
    },
    {
      evidenceSupported: choice(
        "Is the finding supported by the supplied evidence?",
        {
          true: "The evidence supports the finding.",
          false: "The evidence does not support the finding.",
        },
      ),
      conflictsWithApprovedPlan: choice(
        "Does the finding conflict with the approved plan?",
        {
          true: "The finding conflicts with the approved plan.",
          false: "The finding does not conflict with the approved plan.",
        },
      ),
      conflictsWithArchitecture: choice(
        "Does the finding conflict with the approved architecture?",
        {
          true: "The finding conflicts with the approved architecture.",
          false:
            "The finding does not conflict with the approved architecture.",
        },
      ),
      inScope: choice("Is the finding within the approved change scope?", {
        true: "The finding is within scope.",
        false: "The finding is outside scope.",
      }),
      requiresHumanDecision: choice(
        "Does resolving the finding require a human decision?",
        {
          true: "A human decision is required.",
          false: "No human decision is required.",
        },
      ),
    },
  );
}

function routeRequest(input: ExecutionRoutingInput): JevRequest {
  return request(routeState(input), {
    modelTier: choice("Which logical model tier fits the approved change?", {
      ECONOMY: "A small, low-risk change.",
      STANDARD: "A normal change with moderate complexity.",
      STRONG: "A high-risk or complex change.",
    }),
    reasoningTier: choice("Which reasoning tier fits the approved change?", {
      LOW: "Straightforward reasoning is sufficient.",
      MEDIUM: "Some multi-step reasoning is required.",
      HIGH: "Deep or high-risk reasoning is required.",
    }),
  });
}

function roundRequest(input: RoundDecisionInput): JevRequest {
  return request(
    {
      approvedPlanRef: input.approvedPlanRef,
      implementationRevision: input.implementationRevision,
      validation: input.validation,
      findings: input.findings,
      findingSummaries: input.findingSummaries,
      evidence: input.evidence,
      branch: input.branch,
      retryLimits: input.retryLimits,
      currentProfile: input.currentProfile,
      inputRefs: input.inputRefs,
    },
    {
      decision: choice("How should the current coding round be handled?", {
        COMPLETE: "The automated coding round is clean.",
        RETRY: "A bounded retry within the approved plan is appropriate.",
        ESCALATE: "The round cannot safely continue without escalation.",
      }),
      escalationReason: choice(
        "If escalation is needed, which bounded reason applies?",
        {
          "implementation-capability":
            "The implementation needs a stronger execution profile.",
          "plan-conflict": "The finding conflicts with the approved plan.",
          "human-decision": "A human decision is required.",
          uncertain: "The decision is too uncertain to continue automatically.",
        },
      ),
    },
  );
}

function normalizeAnswers(
  value: unknown,
  questions: Questions,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new RuntimePortError(
      "infrastructure",
      "Jev returned an invalid answers object",
    );
  }
  const questionIds = Object.keys(questions);
  if (
    Object.keys(value).length !== questionIds.length ||
    questionIds.some((questionId) => !Object.hasOwn(value, questionId))
  ) {
    throw new RuntimePortError(
      "infrastructure",
      "Jev response answers do not match the requested questions",
    );
  }
  return value;
}

function choiceAnswer<const T extends readonly string[]>(
  answers: Record<string, unknown>,
  questionId: string,
  allowed: T,
): { value: T[number]; confidence: number } {
  const answer = answers[questionId];
  if (!isRecord(answer) || answer.type !== "choice") {
    throw new RuntimePortError(
      "infrastructure",
      `Jev response is missing a Choice answer for ${questionId}`,
    );
  }
  if (
    typeof answer.choice !== "string" ||
    !allowed.includes(answer.choice) ||
    !isConfidence(answer.confidence)
  ) {
    throw new RuntimePortError(
      "infrastructure",
      `Jev returned an invalid Choice answer for ${questionId}`,
    );
  }
  const probabilities = answer.probabilities;
  if (
    !isRecord(probabilities) ||
    Object.keys(probabilities).length !== allowed.length ||
    allowed.some(
      (value) =>
        !Object.hasOwn(probabilities, value) ||
        !isConfidence(probabilities[value]),
    )
  ) {
    throw new RuntimePortError(
      "infrastructure",
      `Jev returned an invalid Choice answer for ${questionId}`,
    );
  }
  return { value: answer.choice, confidence: answer.confidence };
}

function booleanDecision(
  answers: Record<string, unknown>,
  questionId: string,
): { value: boolean; confidence: number } {
  const answer = choiceAnswer(answers, questionId, booleanChoices);
  return { value: answer.value === "true", confidence: answer.confidence };
}

function endpointFetch(
  endpoint: string,
  transport: JevTransport = fetch,
): JevTransport {
  const base = new URL(endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
  return async (input, init) => {
    const target = new URL(input);
    const path = `${target.pathname.replace(/^\/+/, "")}${target.search}`;
    return transport(new URL(path, base).toString(), init);
  };
}

/**
 * Runtime adapter for the published pi-typesafe library API.
 *
 * It only constructs bounded requests and normalizes transport/results. Domain
 * policy and Workflow State routing remain in the orchestrator/core layers.
 */
export class JevIntegration implements JevDecisionClient {
  private readonly injectedClient?: JevClient;
  private readonly createClient: () => JevClient;
  private readonly endpoint?: string;
  private readonly transport?: JevTransport;
  private readonly timeoutMs: number;
  private readonly destination: string;
  private readonly maxTransportRetries: number;
  private resolvedClient?: JevClient;

  constructor(options: JevIntegrationOptions = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS;
    const maxTransportRetries = options.maxTransportRetries ?? 0;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Jev timeoutMs must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maxTransportRetries) || maxTransportRetries < 0) {
      throw new Error(
        "Jev maxTransportRetries must be a non-negative safe integer",
      );
    }
    try {
      this.destination = jevDestination(options.endpoint);
    } catch {
      throw new RuntimePortError("policy", "Unsafe Jev destination");
    }
    this.injectedClient = options.client;
    this.endpoint = options.endpoint;
    this.transport =
      this.endpoint === undefined
        ? options.transport
        : endpointFetch(this.endpoint, options.transport);
    this.timeoutMs = timeoutMs;
    this.maxTransportRetries = maxTransportRetries;
    this.createClient =
      options.createClient ??
      (() =>
        createTypeSafe({
          timeoutMs,
          ...(this.transport === undefined ? {} : { fetch: this.transport }),
        }));
  }

  async routeExecution(
    input: ExecutionRoutingInput,
    authorization?: JevCallAuthorization,
  ): Promise<ExecutionRoutingRawDecision> {
    const answers = await this.evaluate(
      routeRequest(input),
      "routing",
      authorization,
    );
    const modelTier = choiceAnswer(answers, "modelTier", modelTiers);
    const reasoningTier = choiceAnswer(
      answers,
      "reasoningTier",
      reasoningTiers,
    );
    return {
      modelTier: { value: modelTier.value, confidence: modelTier.confidence },
      reasoningTier: {
        value: reasoningTier.value,
        confidence: reasoningTier.confidence,
      },
    };
  }

  async evaluateFindings(
    input: FindingEvaluationInput,
    authorization?: JevCallAuthorization,
  ): Promise<FindingEvaluationRawDecision[]> {
    const decisions: FindingEvaluationRawDecision[] = [];
    for (const finding of input.findings) {
      // Each finding consumes its own durable authorized request in input order.
      // oxlint-disable-next-line eslint/no-await-in-loop
      const answers = await this.evaluate(
        findingRequest(input, finding),
        "finding",
        authorization,
        finding.id,
      );
      decisions.push({
        findingId: finding.id,
        evidenceSupported: booleanDecision(answers, "evidenceSupported"),
        conflictsWithApprovedPlan: booleanDecision(
          answers,
          "conflictsWithApprovedPlan",
        ),
        conflictsWithArchitecture: booleanDecision(
          answers,
          "conflictsWithArchitecture",
        ),
        inScope: booleanDecision(answers, "inScope"),
        requiresHumanDecision: booleanDecision(
          answers,
          "requiresHumanDecision",
        ),
      });
    }
    return decisions;
  }

  async decideRound(
    input: RoundDecisionInput,
    authorization?: JevCallAuthorization,
  ): Promise<RoundDecisionRawDecision> {
    const answers = await this.evaluate(
      roundRequest(input),
      "round",
      authorization,
    );
    const decision = choiceAnswer(answers, "decision", roundActions);
    const escalationReason = choiceAnswer(
      answers,
      "escalationReason",
      escalationReasons,
    );
    if (decision.value !== "ESCALATE") {
      return {
        decision: decision.value,
        confidence: decision.confidence,
      };
    }
    return {
      decision: "ESCALATE",
      confidence: decision.confidence,
      escalationReason: escalationReason.value,
      escalationReasonConfidence: escalationReason.confidence,
    };
  }

  private getClient(): JevClient {
    if (this.resolvedClient) return this.resolvedClient;
    if (this.injectedClient) {
      this.resolvedClient = this.injectedClient;
      return this.resolvedClient;
    }
    try {
      this.resolvedClient = this.createClient();
      return this.resolvedClient;
    } catch (error) {
      throw normalizeFailure(
        isRecord(error) && typeof error.code === "string"
          ? error.code
          : undefined,
        asErrorMessage(error),
      );
    }
  }

  private async evaluate(
    requestValue: JevRequest,
    family: JevRequestFamily,
    authorization?: JevCallAuthorization,
    findingId?: string,
  ): Promise<Record<string, unknown>> {
    if (!authorization)
      throw new RuntimePortError(
        "policy",
        "Product Runtime authorization is required before Jev dispatch",
      );
    for (let attempt = 0; attempt <= this.maxTransportRetries; attempt += 1) {
      // Persist authorization for this attempt before the outbound request.
      // oxlint-disable-next-line eslint/no-await-in-loop
      await authorization.authorizeAttempt({
        family,
        destination: this.destination,
        retryIndex: attempt,
        ...(findingId ? { findingId } : {}),
      });
      // The retry result determines whether a later attempt may be dispatched.
      // oxlint-disable-next-line eslint/no-await-in-loop
      const result = await ask(this.getClient(), requestValue, {
        timeoutMs: this.timeoutMs,
      });
      if (result.ok) {
        // Record this attempt's usage before accepting its decision.
        // oxlint-disable-next-line eslint/no-await-in-loop
        await authorization.recordUsage({
          inputTokens: result.usage.input_tokens,
          outputTokens: result.usage.output_tokens,
        });
        return normalizeAnswers(result.answers, requestValue.questions);
      }
      if (isRetriable(result.errorCode) && attempt < this.maxTransportRetries) {
        continue;
      }
      throw normalizeFailure(result.errorCode, result.error);
    }
    throw new RuntimePortError(
      "infrastructure",
      "Jev integration exhausted transport retries",
    );
  }
}
