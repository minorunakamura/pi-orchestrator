import { realpath } from "node:fs/promises";
import { isRecord } from "../../core/schema.ts";
import { humanResearchOutcome, selectResearch } from "./research-selection.ts";
import {
  verifyClarificationDocuments,
  clarificationEvidence,
} from "./clarification.ts";
import {
  humanMethodOutcome,
  selectDevelopmentMethod,
} from "./development-method-selection.ts";
import type { HumanQuestionPort } from "../integrations/ask-user-question.ts";
import type { OwnershipBoundary } from "./workflow-ownership.ts";
import { diagnosisEvidence } from "./diagnosis.ts";
import type { SubagentExecutor } from "../ports/subagent-executor.ts";
import type { ArtifactRef } from "../../core/artifacts/references.ts";
import {
  classifierIdentity,
  type JevEvidenceCategory,
  type OrchestratorConfiguration,
} from "../../core/configuration.ts";
import {
  clarificationOutcome,
  planningRoutingInstructions,
  stageOutcome,
  parsePlanningDecisionArtifact,
  isConditionalStageDecision,
  isClarificationModeDecision,
  isDevelopmentMethodDecision,
  developmentMethodOutcome,
  type DevelopmentMethod,
  type PlanningDecisionStage,
  type ConditionalStage,
  type StageOutcome,
  type ClarificationMode,
  type PlanningDecisionArtifact,
  type PlanningDecisionBinding,
} from "../../core/decisions/planning-routing.ts";
import { getPlaybookStagePolicy } from "../../core/playbooks/policy.ts";
import type { WorkflowState } from "../../core/workflow/state.ts";
import { sameArtifactRef } from "../../core/workflow/invariants.ts";
import {
  ArtifactImmutableError,
  calculateSha256,
  createArtifactRef,
} from "../persistence/artifact-store.ts";
import { artifactRelativePath } from "../persistence/artifact-paths.ts";
import type {
  DecisionClassifierPort,
  JevDecisionClient,
  PlanningClassifierInput,
} from "../ports/jev-decision-client.ts";
import { RuntimePortError } from "../ports/errors.ts";
import { authoritativeText } from "./coding-evidence.ts";
import {
  advanceWorkflow,
  type WorkflowStateWriter,
} from "./advance-workflow.ts";
import type { WorkflowArtifactWriter } from "./planning-orchestrator.ts";
import { JevAuthorization, jevBlockedReason } from "./jev-authorization.ts";

export const PLANNING_EVIDENCE_LIMITS = {
  artifact: 12000,
  total: 48000,
} as const;
export interface PlanningRoutingDependencies {
  artifactStore: WorkflowArtifactWriter;
  stateStore: WorkflowStateWriter;
  loadState?: () => Promise<WorkflowState>;
  humanQuestionPort?: HumanQuestionPort;
  ownership?: OwnershipBoundary;
  signal?: AbortSignal;
  subagentExecutor?: SubagentExecutor;
  configuration?: OrchestratorConfiguration;
  jevDecisionClient?: JevDecisionClient &
    Partial<
      Pick<
        DecisionClassifierPort,
        "routeStage" | "routeClarification" | "routeDevelopmentMethod"
      >
    >;
}
export class PlanningRoutingStoppedError extends Error {
  constructor(readonly state: WorkflowState) {
    super("Planning routing requires operator attention");
    this.name = "PlanningRoutingStoppedError";
  }
}
function attention(message: string): never {
  throw new RuntimePortError("policy", message);
}
export function requirePlanningRouting(state: WorkflowState): void {
  if (!state.planning.stageDecisionRefs || !state.planning.agentAttempts)
    attention(
      "Durable planning policy is required; legacy hints/flags cannot establish authority",
    );
}
function digest(value: unknown): string {
  return calculateSha256(JSON.stringify(value));
}

function planningCategories(
  refs: readonly ArtifactRef[],
): JevEvidenceCategory[] {
  const categories: JevEvidenceCategory[] = ["task", "scout"];
  if (refs.some((item) => item.kind === "domain-document-write"))
    categories.push("design");
  for (const kind of [
    "diagnosis",
    "research",
    "clarification",
    "plan",
  ] as const)
    if (refs.some((item) => item.kind === kind)) categories.push(kind);
  if (
    refs.some((item) =>
      [
        "conditional-stage",
        "clarification-mode",
        "development-method",
        "plan-review",
        "round-decision",
      ].includes(item.kind),
    )
  )
    categories.push("history");
  return categories;
}

/** Only typed local diagnostics are displayed; never arbitrary provider/error text. */
export async function planningInputDiagnostic(
  state: WorkflowState,
  store: Pick<WorkflowArtifactWriter, "readText">,
): Promise<string | undefined> {
  const ref = state.block?.evidenceRef;
  if (state.phase !== "blocked" || ref?.kind !== "reconciliation")
    return undefined;
  try {
    const value: unknown = JSON.parse(await authoritativeText(store, ref));
    if (
      !isRecord(value) ||
      value.schemaVersion !== 1 ||
      value.recordType !== "planning-input-diagnostic" ||
      value.workflowId !== state.workflowId ||
      typeof value.stage !== "string" ||
      ![
        "research",
        "clarification",
        "architecture",
        "development-method",
      ].includes(value.stage)
    )
      return undefined;
    if (value.code === "planning-input-invalid")
      return `${value.stage}: authoritative planning input / clarification chain validation failed; no classifier request was sent`;
    if (value.code === "clarification-history-invalid")
      return "clarification: confirmed history failed validation or exceeded its 128 KiB UTF-8 safety bound; answers remain saved, no further Human UI was opened";
    if (
      value.code !== "planning-input-limit" ||
      ![value.maxArtifactUnits, value.totalUnits].every(
        (size) =>
          typeof size === "number" && Number.isSafeInteger(size) && size >= 0,
      )
    )
      return undefined;
    return `${value.stage}: raw evidence UTF-16 code units max=${String(value.maxArtifactUnits)}/${PLANNING_EVIDENCE_LIMITS.artifact}, total=${String(value.totalUnits)}/${PLANNING_EVIDENCE_LIMITS.total}; completed Clarification and its verified document result are accounted separately; no classifier request was sent`;
  } catch {
    return undefined;
  }
}

/** Sequential durable decisions; Human method selection grants no implementation authority. */
export class PlanningRouting {
  constructor(private readonly deps: PlanningRoutingDependencies) {}

  async stage(
    state: WorkflowState,
    stage: ConditionalStage,
    reuseOnly = false,
  ): Promise<{
    state: WorkflowState;
    outcome: StageOutcome;
    inputRefs: readonly ArtifactRef[];
  }> {
    const result = await this.resolve(state, stage, "stage", reuseOnly);
    if (result.artifact.family !== "stage")
      throw Error("Wrong planning decision family");
    return {
      state: result.state,
      outcome: result.artifact.outcome,
      inputRefs: result.artifact.inputRefs,
    };
  }
  async clarification(
    state: WorkflowState,
    reuseOnly = false,
  ): Promise<{ state: WorkflowState; mode: ClarificationMode }> {
    const result = await this.resolve(
      state,
      "clarification",
      "clarification",
      reuseOnly,
    );
    if (result.artifact.family !== "clarification")
      throw Error("Wrong planning decision family");
    return { state: result.state, mode: result.artifact.outcome };
  }

  async method(
    state: WorkflowState,
    reuseOnly = false,
  ): Promise<{ state: WorkflowState; method: DevelopmentMethod }> {
    const result = await this.resolve(
      state,
      "development-method",
      "method",
      reuseOnly,
    );
    if (
      result.artifact.family !== "method" ||
      result.artifact.outcome === "ESCALATE"
    )
      throw Error("Unresolved Development Method");
    return { state: result.state, method: result.artifact.outcome };
  }

  private async inputs(
    state: WorkflowState,
    stage: PlanningDecisionStage,
    family: "stage" | "clarification" | "method",
  ): Promise<{ refs: ArtifactRef[]; clarificationStage?: StageOutcome }> {
    requirePlanningRouting(state);
    const context = state.planning.context;
    if (!context.scoutRef) attention("Routing requires durable Scout evidence");
    const diagnosis = await diagnosisEvidence(state, this.deps);
    if (
      state.playbook === "hotfix" &&
      diagnosis?.hotfix.scope !== "within-scope"
    )
      attention(
        "Hotfix scope requires Human reclassification/replanning before routing or Planner",
      );
    const refs: ArtifactRef[] = [state.taskRef, context.scoutRef];
    if (context.diagnosisRef) refs.push(context.diagnosisRef);
    if (stage === "research") return { refs };
    const research = await this.stage(state, "research", true);
    refs.push(state.planning.stageDecisionRefs!.research!);
    if (research.outcome === "RUN") {
      if (!context.researchRef)
        attention("Research RUN requires durable Research evidence");
      refs.push(context.researchRef);
    } else if (context.researchRef)
      attention("Research evidence contradicts SKIP");
    if (stage === "clarification" && family === "stage") return { refs };
    const clarification = await this.stage(state, "clarification", true);
    refs.push(state.planning.stageDecisionRefs!.clarification!);
    if (family === "clarification")
      return { refs, clarificationStage: clarification.outcome };
    const mode = await this.clarification(state, true);
    refs.push(state.planning.clarificationModeRef!);
    if (mode.mode !== "SKIP" && !context.clarificationRef)
      attention("Clarification requires a durable confirmed Human answer");
    if (context.clarificationRef) refs.push(context.clarificationRef);
    if (state.planning.domainDocumentWriteRef) {
      await verifyClarificationDocuments(state, this.deps);
      refs.push(state.planning.domainDocumentWriteRef);
    }
    if (family === "method") {
      await this.stage(state, "architecture", true);
      refs.push(state.planning.stageDecisionRefs!.architecture!);
      if (!state.planning.developmentIntent)
        attention(
          "Missing captured Development Intent; legacy state cannot select a method",
        );
    }
    return { refs };
  }

  private async resolve(
    source: WorkflowState,
    stage: PlanningDecisionStage,
    family: "stage" | "clarification" | "method",
    reuseOnly: boolean,
  ): Promise<{ state: WorkflowState; artifact: PlanningDecisionArtifact }> {
    let state = source;
    let authorization: JevAuthorization | undefined;
    let inputDiagnostic:
      | {
          code: "planning-input-invalid" | "planning-input-limit";
          stage: PlanningDecisionStage;
          maxArtifactUnits?: number;
          totalUnits?: number;
        }
      | undefined;
    let artifact: PlanningDecisionArtifact;
    let ref:
      | ArtifactRef<
          "conditional-stage" | "clarification-mode" | "development-method"
        >
      | undefined;
    try {
      const { refs, clarificationStage } = await this.inputs(
        state,
        stage,
        family,
      );
      const policy =
        stage === "development-method"
          ? state.planning.developmentIntent === "TDD"
            ? "required"
            : state.planning.developmentIntent === "BEHAVIOR_FREE"
              ? "skip"
              : "conditional"
          : getPlaybookStagePolicy(state.playbook)[stage];
      const called =
        family === "clarification"
          ? clarificationStage === "RUN"
          : policy === "conditional";
      const configuration = this.deps.configuration;
      if (called && !configuration)
        attention("Planning classifier configuration is required");
      const threshold = configuration?.decision.autoDecisionThreshold ?? 1;
      inputDiagnostic = { code: "planning-input-invalid", stage };
      const evidence = await Promise.all(
        refs.map((inputRef) =>
          clarificationEvidence(inputRef, this.deps.artifactStore),
        ),
      );
      const canonicalRoot = evidence.some((item) => item.projection)
        ? await realpath(state.projectRoot!)
        : undefined;
      for (const item of evidence) {
        if (item.projection) {
          const projected = JSON.parse(item.content);
          if (
            projected.workflowId !== state.workflowId ||
            projected.projectRoot !== canonicalRoot
          )
            attention(
              "Clarification evidence belongs to another workflow/workspace",
            );
        }
      }
      // Completed Clarification and its already-verified document result use
      // their bounded producer contracts, not unrelated raw-envelope ceilings.
      const rawEvidence = evidence.filter(
        (item) =>
          !item.projection &&
          !sameArtifactRef(item.ref, state.planning.domainDocumentWriteRef),
      );
      if (
        rawEvidence.some(
          ({ content }) => content.length > PLANNING_EVIDENCE_LIMITS.artifact,
        ) ||
        rawEvidence.reduce((size, item) => size + item.content.length, 0) >
          PLANNING_EVIDENCE_LIMITS.total
      ) {
        inputDiagnostic = {
          code: "planning-input-limit",
          stage,
          maxArtifactUnits: Math.max(
            ...rawEvidence.map((item) => item.content.length),
          ),
          totalUnits: rawEvidence.reduce(
            (size, item) => size + item.content.length,
            0,
          ),
        };
        attention(
          "Decision-critical planning evidence exceeds the bounded input; do not truncate constraints",
        );
      }
      inputDiagnostic = undefined;
      const input: PlanningClassifierInput = {
        playbook: state.playbook,
        inputRefs: refs,
        evidence: {
          stage,
          policy,
          projectRoot: state.projectRoot,
          artifacts: evidence,
          ...(family === "method"
            ? {
                developmentIntent: state.planning.developmentIntent,
                eligibility: "eligible-or-ambiguous",
              }
            : {}),
          ...(clarificationStage ? { stageOutcome: clarificationStage } : {}),
        },
      };
      const binding: PlanningDecisionBinding = {
        schemaVersion: 1,
        decisionSchemaVersion: 1,
        workflowId: state.workflowId,
        playbook: state.playbook,
        stage,
        policy,
        policyVersion: "planning-routing-1",
        approvedPlanRef: null,
        planVersion: null,
        inputRefs: refs,
        inputDigest: digest(input),
        policyDigest: digest({
          version: "planning-routing-1",
          matrix: getPlaybookStagePolicy(state.playbook),
          limits: PLANNING_EVIDENCE_LIMITS,
          instructions: planningRoutingInstructions,
          ...(evidence.some((item) => item.projection)
            ? { clarificationProjection: "completed-clarification-v1" }
            : {}),
        }),
        configurationDigest: digest(
          called
            ? {
                threshold,
                classifier: classifierIdentity(configuration?.jev),
                timeoutMs: configuration?.jev.timeoutMs ?? 15000,
                maxTransportRetries:
                  configuration?.jev.maxTransportRetries ?? 0,
              }
            : { deterministic: true },
        ),
        classifier: called ? classifierIdentity(configuration?.jev) : null,
      };
      ref =
        family === "method"
          ? state.planning.developmentMethodRef
          : family === "stage" && stage !== "development-method"
            ? state.planning.stageDecisionRefs?.[stage]
            : state.planning.clarificationModeRef;
      if (ref) {
        if (called) {
          authorization = new JevAuthorization(
            state,
            configuration!.jev,
            this.deps.artifactStore,
            this.deps.stateStore,
            family,
            planningCategories(refs),
          );
          await authorization.assertAllowed(false);
        }
        artifact = parsePlanningDecisionArtifact(
          JSON.parse(await authoritativeText(this.deps.artifactStore, ref)),
        );
        if (
          artifact.family !== family ||
          Object.keys(binding).some(
            (key) =>
              digest(Reflect.get(artifact, key)) !==
              digest(Reflect.get(binding, key)),
          )
        )
          attention(
            "Stale planning decision; explicit reconciliation is required",
          );
        let effective =
          artifact.family === "method"
            ? developmentMethodOutcome(policy, artifact.rawDecision, threshold)
            : artifact.family === "stage"
              ? stageOutcome(policy, artifact.rawDecision, threshold)
              : clarificationOutcome(
                  clarificationStage!,
                  artifact.rawDecision,
                  threshold,
                );
        if (artifact.humanSelectionRef) {
          if (
            effective !== "ESCALATE" ||
            !sameArtifactRef(
              artifact.humanSelectionRef,
              state.planning.developmentMethodSelectionRef,
            )
          )
            attention(
              "Human selection cannot override a deterministic or accepted classifier decision",
            );
          effective = await humanMethodOutcome(
            this.deps.artifactStore,
            artifact,
            state,
            this.deps.humanQuestionPort?.rootSessionId,
          );
        }
        if (artifact.humanResearchSelectionRef) {
          if (
            effective !== "ESCALATE" ||
            !sameArtifactRef(
              artifact.humanResearchSelectionRef,
              state.planning.researchSelectionRef,
            ) ||
            !this.deps.humanQuestionPort?.rootSessionId ||
            this.deps.humanQuestionPort.projectRoot !== state.projectRoot
          )
            attention(
              "Human Research selection cannot override an accepted decision or changed root identity",
            );
          effective = await humanResearchOutcome(
            this.deps.artifactStore,
            artifact,
            state,
            threshold,
            this.deps.humanQuestionPort.rootSessionId,
          );
        }
        if (
          effective !== artifact.outcome ||
          (family === "stage" &&
            stage !== "development-method" &&
            state.planning[`${stage}Required`] !== (effective === "RUN"))
        )
          attention("Planning decision contradicts deterministic policy");
        // Verify referenced accounting evidence as well as the decision body.
        await Promise.all(
          [artifact.requestRef, artifact.usageRef]
            .filter((accountingRef) => accountingRef !== undefined)
            .map((accountingRef) =>
              authoritativeText(this.deps.artifactStore, accountingRef),
            ),
        );
      } else {
        if (reuseOnly) attention("Missing preceding planning decision");
        if (called) {
          const client = this.deps.jevDecisionClient;
          if (
            !client ||
            (family === "method"
              ? !client.routeDevelopmentMethod
              : !client.routeStage || !client.routeClarification)
          )
            throw new RuntimePortError(
              "infrastructure",
              "Planning classifier is unavailable",
            );
          const categories = planningCategories(refs);
          authorization = new JevAuthorization(
            state,
            configuration!.jev,
            this.deps.artifactStore,
            this.deps.stateStore,
            family,
            categories,
          );
          await authorization.assertAllowed();
          if (family === "method") {
            const rawDecision = await client.routeDevelopmentMethod!(
              input,
              authorization.context,
            );
            if (!isDevelopmentMethodDecision(rawDecision))
              throw new RuntimePortError(
                "infrastructure",
                "Invalid Development Method decision",
              );
            artifact = {
              ...binding,
              family,
              rawDecision,
              outcome: developmentMethodOutcome(policy, rawDecision, threshold),
            };
          } else if (family === "stage") {
            if (stage === "development-method")
              throw Error("Wrong stage decision family");
            const rawDecision = await client.routeStage!(
              { ...input, stage, policy: "conditional" },
              authorization.context,
            );
            if (!isConditionalStageDecision(rawDecision))
              throw new RuntimePortError(
                "infrastructure",
                "Invalid stage decision",
              );
            artifact = {
              ...binding,
              family,
              rawDecision,
              outcome: stageOutcome(policy, rawDecision, threshold),
            };
          } else {
            const rawDecision = await client.routeClarification!(
              input,
              authorization.context,
            );
            if (!isClarificationModeDecision(rawDecision))
              throw new RuntimePortError(
                "infrastructure",
                "Invalid clarification mode",
              );
            artifact = {
              ...binding,
              family,
              rawDecision,
              outcome: clarificationOutcome(
                clarificationStage!,
                rawDecision,
                threshold,
              ),
            };
          }
          state = authorization.state;
          if (
            state.jevUsage!.attemptsReserved <=
            source.jevUsage!.attemptsReserved
          )
            attention("Classifier result has no new durable reservation");
          artifact.requestRef = state.jevUsage!.latestRequestRef;
          if (
            state.jevUsage!.latestUsageRef &&
            !sameArtifactRef(
              state.jevUsage!.latestUsageRef,
              source.jevUsage!.latestUsageRef,
            )
          )
            artifact.usageRef = state.jevUsage!.latestUsageRef;
        } else {
          artifact =
            family === "method"
              ? {
                  ...binding,
                  family,
                  rawDecision: null,
                  outcome: developmentMethodOutcome(policy, null, threshold),
                }
              : family === "stage"
                ? {
                    ...binding,
                    family,
                    rawDecision: null,
                    outcome: stageOutcome(policy, null, threshold),
                  }
                : { ...binding, family, rawDecision: null, outcome: "SKIP" };
        }
      }
    } catch (error) {
      if (error instanceof PlanningRoutingStoppedError) throw error;
      state = authorization?.state ?? state;
      const diagnosticRef = inputDiagnostic
        ? await this.deps.artifactStore.writeText(
            "reconciliation",
            `planning-input-${stage}-${digest({ ...inputDiagnostic, workflowId: state.workflowId, revision: state.stateRevision })}.md`,
            JSON.stringify({
              schemaVersion: 1,
              recordType: "planning-input-diagnostic",
              workflowId: state.workflowId,
              sourceRevision: state.stateRevision,
              ...inputDiagnostic,
            }),
          )
        : undefined;
      state = await advanceWorkflow(
        state,
        {
          type: "BLOCK",
          reason: jevBlockedReason(error),
          ...(diagnosticRef
            ? { evidenceRef: diagnosticRef }
            : ref
              ? { evidenceRef: ref }
              : {}),
        },
        this.deps.stateStore,
      );
      throw new PlanningRoutingStoppedError(state);
    }
    if (!ref) {
      // Artifact -> CAS State -> next external effect. Persistence failures are never retried here.
      const kind =
        family === "method"
          ? "development-method"
          : family === "stage"
            ? "conditional-stage"
            : "clarification-mode";
      const file = `${kind}-${stage}-${digest(artifact)}.json`;
      const content = JSON.stringify(parsePlanningDecisionArtifact(artifact));
      const expected = createArtifactRef(
        kind,
        artifactRelativePath(kind, file),
        content,
      );
      try {
        ref = this.deps.artifactStore.writeJson
          ? await this.deps.artifactStore.writeJson(
              kind,
              file,
              artifact,
              parsePlanningDecisionArtifact,
            )
          : await this.deps.artifactStore.writeText(kind, file, content);
      } catch (error) {
        if (
          !(error instanceof ArtifactImmutableError) ||
          (await authoritativeText(this.deps.artifactStore, expected)) !==
            content
        )
          throw error;
        ref = expected;
      }
      if (!sameArtifactRef(expected, ref))
        throw Error("Planning decision Artifact identity mismatch");
      state = await advanceWorkflow(
        state,
        family === "method"
          ? {
              type: "DEVELOPMENT_METHOD_RESOLVED",
              methodRef: { ...ref, kind: "development-method" },
            }
          : family === "stage" && stage !== "development-method"
            ? {
                type: "STAGE_RESOLVED",
                stage,
                decisionRef: { ...ref, kind: "conditional-stage" },
                required: artifact.outcome === "RUN",
              }
            : {
                type: "CLARIFICATION_MODE_RESOLVED",
                decisionRef: { ...ref, kind: "clarification-mode" },
              },
        this.deps.stateStore,
      );
    }
    if (
      artifact.family === "stage" &&
      stage === "research" &&
      artifact.outcome === "ESCALATE" &&
      !reuseOnly &&
      this.deps.humanQuestionPort
    ) {
      try {
        const selected = await selectResearch(state, artifact, this.deps);
        // Revalidate current consent/configuration and the complete Human chain before dispatch.
        return await this.resolve(selected.state, stage, family, true);
      } catch (error) {
        if (error instanceof PlanningRoutingStoppedError) throw error;
        state = this.deps.loadState ? await this.deps.loadState() : state;
        if (state.workflowId !== source.workflowId)
          throw Error("Human Research workflow identity changed", {
            cause: error,
          });
        if (state.phase !== "gathering-context")
          throw new PlanningRoutingStoppedError(state);
      }
    }
    if (
      artifact.family === "method" &&
      artifact.outcome === "ESCALATE" &&
      !reuseOnly &&
      this.deps.humanQuestionPort
    ) {
      try {
        return await selectDevelopmentMethod(state, artifact, this.deps);
      } catch {
        // The question or answer may already be durable. Never block a stale snapshot or re-ask.
        state = this.deps.loadState ? await this.deps.loadState() : state;
        if (state.workflowId !== source.workflowId)
          throw Error("Human method workflow identity changed");
        if (state.phase !== "planning")
          throw new PlanningRoutingStoppedError(state);
      }
    }
    if (artifact.outcome === "ESCALATE") {
      state = await advanceWorkflow(
        state,
        {
          type: "BLOCK",
          reason: "operator-attention-required",
          evidenceRef:
            artifact.family === "method"
              ? (state.planning.developmentMethodSelectionRef ?? ref)
              : ref,
        },
        this.deps.stateStore,
      );
      throw new PlanningRoutingStoppedError(state);
    }
    return { state, artifact };
  }
}
