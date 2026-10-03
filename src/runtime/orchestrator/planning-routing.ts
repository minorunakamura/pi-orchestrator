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
  stageOutcome,
  parsePlanningDecisionArtifact,
  isConditionalStageDecision,
  isClarificationModeDecision,
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
  subagentExecutor?: SubagentExecutor;
  configuration?: OrchestratorConfiguration;
  jevDecisionClient?: JevDecisionClient &
    Partial<Pick<DecisionClassifierPort, "routeStage" | "routeClarification">>;
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

/** Sequential durable decisions only; no questions, domain writes, or implementation grants. */
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

  private async inputs(
    state: WorkflowState,
    stage: ConditionalStage,
    family: "stage" | "clarification",
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
    return { refs };
  }

  private async resolve(
    source: WorkflowState,
    stage: ConditionalStage,
    family: "stage" | "clarification",
    reuseOnly: boolean,
  ): Promise<{ state: WorkflowState; artifact: PlanningDecisionArtifact }> {
    let state = source;
    let authorization: JevAuthorization | undefined;
    let artifact: PlanningDecisionArtifact;
    let ref:
      | ArtifactRef<"conditional-stage" | "clarification-mode">
      | undefined;
    try {
      const { refs, clarificationStage } = await this.inputs(
        state,
        stage,
        family,
      );
      const policy = getPlaybookStagePolicy(state.playbook)[stage];
      const called =
        family === "stage"
          ? policy === "conditional"
          : clarificationStage === "RUN";
      const configuration = this.deps.configuration;
      if (called && !configuration)
        attention("Planning classifier configuration is required");
      const threshold = configuration?.decision.autoDecisionThreshold ?? 1;
      const evidence = await Promise.all(
        refs.map(async (inputRef) => ({
          ref: inputRef,
          content: await authoritativeText(this.deps.artifactStore, inputRef),
        })),
      );
      if (
        evidence.some(
          ({ content }) => content.length > PLANNING_EVIDENCE_LIMITS.artifact,
        ) ||
        evidence.reduce((size, item) => size + item.content.length, 0) >
          PLANNING_EVIDENCE_LIMITS.total
      )
        attention(
          "Decision-critical planning evidence exceeds the bounded input; do not truncate constraints",
        );
      const input: PlanningClassifierInput = {
        playbook: state.playbook,
        inputRefs: refs,
        evidence: {
          stage,
          policy,
          projectRoot: state.projectRoot,
          artifacts: evidence,
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
        family === "stage"
          ? state.planning.stageDecisionRefs?.[stage]
          : state.planning.clarificationModeRef;
      if (ref) {
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
        const effective =
          artifact.family === "stage"
            ? stageOutcome(policy, artifact.rawDecision, threshold)
            : clarificationOutcome(
                clarificationStage!,
                artifact.rawDecision,
                threshold,
              );
        if (
          effective !== artifact.outcome ||
          (family === "stage" &&
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
          if (!client?.routeStage || !client.routeClarification)
            throw new RuntimePortError(
              "infrastructure",
              "Planning classifier is unavailable",
            );
          const categories: JevEvidenceCategory[] = ["task", "scout"];
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
                "plan-review",
                "round-decision",
              ].includes(item.kind),
            )
          )
            categories.push("history");
          authorization = new JevAuthorization(
            state,
            configuration!.jev,
            this.deps.artifactStore,
            this.deps.stateStore,
            family,
            categories,
          );
          authorization.assertAllowed();
          if (family === "stage") {
            const rawDecision = await client.routeStage(
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
            const rawDecision = await client.routeClarification(
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
            family === "stage"
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
      state = await advanceWorkflow(
        state,
        {
          type: "BLOCK",
          reason: jevBlockedReason(error),
          ...(ref ? { evidenceRef: ref } : {}),
        },
        this.deps.stateStore,
      );
      throw new PlanningRoutingStoppedError(state);
    }
    if (!ref) {
      // Artifact -> CAS State -> next external effect. Persistence failures are never retried here.
      const kind =
        family === "stage" ? "conditional-stage" : "clarification-mode";
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
        family === "stage"
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
    if (artifact.outcome === "ESCALATE") {
      state = await advanceWorkflow(
        state,
        {
          type: "BLOCK",
          reason: "operator-attention-required",
          evidenceRef: ref,
        },
        this.deps.stateStore,
      );
      throw new PlanningRoutingStoppedError(state);
    }
    return { state, artifact };
  }
}
