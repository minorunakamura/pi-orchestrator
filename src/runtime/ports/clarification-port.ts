import type { ArtifactRef } from "../../core/artifacts/references.ts";

export interface ClarificationRequest {
  prompt: string;
  contextRefs: readonly ArtifactRef[];
}

export type ClarificationResult =
  | { status: "provided"; answer: string }
  | { status: "declined"; reason?: string };

export interface ClarificationPort {
  request(input: ClarificationRequest): Promise<ClarificationResult>;
}
