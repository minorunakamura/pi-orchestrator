import type { ArtifactRef } from "../../core/artifacts/references.ts";

export interface ClarificationRequest {
  /** Selected mode is not documentation or implementation write authority. */
  mode?: "GRILL_ME" | "GRILL_WITH_DOCS" | "ESCALATE";
  modeRef?: ArtifactRef<"clarification-mode">;
  prompt: string;
  contextRefs: readonly ArtifactRef[];
}

export type ClarificationResult =
  | { status: "provided"; answer: string }
  | { status: "declined"; reason?: string };

export interface ClarificationPort {
  request(input: ClarificationRequest): Promise<ClarificationResult>;
}
