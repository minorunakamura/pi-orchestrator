import type { ArtifactRef } from "../../core/artifacts/references.ts";

export interface ClarificationSkill {
  name: string;
  path: string;
  sha256: string;
  content: string;
}

export interface ClarificationSetup {
  rootSessionId: string;
  skills: ClarificationSkill[];
}

export interface ClarificationRequest {
  workflowId?: string;
  canonicalProjectRoot?: string;
  requestRef?: ArtifactRef<"clarification">;
  setup?: ClarificationSetup;
  evidence?: { ref: ArtifactRef; content: string }[];
  /** Selected mode is not documentation or implementation write authority. */
  mode?: "GRILL_ME" | "GRILL_WITH_DOCS" | "ESCALATE";
  modeRef?: ArtifactRef<"clarification-mode">;
  prompt: string;
  contextRefs: readonly ArtifactRef[];
}

export type ClarificationResult =
  | { status: "provided"; answer: string }
  | { status: "declined"; reason?: string }
  | { status: "pending" };

export interface ClarificationPort {
  setup?(mode: "GRILL_ME" | "GRILL_WITH_DOCS"): Promise<ClarificationSetup>;
  request(input: ClarificationRequest): Promise<ClarificationResult>;
}
