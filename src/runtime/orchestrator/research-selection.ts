import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ArtifactRef } from "../../core/artifacts/references.ts";
import { isArtifactRef } from "../../core/artifacts/references.ts";
import {
  hasOnlyKeys,
  isRecord,
  isNonEmptyString,
  isOneOf,
} from "../../core/schema.ts";
import { sameArtifactRef } from "../../core/workflow/invariants.ts";
import type { WorkflowState } from "../../core/workflow/state.ts";
import {
  parsePlanningDecisionArtifact,
  type PlanningDecisionArtifact,
} from "../../core/decisions/planning-routing.ts";
import {
  normalizeHumanQuestions,
  parseHumanReply,
  type HumanReply,
  type HumanQuestion,
} from "../integrations/ask-user-question.ts";
import {
  ArtifactImmutableError,
  calculateSha256,
  createArtifactRef,
} from "../persistence/artifact-store.ts";
import { artifactRelativePath } from "../persistence/artifact-paths.ts";
import { authoritativeText } from "./coding-evidence.ts";
import { advanceWorkflow } from "./advance-workflow.ts";
import type { PlanningRoutingDependencies } from "./planning-routing.ts";
import type { WorkflowArtifactWriter } from "./planning-orchestrator.ts";

export function researchRoutingDiagnostic(
  artifact: PlanningDecisionArtifact,
  threshold: number,
): string {
  return `Research: Jev ${artifact.rawDecision?.value ?? "unknown"}, confidence=${artifact.rawDecision?.confidence ?? "unknown"}, autoDecisionThreshold=${threshold}; outcome=${artifact.outcome}. Research の要否には明示的な Human 回答が必要です。空のプロジェクトは禁止条件ではありません。`;
}

export function researchQuestions(
  artifact: PlanningDecisionArtifact,
  threshold: number,
): HumanQuestion[] {
  return normalizeHumanQuestions([
    {
      question: `${researchRoutingDiagnostic(artifact, threshold)}\n外部 Research を実行しますか？ゲーム仕様などの product choices は後続 Clarification で確認します。この選択は Plan / 実装の承認ではありません。`,
      header: "Research",
      options: [
        {
          label: "RUN",
          description:
            "外部 API / library / source の事実を調査してから Clarification 判定へ進みます。",
        },
        {
          label: "SKIP",
          description: "外部調査を省略して Clarification 判定へ進みます。",
        },
        {
          label: "HOLD",
          description: "判断を保留し、Workflow の停止を維持します。",
        },
      ],
      multiSelect: false,
      allowOther: false,
    },
  ]);
}

type Selection = {
  schemaVersion: 1;
  recordType: "research-selection";
  workflowId: string;
  projectRoot: string;
  rootSessionId: string;
  decisionRef: ArtifactRef<"conditional-stage">;
  sourceStateRevision: number;
  requestId: string;
  questions: HumanQuestion[];
} & (
  | { status: "pending" }
  | {
      status: "answered" | "cancelled";
      intentRef: ArtifactRef<"conditional-stage">;
      reply: HumanReply;
    }
);

async function readSelection(
  store: WorkflowArtifactWriter,
  ref: ArtifactRef<"conditional-stage">,
  questions: HumanQuestion[],
): Promise<Selection> {
  const value: unknown = JSON.parse(await authoritativeText(store, ref));
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "recordType",
      "workflowId",
      "projectRoot",
      "rootSessionId",
      "decisionRef",
      "sourceStateRevision",
      "requestId",
      "questions",
      "status",
      "intentRef",
      "reply",
    ]) ||
    value.schemaVersion !== 1 ||
    value.recordType !== "research-selection" ||
    ![
      value.workflowId,
      value.projectRoot,
      value.rootSessionId,
      value.requestId,
    ].every(isNonEmptyString) ||
    !Number.isSafeInteger(value.sourceStateRevision) ||
    Number(value.sourceStateRevision) < 0 ||
    !isArtifactRef(value.decisionRef) ||
    value.decisionRef.kind !== "conditional-stage" ||
    !isDeepStrictEqual(value.questions, questions) ||
    !isOneOf(["pending", "answered", "cancelled"] as const, value.status)
  )
    throw Error("Invalid Research selection evidence");
  const base = {
    schemaVersion: 1 as const,
    recordType: "research-selection" as const,
    workflowId: String(value.workflowId),
    projectRoot: String(value.projectRoot),
    rootSessionId: String(value.rootSessionId),
    decisionRef: { ...value.decisionRef, kind: "conditional-stage" as const },
    sourceStateRevision: Number(value.sourceStateRevision),
    requestId: String(value.requestId),
    questions,
  };
  if (value.status === "pending") {
    if (value.intentRef !== undefined || value.reply !== undefined)
      throw Error("Pending Research selection contains an unbound answer");
    return { ...base, status: "pending" };
  }
  if (
    !isArtifactRef(value.intentRef) ||
    value.intentRef.kind !== "conditional-stage"
  )
    throw Error("Missing Research selection intent");
  const intentRef = { ...value.intentRef, kind: "conditional-stage" as const };
  const intent: unknown = JSON.parse(await authoritativeText(store, intentRef));
  if (!isDeepStrictEqual(intent, { ...base, status: "pending" }))
    throw Error("Research selection does not match its exact intent");
  const reply = parseHumanReply(
    {
      version: 1,
      requestId: base.requestId,
      success: true,
      result: value.reply,
    },
    base.requestId,
    questions,
  );
  if ((value.status === "answered") !== (reply.status === "answered"))
    throw Error("Research selection status contradicts Human reply");
  return { ...base, status: value.status, intentRef, reply };
}

function choice(selection: Selection): "RUN" | "SKIP" {
  if (selection.status !== "answered")
    throw Error(
      "Research selection is pending, cancelled or lost; do not re-ask blindly",
    );
  const answer = selection.reply.answers[selection.questions[0].question];
  if (answer !== "RUN" && answer !== "SKIP")
    throw Error("Human deferred Research; keep Workflow stopped");
  return answer;
}

/** Original classifier evidence stays immutable; Human resolves only Research necessity. */
export async function humanResearchOutcome(
  store: WorkflowArtifactWriter,
  artifact: PlanningDecisionArtifact,
  state: Pick<WorkflowState, "workflowId" | "projectRoot">,
  threshold: number,
  rootSessionId: string,
): Promise<"RUN" | "SKIP"> {
  if (
    artifact.family !== "stage" ||
    artifact.stage !== "research" ||
    !artifact.humanResearchSelectionRef
  )
    throw Error("Missing Human Research evidence");
  const selection = await readSelection(
    store,
    artifact.humanResearchSelectionRef,
    researchQuestions({ ...artifact, outcome: "ESCALATE" }, threshold),
  );
  const original = parsePlanningDecisionArtifact(
    JSON.parse(await authoritativeText(store, selection.decisionRef)),
  );
  const {
    humanResearchSelectionRef: _human,
    outcome: _outcome,
    ...binding
  } = artifact;
  const { outcome: _originalOutcome, ...originalBinding } = original;
  if (
    original.family !== "stage" ||
    original.stage !== "research" ||
    original.humanResearchSelectionRef ||
    original.outcome !== "ESCALATE" ||
    !isDeepStrictEqual(binding, originalBinding) ||
    selection.workflowId !== artifact.workflowId ||
    selection.workflowId !== state.workflowId ||
    selection.projectRoot !== state.projectRoot ||
    selection.rootSessionId !== rootSessionId ||
    choice(selection) !== artifact.outcome
  )
    throw Error(
      "Human Research resolution does not match its original decision",
    );
  await Promise.all(
    [
      ...original.inputRefs,
      ...[original.requestRef, original.usageRef].filter(
        (ref) => ref !== undefined,
      ),
    ].map((ref) => authoritativeText(store, ref)),
  );
  return choice(selection);
}

/** Intent -> State -> root UI -> answer -> State -> resolved Research -> State -> next side effect. */
export async function selectResearch(
  state: WorkflowState,
  artifact: PlanningDecisionArtifact,
  deps: PlanningRoutingDependencies,
): Promise<{ state: WorkflowState; artifact: PlanningDecisionArtifact }> {
  const decisionRef = state.planning.stageDecisionRefs?.research;
  const port = deps.humanQuestionPort;
  const threshold = deps.configuration?.decision.autoDecisionThreshold;
  if (
    artifact.family !== "stage" ||
    artifact.stage !== "research" ||
    artifact.outcome !== "ESCALATE" ||
    !decisionRef ||
    !port ||
    !deps.loadState ||
    threshold === undefined ||
    !port.rootSessionId ||
    port.projectRoot !== state.projectRoot
  )
    throw Error("Research resolution requires a root Human questionnaire");
  const questions = researchQuestions(artifact, threshold);
  let selectionRef = state.planning.researchSelectionRef;
  let selection: Selection;
  if (selectionRef)
    selection = await readSelection(
      deps.artifactStore,
      selectionRef,
      questions,
    );
  else {
    selection = {
      schemaVersion: 1,
      recordType: "research-selection",
      workflowId: state.workflowId,
      projectRoot: port.projectRoot,
      rootSessionId: port.rootSessionId,
      decisionRef,
      sourceStateRevision: state.stateRevision,
      requestId: randomUUID(),
      questions,
      status: "pending",
    };
    selectionRef = await saveEvidence(
      selection,
      "research-selection",
      deps.artifactStore,
    );
    state = await advanceWorkflow(
      state,
      { type: "RESEARCH_SELECTION_PERSISTED", selectionRef },
      deps.stateStore,
    );
    if (deps.ownership)
      state = await deps.ownership.validate(state, deps.stateStore);
    if (state.phase !== "gathering-context")
      throw Error("Ownership no longer permits Research selection");
    const reply = await port.ask(selection.requestId, questions, deps.signal);
    const current = await deps.loadState();
    if (
      current.stateRevision !== state.stateRevision ||
      current.phase !== "gathering-context" ||
      current.workflowId !== state.workflowId ||
      !sameArtifactRef(
        current.planning.stageDecisionRefs?.research,
        decisionRef,
      ) ||
      !sameArtifactRef(current.planning.researchSelectionRef, selectionRef)
    )
      throw Error("Workflow changed while waiting for Research selection");
    state = deps.ownership
      ? await deps.ownership.validate(current, deps.stateStore)
      : current;
    if (state.phase !== "gathering-context")
      throw Error("Workspace drift during Research selection");
    const verified = parseHumanReply(
      {
        version: 1,
        requestId: selection.requestId,
        success: true,
        result: reply,
      },
      selection.requestId,
      questions,
    );
    selection = {
      ...selection,
      status: verified.status === "answered" ? "answered" : "cancelled",
      intentRef: selectionRef,
      reply: verified,
    };
    const answerRef = await saveEvidence(
      selection,
      "research-selection",
      deps.artifactStore,
    );
    state = await advanceWorkflow(
      state,
      {
        type: "RESEARCH_SELECTION_PERSISTED",
        selectionRef: answerRef,
        previousSelectionRef: selectionRef,
      },
      deps.stateStore,
    );
    selectionRef = answerRef;
  }
  if (
    selection.workflowId !== state.workflowId ||
    selection.projectRoot !== state.projectRoot ||
    selection.rootSessionId !== port.rootSessionId ||
    !sameArtifactRef(selection.decisionRef, decisionRef)
  )
    throw Error("Stale Human Research binding");
  const resolved: PlanningDecisionArtifact = {
    ...artifact,
    outcome: choice(selection),
    humanResearchSelectionRef: selectionRef,
  };
  await humanResearchOutcome(
    deps.artifactStore,
    resolved,
    state,
    threshold,
    port.rootSessionId,
  );
  const resolvedRef = await saveEvidence(
    resolved,
    "research-human",
    deps.artifactStore,
  );
  state = await advanceWorkflow(
    state,
    {
      type: "STAGE_RESOLVED",
      stage: "research",
      decisionRef: resolvedRef,
      previousDecisionRef: decisionRef,
      required: resolved.outcome === "RUN",
    },
    deps.stateStore,
  );
  return { state, artifact: resolved };
}

async function saveEvidence(
  value: unknown,
  prefix: string,
  store: WorkflowArtifactWriter,
): Promise<ArtifactRef<"conditional-stage">> {
  const content = JSON.stringify(value);
  const file = `${prefix}-${calculateSha256(content)}.md`;
  const expected = createArtifactRef(
    "conditional-stage",
    artifactRelativePath("conditional-stage", file),
    content,
  );
  try {
    const ref = await store.writeText("conditional-stage", file, content);
    if (!sameArtifactRef(ref, expected))
      throw Error("Research evidence identity mismatch");
    return ref;
  } catch (error) {
    if (
      !(error instanceof ArtifactImmutableError) ||
      (await authoritativeText(store, expected)) !== content
    )
      throw error;
    return expected;
  }
}
