import type { JevConfiguration } from "../../src/core/configuration.ts";
import type { JevCallAuthorization } from "../../src/runtime/ports/jev-decision-client.ts";

export function jevPolicy(
  workflowId: string,
  projectRoot = process.cwd(),
  maxRequests = 100,
): JevConfiguration {
  return {
    runtimePolicy: {
      maxRequests,
      consent: {
        id: "test-operator-consent",
        policyVersion: "test-policy-1",
        active: true,
        workflowId,
        projectRoot,
        destination: "typesafe/jev-latest",
        evidenceCategories: [
          "plan",
          "context",
          "implementation",
          "review",
          "validation",
          "history",
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
