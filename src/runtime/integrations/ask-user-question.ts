import type { EventBus } from "./subagents.ts";
import { isRecord, isNonEmptyString, isOneOf } from "../../core/schema.ts";

// Public GitHub-only v1 contract, pinned source recorded in docs/implementation/clarification.md.
export const QUESTION_REQUEST_EVENT = "pi-ask-user-question:request:v1";
export const QUESTION_CANCEL_EVENT = "pi-ask-user-question:cancel:v1";
export interface HumanQuestion {
  question: string;
  header?: string;
  options: { label: string; description?: string; preview?: string }[];
  multiSelect?: boolean;
  allowOther?: boolean;
}
export interface HumanReply {
  status: "answered" | "user-cancelled" | "caller-aborted" | "shutdown";
  answers: Record<string, string | string[]>;
  questions: HumanQuestion[];
  selections: unknown[];
  cancelled: boolean;
}

export interface HumanQuestionPort {
  rootSessionId: string;
  projectRoot: string;
  ask(
    requestId: string,
    questions: HumanQuestion[],
    signal?: AbortSignal,
  ): Promise<HumanReply>;
}

export function normalizeHumanQuestions(value: unknown): HumanQuestion[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 4 ||
    JSON.stringify(value).length > 32768
  )
    throw Error("Clarification requires 1-4 bounded questions");
  const questions = value.map((q, index) => {
    if (
      !isRecord(q) ||
      !isNonEmptyString(q.question) ||
      !q.question.trim() ||
      !Array.isArray(q.options) ||
      q.options.length > 4 ||
      (q.header !== undefined && typeof q.header !== "string") ||
      [q.multiSelect, q.allowOther].some(
        (v) => v !== undefined && typeof v !== "boolean",
      )
    )
      throw Error("Invalid Human question");
    const options = q.options.map((option) => {
      if (
        !isRecord(option) ||
        !isNonEmptyString(option.label) ||
        !option.label.trim() ||
        [option.description, option.preview].some(
          (v) => v !== undefined && typeof v !== "string",
        )
      )
        throw Error("Invalid Human option");
      return {
        label: option.label.trim(),
        ...(typeof option.description === "string" && option.description.trim()
          ? { description: option.description.trim() }
          : {}),
        ...(typeof option.preview === "string" && option.preview.trim()
          ? { preview: option.preview.trim() }
          : {}),
      };
    });
    if (new Set(options.map((o) => o.label)).size !== options.length)
      throw Error("Duplicate options");
    return {
      question: q.question.trim(),
      header: (typeof q.header === "string" && q.header.trim()
        ? q.header.trim()
        : `Q${index + 1}`
      ).slice(0, 24),
      options,
      multiSelect: q.multiSelect === true,
      allowOther: options.length === 0 || q.allowOther !== false,
    };
  });
  if (new Set(questions.map((q) => q.question)).size !== questions.length)
    throw Error("Duplicate questions");
  return questions;
}

export function parseHumanReply(
  value: unknown,
  requestId: string,
  questions: HumanQuestion[],
): HumanReply {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.requestId !== requestId ||
    value.success !== true ||
    !isRecord(value.result)
  )
    throw Error("ask_user_question unavailable or invalid reply");
  const r = value.result;
  if (
    !isOneOf(
      ["answered", "user-cancelled", "caller-aborted", "shutdown"] as const,
      r.status,
    ) ||
    !isRecord(r.answers) ||
    !Array.isArray(r.questions) ||
    !Array.isArray(r.selections) ||
    typeof r.cancelled !== "boolean" ||
    JSON.stringify(normalizeHumanQuestions(r.questions)) !==
      JSON.stringify(questions)
  )
    throw Error("Human reply does not match the exact questions");
  const selections = r.selections;
  const answers: Record<string, string | string[]> = {};
  for (const [key, answerValue] of Object.entries(r.answers)) {
    if (typeof answerValue === "string" && answerValue.trim())
      answers[key] = answerValue;
    else if (
      Array.isArray(answerValue) &&
      answerValue.length &&
      answerValue.every(
        (item): item is string => typeof item === "string" && !!item.trim(),
      )
    )
      answers[key] = answerValue;
    else throw Error("Invalid Human answer value");
  }
  if (r.status === "answered") {
    if (
      r.cancelled ||
      Object.keys(r.answers).length !== questions.length ||
      r.selections.length !== questions.length
    )
      throw Error("Incomplete Human reply");
    questions.forEach((q, index) => {
      const answer = answers[q.question];
      const selection = selections[index];
      const labels = Array.isArray(answer) ? answer : [answer];
      if (
        !labels.length ||
        !labels.every((v) => typeof v === "string" && v.trim()) ||
        (q.multiSelect ? !Array.isArray(answer) : typeof answer !== "string") ||
        (!q.allowOther &&
          labels.some((v) => !q.options.some((o) => o.label === v))) ||
        !isRecord(selection) ||
        selection.question !== q.question ||
        selection.header !== q.header ||
        JSON.stringify(selection.value) !== JSON.stringify(answer) ||
        JSON.stringify(selection.labels) !== JSON.stringify(labels) ||
        !Array.isArray(selection.selectedIndices) ||
        !selection.selectedIndices.every(
          (i) =>
            Number.isSafeInteger(i) &&
            i > 0 &&
            i <= q.options.length + (q.allowOther ? 1 : 0),
        )
      )
        throw Error("Unconfirmed or mismatched Human selections");
      const indices = selection.selectedIndices;
      const custom = selection.customText;
      if (
        new Set(indices).size !== indices.length ||
        (custom !== undefined &&
          (typeof custom !== "string" || !custom.trim() || !q.allowOther)) ||
        (indices.includes(q.options.length + 1) &&
          (typeof custom !== "string" || !custom.trim()))
      )
        throw Error("Invalid Human selection detail");
      const selectedLabels = indices
        .map((i) => q.options[i - 1]?.label)
        .filter((label): label is string => typeof label === "string");
      if (typeof custom === "string") selectedLabels.push(custom.trim());
      if (JSON.stringify(selectedLabels) !== JSON.stringify(labels))
        throw Error("Human selected indices do not match confirmed labels");
    });
  } else if (!r.cancelled) throw Error("Invalid cancellation reply");
  return {
    status: r.status,
    questions,
    answers,
    selections,
    cancelled: r.cancelled,
  };
}

export class AskUserQuestionIntegration {
  constructor(
    private readonly events: EventBus,
    private readonly timeoutMs = 900000,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw Error("Finite Human deadline required");
  }
  ask(
    requestId: string,
    questions: HumanQuestion[],
    signal?: AbortSignal,
  ): Promise<HumanReply> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, reply?: HumanReply) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(reply!);
      };
      const abort = () => {
        finish(Error("Human interaction aborted or timed out"));
        this.events.emit(QUESTION_CANCEL_EVENT, { version: 1, requestId });
      };
      const unsubscribe = this.events.on(
        `pi-ask-user-question:reply:${requestId}`,
        (value) => {
          try {
            finish(undefined, parseHumanReply(value, requestId, questions));
          } catch (error) {
            finish(error instanceof Error ? error : Error(String(error)));
          }
        },
      );
      const timer = setTimeout(abort, this.timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      try {
        this.events.emit(QUESTION_REQUEST_EVENT, {
          version: 1,
          requestId,
          title: "Workflow clarification",
          questions,
        });
      } catch (error) {
        finish(error instanceof Error ? error : Error(String(error)));
      }
    });
  }
}
