import type {
  ClassifierModel,
  ClassifierResult,
  ClassifierContext,
  ModelsClassifierOptions,
} from "@earendil-works/pi-ai";
import type { PiClassifierRuntime } from "../../src/runtime/integrations/jev.ts";
import { makeInvalidPayload } from "./typed-boundaries.ts";

export const classifierModel: ClassifierModel<"typesafe-system-one"> = {
  type: "classifier",
  provider: "typesafe",
  id: "jev-latest",
  name: "Jev",
  api: "typesafe-system-one",
  baseUrl: "https://api.typesafe.ai",
  input: ["text"],
  contextWindow: 32000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
export function nativeRuntime(
  classify: PiClassifierRuntime["classify"],
): PiClassifierRuntime {
  return {
    findOfType: makeInvalidPayload<PiClassifierRuntime["findOfType"]>(
      (type: string, provider: string, id: string) =>
        type === "classifier" &&
        provider === classifierModel.provider &&
        id === classifierModel.id
          ? classifierModel
          : undefined,
    ),
    classify,
  };
}
export function classification(
  answers: Record<string, unknown>,
  overrides: Partial<ClassifierResult> = {},
): ClassifierResult {
  return makeInvalidPayload<ClassifierResult>({
    api: classifierModel.api,
    provider: classifierModel.provider,
    model: classifierModel.id,
    stopReason: "stop",
    timestamp: 1,
    answers,
    usage: {
      input: 12,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 13,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...overrides,
  });
}
export function firstChoices(context: ClassifierContext): ClassifierResult {
  return classification(
    Object.fromEntries(
      Object.entries(context.questions).map(([id, question]) => {
        const options = Object.keys(question.criteria ?? {});
        return [
          id,
          {
            type: "choice",
            choice: options[0],
            confidence: 0.9,
            probabilities: Object.fromEntries(
              options.map((option, index) => [
                option,
                index === 0 ? 0.9 : 0.1 / (options.length - 1),
              ]),
            ),
          },
        ];
      }),
    ),
  );
}
export class FakeClassifierRuntime implements PiClassifierRuntime {
  readonly findOfType = nativeRuntime(async () =>
    classification({}),
  ).findOfType;
  readonly calls: {
    request: ClassifierContext;
    options?: ModelsClassifierOptions;
  }[] = [];
  constructor(
    private readonly outcomes: readonly (ClassifierResult | Error)[],
  ) {}
  async classify(
    _model: ClassifierModel<string>,
    request: ClassifierContext,
    options?: ModelsClassifierOptions,
  ): Promise<ClassifierResult> {
    this.calls.push({ request, options });
    const outcome = this.outcomes[this.calls.length - 1];
    if (!outcome) throw Error("No classifier fixture result");
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}
