import { expect, test } from "vitest";
import {
  getPlaybookStagePolicy,
  playbookKinds,
  resolvePlaybookPolicy,
} from "../../src/core/playbooks/policy.ts";
import {
  stageOutcome,
  clarificationOutcome,
} from "../../src/core/decisions/planning-routing.ts";

test.each(playbookKinds)(
  "%s keeps evidence-dependent policy unresolved and both Human Gates mandatory",
  (playbook) => {
    const policy = getPlaybookStagePolicy(playbook);
    expect(policy).toEqual({
      research: "conditional",
      clarification: "conditional",
      architecture:
        playbook === "new-project"
          ? "required"
          : ["hotfix", "chore"].includes(playbook)
            ? "skip"
            : "conditional",
      "plan-review": "required",
      "code-review": "required",
    });
    expect(
      resolvePlaybookPolicy(playbook, {
        requiresResearch: false,
        requiresClarification: true,
        requiresArchitecture: false,
      }),
    ).toEqual(policy);
  },
);
test("classifier cannot override deterministic policy or silently skip on low confidence", () => {
  expect(stageOutcome("required", { value: "SKIP", confidence: 1 }, 0.8)).toBe(
    "RUN",
  );
  expect(stageOutcome("skip", { value: "RUN", confidence: 1 }, 0.8)).toBe(
    "SKIP",
  );
  expect(
    stageOutcome("conditional", { value: "SKIP", confidence: 0.79 }, 0.8),
  ).toBe("ESCALATE");
  expect(
    stageOutcome("conditional", { value: "RUN", confidence: 0.8 }, 0.8),
  ).toBe("RUN");
  expect(
    clarificationOutcome("RUN", { value: "SKIP", confidence: 1 }, 0.8),
  ).toBe("ESCALATE");
  expect(
    clarificationOutcome(
      "RUN",
      { value: "GRILL_WITH_DOCS", confidence: 0.79 },
      0.8,
    ),
  ).toBe("ESCALATE");
});
