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
  type DevelopmentMethod,
} from "../../core/decisions/planning-routing.ts";
import {
  normalizeHumanQuestions,
  parseHumanReply,
  type HumanReply,
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

export const developmentMethodQuestions = normalizeHumanQuestions([
  {
    question:
      "開発方法を選択してください。この選択は Plan / 実装の承認ではありません。どちらも自動テストと独立した Validation を行い、Human Plan Gate / Human Code Gate は必須です。",
    header: "Development Method",
    options: [
      {
        label: "STANDARD",
        description:
          "通常の実装方法。必要なテストを追加し、Validation で検証します。",
      },
      {
        label: "TDD",
        description:
          "Human Plan Gate で Test Seams を確認し、RED → minimal GREEN の縦のスライスで実装します。",
      },
    ],
    multiSelect: false,
    allowOther: false,
  },
]);

type Selection = {
  schemaVersion: 1;
  recordType: "development-method-selection";
  workflowId: string;
  projectRoot: string;
  rootSessionId: string;
  decisionRef: ArtifactRef<"development-method">;
  sourceStateRevision: number;
  requestId: string;
  questions: typeof developmentMethodQuestions;
} & (
  | { status: "pending" }
  | {
      status: "answered" | "cancelled";
      intentRef: ArtifactRef<"development-method">;
      reply: HumanReply;
    }
);

async function readSelection(
  store: WorkflowArtifactWriter,
  ref: ArtifactRef<"development-method">,
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
    value.recordType !== "development-method-selection" ||
    ![
      value.workflowId,
      value.projectRoot,
      value.rootSessionId,
      value.requestId,
    ].every(isNonEmptyString) ||
    !Number.isSafeInteger(value.sourceStateRevision) ||
    Number(value.sourceStateRevision) < 0 ||
    !isArtifactRef(value.decisionRef) ||
    value.decisionRef.kind !== "development-method" ||
    !isDeepStrictEqual(value.questions, developmentMethodQuestions) ||
    !isOneOf(["pending", "answered", "cancelled"] as const, value.status)
  )
    throw Error("Invalid Development Method selection evidence");
  const base = {
    schemaVersion: 1 as const,
    recordType: "development-method-selection" as const,
    workflowId: String(value.workflowId),
    projectRoot: String(value.projectRoot),
    rootSessionId: String(value.rootSessionId),
    decisionRef: { ...value.decisionRef, kind: "development-method" as const },
    sourceStateRevision: Number(value.sourceStateRevision),
    requestId: String(value.requestId),
    questions: developmentMethodQuestions,
  };
  if (value.status === "pending") {
    if (value.intentRef !== undefined || value.reply !== undefined)
      throw Error("Pending selection contains an unbound answer");
    return { ...base, status: "pending" };
  }
  if (
    !isArtifactRef(value.intentRef) ||
    value.intentRef.kind !== "development-method"
  )
    throw Error("Missing selection intent");
  const intentRef = { ...value.intentRef, kind: "development-method" as const };
  // Only one predecessor is allowed. Do not traverse an unbounded/cyclic evidence chain.
  const intent: unknown = JSON.parse(await authoritativeText(store, intentRef));
  if (!isDeepStrictEqual(intent, { ...base, status: "pending" }))
    throw Error("Selection does not match its exact persisted intent");
  const reply = parseHumanReply(
    {
      version: 1,
      requestId: base.requestId,
      success: true,
      result: value.reply,
    },
    base.requestId,
    developmentMethodQuestions,
  );
  if ((value.status === "answered") !== (reply.status === "answered"))
    throw Error("Selection status contradicts Human reply");
  return { ...base, status: value.status, intentRef, reply };
}

function choice(selection: Selection): DevelopmentMethod {
  if (selection.status !== "answered")
    throw Error(
      "Human Development Method result is pending, cancelled or lost; do not re-ask blindly",
    );
  const answer =
    selection.reply.answers[developmentMethodQuestions[0].question];
  if (answer !== "STANDARD" && answer !== "TDD")
    throw Error("Unconfirmed Development Method");
  return answer;
}

/** Verify the complete Human chain for both current routing and historical Worker evidence. */
export async function humanMethodOutcome(
  store: WorkflowArtifactWriter,
  artifact: PlanningDecisionArtifact,
  state: Pick<WorkflowState, "workflowId" | "projectRoot">,
  rootSessionId?: string,
): Promise<DevelopmentMethod> {
  if (artifact.family !== "method" || !artifact.humanSelectionRef)
    throw Error("Missing Human method evidence");
  const selection = await readSelection(store, artifact.humanSelectionRef);
  const original = parsePlanningDecisionArtifact(
    JSON.parse(await authoritativeText(store, selection.decisionRef)),
  );
  const { humanSelectionRef: _human, outcome: _outcome, ...binding } = artifact;
  const { outcome: _originalOutcome, ...originalBinding } = original;
  if (
    original.family !== "method" ||
    original.humanSelectionRef ||
    original.outcome !== "ESCALATE" ||
    !isDeepStrictEqual(binding, originalBinding) ||
    selection.workflowId !== artifact.workflowId ||
    selection.workflowId !== state.workflowId ||
    selection.projectRoot !== state.projectRoot ||
    (rootSessionId !== undefined &&
      selection.rootSessionId !== rootSessionId) ||
    choice(selection) !== artifact.outcome
  )
    throw Error("Human method resolution does not match the original decision");
  await Promise.all(
    original.inputRefs.map((ref) => authoritativeText(store, ref)),
  );
  await Promise.all(
    [original.requestRef, original.usageRef]
      .filter((ref) => ref !== undefined)
      .map((ref) => authoritativeText(store, ref)),
  );
  return choice(selection);
}

/** Intent -> State -> actual root UI -> exact answer -> State -> resolved method -> State. */
export async function selectDevelopmentMethod(
  state: WorkflowState,
  artifact: PlanningDecisionArtifact,
  deps: PlanningRoutingDependencies,
): Promise<{ state: WorkflowState; artifact: PlanningDecisionArtifact }> {
  const decisionRef = state.planning.developmentMethodRef;
  const port = deps.humanQuestionPort;
  if (
    artifact.family !== "method" ||
    artifact.outcome !== "ESCALATE" ||
    !decisionRef ||
    !port ||
    !deps.loadState ||
    !port.rootSessionId ||
    port.projectRoot !== state.projectRoot
  )
    throw Error("Development Method requires a root Human questionnaire");
  let selectionRef = state.planning.developmentMethodSelectionRef;
  let selection: Selection;
  if (selectionRef) {
    selection = await readSelection(deps.artifactStore, selectionRef);
  } else {
    selection = {
      schemaVersion: 1,
      recordType: "development-method-selection",
      workflowId: state.workflowId,
      projectRoot: port.projectRoot,
      rootSessionId: port.rootSessionId,
      decisionRef,
      sourceStateRevision: state.stateRevision,
      requestId: randomUUID(),
      questions: developmentMethodQuestions,
      status: "pending",
    };
    selectionRef = await saveMethodEvidence(
      selection,
      "method-selection",
      deps.artifactStore,
    );
    state = await advanceWorkflow(
      state,
      { type: "DEVELOPMENT_METHOD_SELECTION_PERSISTED", selectionRef },
      deps.stateStore,
    );
    if (deps.ownership)
      state = await deps.ownership.validate(state, deps.stateStore);
    if (state.phase !== "planning")
      throw Error("Ownership no longer permits Human method selection");
    const reply = await port.ask(
      selection.requestId,
      developmentMethodQuestions,
      deps.signal,
    );
    const current = await deps.loadState();
    if (
      current.stateRevision !== state.stateRevision ||
      current.phase !== "planning" ||
      current.workflowId !== state.workflowId ||
      !sameArtifactRef(current.planning.developmentMethodRef, decisionRef) ||
      !sameArtifactRef(
        current.planning.developmentMethodSelectionRef,
        selectionRef,
      )
    )
      throw Error("Workflow changed while waiting for Human method selection");
    state = deps.ownership
      ? await deps.ownership.validate(current, deps.stateStore)
      : current;
    if (state.phase !== "planning")
      throw Error("Workspace drift during Human method selection");
    const verified = parseHumanReply(
      {
        version: 1,
        requestId: selection.requestId,
        success: true,
        result: reply,
      },
      selection.requestId,
      developmentMethodQuestions,
    );
    selection = {
      ...selection,
      status: verified.status === "answered" ? "answered" : "cancelled",
      intentRef: selectionRef,
      reply: verified,
    };
    const answerRef = await saveMethodEvidence(
      selection,
      "method-selection",
      deps.artifactStore,
    );
    state = await advanceWorkflow(
      state,
      {
        type: "DEVELOPMENT_METHOD_SELECTION_PERSISTED",
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
    throw Error("Stale Human Development Method binding");
  const resolved: PlanningDecisionArtifact = {
    ...artifact,
    outcome: choice(selection),
    humanSelectionRef: selectionRef,
  };
  await humanMethodOutcome(
    deps.artifactStore,
    resolved,
    state,
    port.rootSessionId,
  );
  const methodRef = await saveMethodEvidence(
    resolved,
    "development-method-human",
    deps.artifactStore,
  );
  state = await advanceWorkflow(
    state,
    {
      type: "DEVELOPMENT_METHOD_RESOLVED",
      methodRef,
      previousMethodRef: decisionRef,
    },
    deps.stateStore,
  );
  return { state, artifact: resolved };
}

async function saveMethodEvidence(
  value: unknown,
  prefix: string,
  store: WorkflowArtifactWriter,
): Promise<ArtifactRef<"development-method">> {
  const content = JSON.stringify(value);
  const file = `${prefix}-${calculateSha256(content)}.md`;
  const expected = createArtifactRef(
    "development-method",
    artifactRelativePath("development-method", file),
    content,
  );
  try {
    const ref = await store.writeText("development-method", file, content);
    if (!sameArtifactRef(ref, expected))
      throw Error("Method evidence identity mismatch");
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
