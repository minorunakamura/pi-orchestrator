import type {
  ClassifierContext,
  ClassifierChoiceQuestion,
  JsonValue,
  ClassifierResult,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { calculateSha256 } from "../persistence/artifact-store.ts";
import {
  classifierIdentity,
  type JevConfiguration,
  type ClassifierIdentity,
} from "../../core/configuration.ts";
import type {
  JevCallAuthorization,
  JevRequestFamily,
} from "../ports/jev-decision-client.ts";
import { isConfidence, isRecord, hasOnlyKeys } from "../../core/schema.ts";
import type { ReviewFinding } from "../../core/coding/finding.ts";
import type {
  ExecutionRoutingInput,
  ExecutionRoutingRawDecision,
  FindingEvaluationInput,
  FindingEvaluationRawDecision,
  DecisionClassifierPort,
  ConditionalStageRoutingInput,
  PlanningClassifierInput,
  ClassifierChoiceEvidence,
  RoundDecisionInput,
  RoundDecisionRawDecision,
} from "../ports/jev-decision-client.ts";
import { RuntimePortError } from "../ports/errors.ts";

export const DEFAULT_JEV_TIMEOUT_MS = 15_000;

export type PiClassifierRuntime = Pick<
  ModelRegistry,
  "findOfType" | "classify"
>;
export interface JevIntegrationOptions extends JevConfiguration {
  modelRegistry?: PiClassifierRuntime;
}
type Questions = Record<string, ClassifierChoiceQuestion>;
type JevRequest = ClassifierContext;
function choice(
  instructions: string,
  criteria: Record<string, string>,
): ClassifierChoiceQuestion {
  return { type: "choice", instructions, criteria };
}

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

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, toJsonValue(entry)]),
    );
  }
  throw new RuntimePortError(
    "domain",
    "Jev request state must be JSON-compatible",
  );
}

function request(state: unknown, questions: Questions): JevRequest {
  const jsonState = toJsonValue(state);
  if (!isRecord(jsonState)) {
    throw new RuntimePortError("domain", "Jev request state must be an object");
  }
  return { state: jsonState, questions };
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
  questions: JevRequest["questions"],
): Record<string, ClassifierChoiceEvidence> {
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
  for (const [id, question] of Object.entries(questions)) {
    if (question.type !== "choice")
      throw new RuntimePortError(
        "domain",
        "Only Choice questions are supported",
      );
    choiceAnswer(value, id, Object.keys(question.criteria));
  }
  // Every answer was validated against its exact Choice schema above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as Record<string, ClassifierChoiceEvidence>;
}

function choiceAnswer<const T extends readonly string[]>(
  answers: Record<string, unknown>,
  questionId: string,
  allowed: T,
): { value: T[number]; confidence: number } {
  const answer = answers[questionId];
  if (
    !isRecord(answer) ||
    answer.type !== "choice" ||
    !hasOnlyKeys(answer, ["type", "choice", "confidence", "probabilities"])
  ) {
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

/** Pi owns transport/auth; the runtime owns authorization, evidence and policy. */
export class PiClassifierDecisionClient implements DecisionClassifierPort {
  private readonly timeoutMs: number;
  private readonly destination: string;
  private readonly identity: ClassifierIdentity;
  private readonly maxTransportRetries: number;
  private readonly configurationDigest: string;

  constructor(private readonly options: JevIntegrationOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS;
    this.maxTransportRetries = options.maxTransportRetries ?? 0;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0)
      throw new Error("Jev timeoutMs must be a positive safe integer");
    if (
      !Number.isSafeInteger(this.maxTransportRetries) ||
      this.maxTransportRetries < 0
    )
      throw new Error(
        "Jev maxTransportRetries must be a non-negative safe integer",
      );
    this.identity = classifierIdentity(options);
    this.destination = `${this.identity.provider}/${this.identity.model}`;
    this.configurationDigest = calculateSha256(
      JSON.stringify({
        classifier: this.identity,
        timeoutMs: this.timeoutMs,
        maxTransportRetries: this.maxTransportRetries,
      }),
    );
  }

  async routeStage(
    input: ConditionalStageRoutingInput,
    authorization?: JevCallAuthorization,
  ) {
    if (input.policy !== "conditional")
      throw new RuntimePortError(
        "policy",
        "Required/skip stage policy must remain deterministic",
      );
    return this.routePlanning(
      input,
      "stage",
      ["RUN", "SKIP", "ESCALATE"] as const,
      "Should the named conditional stage run given the supplied accumulated evidence? RUN if needed, SKIP only with sufficient evidence, ESCALATE if unresolved.",
      authorization,
    );
  }

  async routeClarification(
    input: PlanningClassifierInput,
    authorization?: JevCallAuthorization,
  ) {
    return this.routePlanning(
      input,
      "clarification",
      ["SKIP", "GRILL_ME", "GRILL_WITH_DOCS", "ESCALATE"] as const,
      "Which clarification mode is needed? SKIP only with sufficient evidence; GRILL_ME for Human choices; GRILL_WITH_DOCS for Human choices needing domain documents; ESCALATE if unresolved. Do not generate questions or grant write authority.",
      authorization,
    );
  }

  async routeDevelopmentMethod(
    input: PlanningClassifierInput,
    authorization?: JevCallAuthorization,
  ) {
    return this.routePlanning(
      input,
      "method",
      ["STANDARD", "TDD", "ESCALATE"] as const,
      "Which implementation method fits the eligible behavior change? STANDARD or TDD, ESCALATE for unresolved Human preference. Explicit Human TDD and inapplicable work are resolved deterministically before this call.",
      authorization,
    );
  }

  private async routePlanning<const T extends readonly string[]>(
    input: PlanningClassifierInput,
    family: JevRequestFamily,
    allowed: T,
    instructions: string,
    authorization?: JevCallAuthorization,
  ) {
    const answers = await this.evaluate(
      request(input, {
        decision: choice(
          instructions,
          Object.fromEntries(allowed.map((value) => [value, value])),
        ),
      }),
      family,
      authorization,
    );
    return choiceAnswer(answers, "decision", allowed);
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

  private async classify(requestValue: JevRequest): Promise<ClassifierResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const registry = this.options.modelRegistry;
      const model = registry?.findOfType(
        "classifier",
        this.identity.provider,
        this.identity.model,
      );
      if (
        !registry ||
        !model ||
        model.type !== "classifier" ||
        model.provider !== this.identity.provider ||
        model.id !== this.identity.model
      )
        throw new RuntimePortError(
          "infrastructure",
          "Configured Jev classifier is unavailable",
        );
      const result = await Promise.race([
        registry.classify(model, requestValue, {
          signal: controller.signal,
          maxRetries: 0,
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(
              new RuntimePortError(
                "timeout",
                "Jev classification deadline exceeded",
              ),
            );
          }, this.timeoutMs);
        }),
      ]);
      if (
        result.provider !== model.provider ||
        result.model !== model.id ||
        result.api !== model.api
      )
        throw new RuntimePortError(
          "infrastructure",
          "Classifier response identity mismatch",
        );
      if (result.stopReason !== "stop")
        throw new RuntimePortError(
          result.stopReason === "aborted" ? "timeout" : "infrastructure",
          "Jev classification did not complete",
        );
      return result;
    } catch (error) {
      if (error instanceof RuntimePortError) throw error;
      // Do not expose provider messages or credentials in durable diagnostics.
      throw new RuntimePortError(
        "infrastructure",
        "Pi classifier request failed",
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async evaluate(
    requestValue: JevRequest,
    family: JevRequestFamily,
    authorization?: JevCallAuthorization,
    findingId?: string,
  ): Promise<Record<string, unknown>> {
    if (!authorization || authorization.destination !== this.destination)
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
        requestDigest: calculateSha256(JSON.stringify(requestValue)),
        configurationDigest: this.configurationDigest,
        decisionSchemaVersion: 1,
      });
      let result: ClassifierResult;
      try {
        // Each explicit retry has its own durable reservation; Pi never retries.
        // oxlint-disable-next-line eslint/no-await-in-loop
        result = await this.classify(requestValue);
      } catch (error) {
        if (
          error instanceof RuntimePortError &&
          error.kind === "timeout" &&
          attempt < this.maxTransportRetries
        )
          continue;
        throw error;
      }
      const answers = normalizeAnswers(result.answers, requestValue.questions);
      // Persist full probabilities/confidence before accepting the decision.
      // oxlint-disable-next-line eslint/no-await-in-loop
      await authorization.recordUsage({
        ...(result.usage
          ? {
              inputTokens: result.usage.input,
              outputTokens: result.usage.output,
            }
          : {}),
        answers,
      });
      return answers;
    }
    throw new RuntimePortError(
      "infrastructure",
      "Jev integration exhausted transport retries",
    );
  }
}

// Retain the released product name; this is the same native adapter, not a fallback.
export { PiClassifierDecisionClient as JevIntegration };
