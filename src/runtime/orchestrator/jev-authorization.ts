import {
  isArtifactRef,
  type ArtifactRef,
} from "../../core/artifacts/references.ts";
import {
  isJevRuntimePolicy,
  jevDestination,
  type JevConfiguration,
  type JevEvidenceCategory,
} from "../../core/configuration.ts";
import {
  hasOnlyKeys,
  isNonEmptyString,
  isNonNegativeInteger,
  isOneOf,
  isRecord,
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
} from "../ports/jev-decision-client.ts";
import type { WorkflowArtifactWriter } from "./planning-orchestrator.ts";
import type { WorkflowStateWriter } from "./advance-workflow.ts";

interface JevRequestRecord {
  schemaVersion: 1;
  recordType: "reservation" | "usage";
  workflowId: string;
  projectRoot: string;
  ordinal: number;
  consentId: string;
  policyVersion: string;
  destination: string;
  evidenceCategories: readonly JevEvidenceCategory[];
  maxRequests: number;
  family: JevRequestFamily;
  retryIndex: number;
  findingId?: string;
  previousRef?: ArtifactRef<"jev-request">;
  observedAt: string;
  requestRef?: ArtifactRef<"jev-request">;
  usage?: { inputTokens: number; outputTokens: number };
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
      "policyVersion",
      "destination",
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
      value.policyVersion,
      value.destination,
      value.observedAt,
    ].every(isNonEmptyString) ||
    !isNonNegativeInteger(value.ordinal) ||
    value.ordinal < 1 ||
    !isNonNegativeInteger(value.maxRequests) ||
    !isNonNegativeInteger(value.retryIndex) ||
    !isOneOf(["routing", "finding", "round"] as const, value.family) ||
    !Array.isArray(value.evidenceCategories) ||
    !value.evidenceCategories.every((item) =>
      isOneOf(
        [
          "plan",
          "context",
          "implementation",
          "review",
          "validation",
          "history",
        ] as const,
        item,
      ),
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
      !isNonNegativeInteger(value.usage.inputTokens) ||
      !isNonNegativeInteger(value.usage.outputTokens))
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
      destination = jevDestination(configuration?.endpoint);
    } catch {
      destination = "invalid";
    }
    this.context = {
      destination,
      authorizeAttempt: (attempt) => this.reserve(attempt),
      recordUsage: (usage) => this.recordUsage(usage),
    };
  }
  assertAllowed(): void {
    const policy = this.configuration?.runtimePolicy;
    if (
      !isJevRuntimePolicy(policy) ||
      !policy.consent.active ||
      !this.state.projectRoot ||
      policy.consent.projectRoot !== this.state.projectRoot ||
      policy.consent.workflowId !== this.state.workflowId ||
      !this.state.jevUsage ||
      this.state.jevUsage.attemptsReserved >= policy.maxRequests ||
      this.categories.some(
        (category) => !policy.consent.evidenceCategories.includes(category),
      )
    )
      throw new RuntimePortError(
        "policy",
        "Product Runtime Jev consent or budget does not permit this request",
      );
    try {
      if (
        jevDestination(policy.consent.destination) !== this.context.destination
      )
        throw Error("mismatch");
    } catch {
      throw new RuntimePortError(
        "policy",
        "Product Runtime Jev destination consent mismatch",
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
    this.assertAllowed();
    if (
      attempt.family !== this.family ||
      attempt.destination !== this.context.destination ||
      !isNonNegativeInteger(attempt.retryIndex)
    )
      throw new RuntimePortError(
        "policy",
        "Jev request does not match authorized scope",
      );
    const base = this.state;
    const policy = this.configuration!.runtimePolicy!;
    const usage = base.jevUsage!;
    try {
      if (usage.attemptsReserved > 0) {
        if (!usage.latestRequestRef || !this.artifactStore.readText)
          throw Error("Unknown prior usage");
        const text = await this.artifactStore.readText(usage.latestRequestRef);
        if (calculateSha256(text) !== usage.latestRequestRef.sha256)
          throw Error("Unknown prior usage");
        const previous = parseRecord(JSON.parse(text));
        if (
          previous.recordType !== "reservation" ||
          previous.ordinal !== usage.attemptsReserved ||
          previous.workflowId !== base.workflowId ||
          previous.projectRoot !== base.projectRoot
        )
          throw Error("Inconsistent prior usage");
      }
      const record: JevRequestRecord = {
        schemaVersion: 1,
        recordType: "reservation",
        workflowId: base.workflowId,
        projectRoot: base.projectRoot!,
        ordinal: usage.attemptsReserved + 1,
        consentId: policy.consent.id,
        policyVersion: policy.consent.policyVersion,
        destination: this.context.destination,
        evidenceCategories: [...this.categories],
        maxRequests: policy.maxRequests,
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
  private async recordUsage(usage: {
    inputTokens: number;
    outputTokens: number;
  }): Promise<void> {
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
