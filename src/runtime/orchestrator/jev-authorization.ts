import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  isArtifactRef,
  type ArtifactRef,
} from "../../core/artifacts/references.ts";
import {
  isJevRuntimePolicy,
  jevDestination,
  classifierIdentity,
  jevEvidenceCategories,
  isClassifierIdentity,
  type ClassifierIdentity,
  type JevConfiguration,
  type JevEvidenceCategory,
} from "../../core/configuration.ts";
import {
  hasOnlyKeys,
  isNonEmptyString,
  isNonNegativeInteger,
  isOneOf,
  isRecord,
  isConfidence,
} from "../../core/schema.ts";
import { sameArtifactRef } from "../../core/workflow/invariants.ts";
import type { WorkflowState } from "../../core/workflow/state.ts";
import {
  calculateSha256,
  createArtifactRef,
} from "../persistence/artifact-store.ts";
import { artifactRelativePath } from "../persistence/artifact-paths.ts";
import { RuntimePortError } from "../ports/errors.ts";
import type {
  JevAttempt,
  JevCallAuthorization,
  JevRequestFamily,
  ClassifierChoiceEvidence,
} from "../ports/jev-decision-client.ts";
import type { WorkflowArtifactWriter } from "./planning-orchestrator.ts";
import type { WorkflowStateWriter } from "./advance-workflow.ts";

interface JevAuthorizationRecord {
  schemaVersion: 1;
  recordType: "authorization";
  workflowId: string;
  projectRoot: string;
  grantId: string;
  consentId: string;
  policyVersion: string;
  destination: string;
  classifier: ClassifierIdentity;
  evidenceCategories: readonly JevEvidenceCategory[];
  maxRequests: number;
}
function assertAuthorization(
  value: unknown,
): asserts value is JevAuthorizationRecord {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "recordType",
      "workflowId",
      "projectRoot",
      "grantId",
      "consentId",
      "policyVersion",
      "destination",
      "classifier",
      "evidenceCategories",
      "maxRequests",
    ]) ||
    value.schemaVersion !== 1 ||
    value.recordType !== "authorization" ||
    ![
      value.workflowId,
      value.projectRoot,
      value.grantId,
      value.consentId,
      value.policyVersion,
      value.destination,
    ].every(isNonEmptyString) ||
    !isClassifierIdentity(value.classifier) ||
    value.destination !==
      `${value.classifier.provider}/${value.classifier.model}` ||
    !isNonNegativeInteger(value.maxRequests) ||
    !Number.isSafeInteger(value.maxRequests) ||
    !Array.isArray(value.evidenceCategories) ||
    !value.evidenceCategories.every((category) =>
      isOneOf(jevEvidenceCategories, category),
    )
  )
    throw Error("Invalid Jev workflow authorization");
}
function parseAuthorization(value: unknown): JevAuthorizationRecord {
  assertAuthorization(value);
  return value;
}

interface JevRequestRecord {
  schemaVersion: 1;
  recordType: "reservation" | "usage";
  workflowId: string;
  projectRoot: string;
  ordinal: number;
  consentId: string;
  grantId: string;
  authorizationRef: ArtifactRef<"jev-request">;
  policyVersion: string;
  destination: string;
  classifier: ClassifierIdentity;
  requestDigest: string;
  configurationDigest: string;
  decisionSchemaVersion: 1;
  answers?: Record<string, ClassifierChoiceEvidence>;
  evidenceCategories: readonly JevEvidenceCategory[];
  maxRequests: number;
  family: JevRequestFamily;
  retryIndex: number;
  findingId?: string;
  previousRef?: ArtifactRef<"jev-request">;
  observedAt: string;
  requestRef?: ArtifactRef<"jev-request">;
  usage?: { inputTokens?: number; outputTokens?: number };
}
function assertRecord(value: unknown): asserts value is JevRequestRecord {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "recordType",
      "workflowId",
      "projectRoot",
      "ordinal",
      "consentId",
      "grantId",
      "authorizationRef",
      "policyVersion",
      "destination",
      "classifier",
      "requestDigest",
      "configurationDigest",
      "decisionSchemaVersion",
      "answers",
      "evidenceCategories",
      "maxRequests",
      "family",
      "retryIndex",
      "findingId",
      "previousRef",
      "observedAt",
      "requestRef",
      "usage",
    ]) ||
    value.schemaVersion !== 1 ||
    !isOneOf(["reservation", "usage"] as const, value.recordType) ||
    ![
      value.workflowId,
      value.projectRoot,
      value.consentId,
      value.grantId,
      value.policyVersion,
      value.destination,
      value.observedAt,
    ].every(isNonEmptyString) ||
    !isArtifactRef(value.authorizationRef) ||
    value.authorizationRef.kind !== "jev-request" ||
    !isNonNegativeInteger(value.ordinal) ||
    value.ordinal < 1 ||
    !isNonNegativeInteger(value.maxRequests) ||
    !Number.isSafeInteger(value.maxRequests) ||
    !isNonNegativeInteger(value.retryIndex) ||
    !isOneOf(
      [
        "stage",
        "clarification",
        "method",
        "routing",
        "finding",
        "round",
      ] as const,
      value.family,
    ) ||
    !isClassifierIdentity(value.classifier) ||
    value.destination !==
      `${value.classifier.provider}/${value.classifier.model}` ||
    value.decisionSchemaVersion !== 1 ||
    typeof value.requestDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.requestDigest) ||
    typeof value.configurationDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.configurationDigest) ||
    !Array.isArray(value.evidenceCategories) ||
    !value.evidenceCategories.every((item) =>
      isOneOf(jevEvidenceCategories, item),
    ) ||
    (value.findingId !== undefined && !isNonEmptyString(value.findingId))
  )
    throw Error("Invalid Jev request evidence");
  if (
    typeof value.destination !== "string" ||
    jevDestination(value.destination) !== value.destination
  )
    throw Error("Invalid Jev destination evidence");
  for (const key of ["previousRef", "requestRef"] as const)
    if (
      value[key] !== undefined &&
      (!isArtifactRef(value[key]) || value[key].kind !== "jev-request")
    )
      throw Error("Invalid Jev request reference");
  if (
    value.recordType === "usage" &&
    (!value.requestRef ||
      !isRecord(value.usage) ||
      !hasOnlyKeys(value.usage, ["inputTokens", "outputTokens"]) ||
      (value.usage.inputTokens !== undefined &&
        !isNonNegativeInteger(value.usage.inputTokens)) ||
      (value.usage.outputTokens !== undefined &&
        !isNonNegativeInteger(value.usage.outputTokens)) ||
      (value.answers !== undefined &&
        (!isRecord(value.answers) ||
          !Object.values(value.answers).every(
            (answer) =>
              isRecord(answer) &&
              hasOnlyKeys(answer, [
                "type",
                "choice",
                "confidence",
                "probabilities",
              ]) &&
              answer.type === "choice" &&
              isNonEmptyString(answer.choice) &&
              isConfidence(answer.confidence) &&
              isRecord(answer.probabilities) &&
              Object.hasOwn(answer.probabilities, answer.choice) &&
              Object.values(answer.probabilities).every(isConfidence),
          ))))
  )
    throw Error("Invalid Jev usage evidence");
}

function parseRecord(value: unknown): JevRequestRecord {
  assertRecord(value);
  return value;
}

/** One runner call; all outbound attempts share the durable Workflow accounting. */
export class JevAuthorization {
  state: WorkflowState;
  readonly context: JevCallAuthorization;
  private latestReservation?: JevRequestRecord;
  constructor(
    state: WorkflowState,
    private readonly configuration: JevConfiguration | undefined,
    private readonly artifactStore: WorkflowArtifactWriter,
    private readonly stateStore: WorkflowStateWriter,
    private readonly family: JevRequestFamily,
    private readonly categories: readonly JevEvidenceCategory[],
  ) {
    this.state = state;
    let destination: string;
    try {
      const identity = classifierIdentity(configuration);
      destination = `${identity.provider}/${identity.model}`;
    } catch {
      destination = "invalid";
    }
    this.context = {
      destination,
      authorizeAttempt: (attempt) => this.reserve(attempt),
      recordUsage: (usage) => this.recordUsage(usage),
    };
  }
  private binding?: JevAuthorizationRecord;
  /** Reuse validates consent too, but neither spends budget nor creates authority. */
  async assertAllowed(request = true): Promise<void> {
    const policy = this.configuration?.runtimePolicy;
    const base = this.state;
    if (
      !isJevRuntimePolicy(policy) ||
      !policy.grant.active ||
      !base.projectRoot ||
      !isAbsolute(base.projectRoot) ||
      !isAbsolute(policy.grant.projectRoot) ||
      policy.grant.destination !== this.context.destination ||
      !base.jevUsage ||
      !isNonNegativeInteger(base.jevUsage.attemptsReserved) ||
      !Number.isSafeInteger(base.jevUsage.attemptsReserved) ||
      (base.jevUsage.attemptsReserved === 0
        ? base.jevUsage.latestRequestRef !== undefined
        : base.jevUsage.latestRequestRef === undefined) ||
      (request && base.jevUsage.attemptsReserved >= policy.maxRequests) ||
      this.categories.some(
        (category) => !policy.grant.evidenceCategories.includes(category),
      )
    )
      throw new RuntimePortError(
        "policy",
        "Product Runtime Jev consent or budget does not permit this request",
      );
    try {
      const classifier = classifierIdentity(this.configuration);
      if (
        `${classifier.provider}/${classifier.model}` !==
        this.context.destination
      )
        throw Error("Configured classifier changed during authorization");
      const projectRoot = await realpath(base.projectRoot);
      if ((await realpath(policy.grant.projectRoot)) !== projectRoot)
        throw Error("Canonical project scope mismatch");
      if (!this.artifactStore.readText)
        throw Error("Authorization reader unavailable");
      let ref = base.jevUsage.authorizationRef;
      if (!ref) {
        if (
          !request ||
          base.jevUsage.attemptsReserved !== 0 ||
          base.jevUsage.latestUsageRef ||
          !this.artifactStore.writeJson
        )
          throw Error(
            "Missing workflow authorization; accounting cannot be reset",
          );
        const binding: JevAuthorizationRecord = {
          schemaVersion: 1,
          recordType: "authorization",
          workflowId: base.workflowId,
          projectRoot,
          grantId: policy.grant.id,
          consentId: `${policy.grant.id}:${base.workflowId}`,
          policyVersion: policy.grant.policyVersion,
          destination: this.context.destination,
          classifier,
          evidenceCategories: [...policy.grant.evidenceCategories],
          maxRequests: policy.maxRequests,
        };
        const file = "jev-authorization.json";
        const expected = createArtifactRef(
          "jev-request",
          artifactRelativePath("jev-request", file),
          JSON.stringify(binding),
        );
        ref = await this.artifactStore.writeJson(
          "jev-request",
          file,
          binding,
          parseAuthorization,
        );
        if (!sameArtifactRef(ref, expected))
          throw Error("Authorization Artifact identity mismatch");
        this.state = await this.stateStore.saveState(
          { ...base, jevUsage: { ...base.jevUsage, authorizationRef: ref } },
          base.stateRevision,
        );
      }
      const text = await this.artifactStore.readText(ref);
      if (calculateSha256(text) !== ref.sha256)
        throw Error("Authorization hash mismatch");
      const binding = parseAuthorization(JSON.parse(text));
      if (
        binding.workflowId !== base.workflowId ||
        binding.projectRoot !== projectRoot ||
        binding.grantId !== policy.grant.id ||
        binding.policyVersion !== policy.grant.policyVersion ||
        binding.destination !== this.context.destination ||
        (request && base.jevUsage.attemptsReserved >= binding.maxRequests) ||
        this.categories.some(
          (category) => !binding.evidenceCategories.includes(category),
        )
      )
        throw Error("Workflow consent scope or budget mismatch");
      const usage = base.jevUsage;
      if (usage.attemptsReserved > 0) {
        const previousText = await this.artifactStore.readText(
          usage.latestRequestRef!,
        );
        if (calculateSha256(previousText) !== usage.latestRequestRef!.sha256)
          throw Error("Unknown prior usage");
        const previous = parseRecord(JSON.parse(previousText));
        if (
          previous.recordType !== "reservation" ||
          previous.ordinal !== usage.attemptsReserved ||
          previous.workflowId !== base.workflowId ||
          previous.projectRoot !== projectRoot ||
          previous.destination !== this.context.destination ||
          previous.consentId !== binding.consentId ||
          previous.grantId !== binding.grantId ||
          !sameArtifactRef(previous.authorizationRef, ref) ||
          previous.policyVersion !== binding.policyVersion ||
          previous.maxRequests !== binding.maxRequests ||
          previous.evidenceCategories.some(
            (category) => !binding.evidenceCategories.includes(category),
          )
        )
          throw Error("Inconsistent prior usage");
      }
      this.binding = binding;
    } catch (cause) {
      throw new RuntimePortError(
        "policy",
        "Unable to validate durable Jev consent or budget; dispatch denied",
        { cause },
      );
    }
  }
  private async persist(
    record: JevRequestRecord,
    suffix: string,
  ): Promise<ArtifactRef<"jev-request">> {
    if (!this.artifactStore.writeJson)
      throw new RuntimePortError(
        "policy",
        "Durable Jev accounting requires JSON Artifact persistence",
      );
    const file = `jev-request-${record.ordinal}-${suffix}.json`;
    const expected = createArtifactRef(
      "jev-request",
      artifactRelativePath("jev-request", file),
      JSON.stringify(record),
    );
    const ref = await this.artifactStore.writeJson(
      "jev-request",
      file,
      record,
      parseRecord,
    );
    if (!sameArtifactRef(ref, expected))
      throw new RuntimePortError(
        "policy",
        "Jev accounting Artifact identity mismatch",
      );
    return ref;
  }
  private async reserve(attempt: JevAttempt): Promise<void> {
    await this.assertAllowed();
    if (
      attempt.family !== this.family ||
      attempt.destination !== this.context.destination ||
      !isNonNegativeInteger(attempt.retryIndex) ||
      attempt.decisionSchemaVersion !== 1 ||
      !/^[0-9a-f]{64}$/u.test(attempt.requestDigest) ||
      !/^[0-9a-f]{64}$/u.test(attempt.configurationDigest)
    )
      throw new RuntimePortError(
        "policy",
        "Jev request does not match authorized scope",
      );
    const base = this.state;
    const binding = this.binding!;
    const usage = base.jevUsage!;
    try {
      const record: JevRequestRecord = {
        schemaVersion: 1,
        recordType: "reservation",
        workflowId: base.workflowId,
        projectRoot: binding.projectRoot,
        ordinal: usage.attemptsReserved + 1,
        consentId: binding.consentId,
        grantId: binding.grantId,
        authorizationRef: usage.authorizationRef!,
        policyVersion: binding.policyVersion,
        destination: this.context.destination,
        classifier: classifierIdentity(this.configuration),
        requestDigest: attempt.requestDigest,
        configurationDigest: attempt.configurationDigest,
        decisionSchemaVersion: attempt.decisionSchemaVersion,
        evidenceCategories: [...this.categories],
        maxRequests: binding.maxRequests,
        family: this.family,
        retryIndex: attempt.retryIndex,
        ...(attempt.findingId ? { findingId: attempt.findingId } : {}),
        ...(usage.latestRequestRef
          ? { previousRef: usage.latestRequestRef }
          : {}),
        observedAt: new Date().toISOString(),
      };
      const ref = await this.persist(record, "reserved");
      this.state = await this.stateStore.saveState(
        {
          ...base,
          jevUsage: {
            ...usage,
            attemptsReserved: record.ordinal,
            latestRequestRef: ref,
          },
        },
        base.stateRevision,
      );
      this.latestReservation = record;
    } catch (cause) {
      throw new RuntimePortError(
        "policy",
        "Unable to durably reserve Jev budget; dispatch denied",
        { cause },
      );
    }
  }
  private async recordUsage(result: {
    inputTokens?: number;
    outputTokens?: number;
    answers?: Record<string, ClassifierChoiceEvidence>;
  }): Promise<void> {
    const { answers, ...usage } = result;
    const base = this.state;
    if (!this.latestReservation || !base.jevUsage?.latestRequestRef)
      throw new RuntimePortError(
        "policy",
        "Jev usage has no durable request reservation",
      );
    try {
      const ref = await this.persist(
        {
          ...this.latestReservation,
          recordType: "usage",
          observedAt: new Date().toISOString(),
          requestRef: base.jevUsage.latestRequestRef,
          usage,
          ...(answers ? { answers } : {}),
        },
        "usage",
      );
      this.state = await this.stateStore.saveState(
        { ...base, jevUsage: { ...base.jevUsage, latestUsageRef: ref } },
        base.stateRevision,
      );
    } catch (cause) {
      throw new RuntimePortError(
        "policy",
        "Unable to durably record Jev usage",
        { cause },
      );
    }
  }
}
export function jevBlockedReason(
  error: unknown,
): "operator-attention-required" | "integration-unavailable" {
  return error instanceof RuntimePortError && error.kind === "policy"
    ? "operator-attention-required"
    : "integration-unavailable";
}
