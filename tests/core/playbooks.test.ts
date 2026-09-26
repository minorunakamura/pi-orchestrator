import { expect, test } from "vitest";
import {
  getPlaybookStagePolicy,
  playbookKinds,
  playbookStages,
  resolvePlaybookPolicy,
  type PlaybookContext,
  type StagePolicy,
} from "../../src/core/playbooks/policy.ts";

const expectedPolicy: Record<
  (typeof playbookKinds)[number],
  Record<(typeof playbookStages)[number], StagePolicy>
> = {
  "new-project": {
    research: "required",
    clarification: "conditional",
    architecture: "required",
    "plan-review": "required",
    "code-review": "required",
  },
  feature: {
    research: "conditional",
    clarification: "conditional",
    architecture: "conditional",
    "plan-review": "required",
    "code-review": "required",
  },
  bugfix: {
    research: "conditional",
    clarification: "conditional",
    architecture: "conditional",
    "plan-review": "required",
    "code-review": "required",
  },
  hotfix: {
    research: "skip",
    clarification: "conditional",
    architecture: "skip",
    "plan-review": "required",
    "code-review": "required",
  },
  chore: {
    research: "skip",
    clarification: "skip",
    architecture: "skip",
    "plan-review": "required",
    "code-review": "required",
  },
};

test("defines a complete deterministic stage matrix for every v1 playbook", () => {
  for (const playbook of playbookKinds) {
    expect(getPlaybookStagePolicy(playbook)).toEqual(expectedPolicy[playbook]);
    expect(resolvePlaybookPolicy(playbook)).toEqual(
      Object.fromEntries(
        playbookStages.map((stage) => [
          stage,
          expectedPolicy[playbook][stage] === "required" ? "required" : "skip",
        ]),
      ),
    );
  }
});

test("resolves conditional stages from explicit context without a Jev decision", () => {
  const context: PlaybookContext = {
    requiresResearch: true,
    requiresClarification: false,
    requiresArchitecture: true,
  };
  const resolved = resolvePlaybookPolicy("feature", context);

  expect(resolved).toEqual({
    research: "required",
    clarification: "skip",
    architecture: "required",
    "plan-review": "required",
    "code-review": "required",
  });
  expect(resolvePlaybookPolicy("feature", context)).toEqual(resolved);
});

test("keeps both Human Gates required regardless of conditional context", () => {
  const resolved = resolvePlaybookPolicy("chore", {
    requiresResearch: true,
    requiresClarification: true,
    requiresArchitecture: true,
  });

  expect(resolved["plan-review"]).toBe("required");
  expect(resolved["code-review"]).toBe("required");
});
