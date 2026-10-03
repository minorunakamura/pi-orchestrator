import type { JevConfiguration } from "../../src/core/configuration.ts";
import type { JevCallAuthorization } from "../../src/runtime/ports/jev-decision-client.ts";

export function jevPolicy(
  projectRoot = process.cwd(),
  maxRequests = 100,
): JevConfiguration {
  return {
    runtimePolicy: {
      maxRequests,
      grant: {
        id: "test-operator-consent",
        policyVersion: "test-policy-1",
        active: true,
        projectRoot,
        destination: "typesafe/jev-latest",
        evidenceCategories: [
          "plan",
          "context",
          "implementation",
          "review",
          "validation",
          "history",
          "task",
          "scout",
          "diagnosis",
          "research",
          "clarification",
          "design",
        ],
      },
    },
  };
}
/** Adapter contract tests mock the authorization port; runtime tests use real persistence. */
export const adapterAuthorization: JevCallAuthorization = {
  destination: "typesafe/jev-latest",
  authorizeAttempt: async () => {},
  recordUsage: async () => {},
};
