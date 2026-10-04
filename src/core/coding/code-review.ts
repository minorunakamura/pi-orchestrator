import { isCodingAuthority, type CodingAuthority } from "./authority.ts";
import { hasOnlyKeys, isNonEmptyString, isRecord } from "../schema.ts";
import { isArtifactRef, type ArtifactRef } from "../artifacts/references.ts";

/** Orchestrator identity; never an external Plannotator reviewId. */
interface PatchSource {
  cwd: string;
  patchFile: string;
  patchSha256: string;
  workspaceDigest: string;
}
export type CodeReviewSource = PatchSource &
  (
    | { type: "git-patch" }
    | {
        type: "filesystem-patch";
        baselineRef: ArtifactRef<"implementation">;
        workerAttemptRef: ArtifactRef<"implementation">;
      }
  );
export interface CodeReviewAttempt {
  schemaVersion: 1;
  recordType: "code-review-attempt";
  authority: CodingAuthority;
  attemptId: string;
  requestId: string;
  source: CodeReviewSource;
  status: "pending";
  createdAt: string;
}
export function isCodeReviewSource(value: unknown): value is CodeReviewSource {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "type",
      "cwd",
      "patchFile",
      "patchSha256",
      "workspaceDigest",
      ...(value.type === "filesystem-patch"
        ? ["baselineRef", "workerAttemptRef"]
        : []),
    ]) &&
    (value.type === "git-patch" ||
      (value.type === "filesystem-patch" &&
        isArtifactRef(value.baselineRef) &&
        value.baselineRef.kind === "implementation" &&
        isArtifactRef(value.workerAttemptRef) &&
        value.workerAttemptRef.kind === "implementation")) &&
    isNonEmptyString(value.cwd) &&
    isNonEmptyString(value.patchFile) &&
    [value.patchSha256, value.workspaceDigest].every(
      (v) => typeof v === "string" && /^[0-9a-f]{64}$/u.test(v),
    )
  );
}
export function isCodeReviewAttempt(
  value: unknown,
): value is CodeReviewAttempt {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "schemaVersion",
      "recordType",
      "authority",
      "attemptId",
      "requestId",
      "source",
      "status",
      "createdAt",
    ]) &&
    value.schemaVersion === 1 &&
    value.recordType === "code-review-attempt" &&
    isCodingAuthority(value.authority) &&
    isNonEmptyString(value.attemptId) &&
    isNonEmptyString(value.requestId) &&
    isCodeReviewSource(value.source) &&
    value.status === "pending" &&
    isNonEmptyString(value.createdAt) &&
    Number.isFinite(Date.parse(value.createdAt))
  );
}
