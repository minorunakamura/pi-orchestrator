import {
  hasOnlyKeys,
  isNonEmptyString,
  isOneOf,
  isRecord,
  isSchemaVersion,
  parseSchema,
} from "../schema.ts";

export const artifactKinds = [
  "task",
  "scout",
  "research",
  "clarification",
  "plan",
  "plan-review",
  "execution-routing",
  "jev-request",
  "implementation",
  "validation",
  "correctness-review",
  "ponytail-review",
  "finding-evaluation",
  "accepted-findings",
  "round-decision",
  "code-review",
  "reconciliation",
] as const;

export type ArtifactKind = (typeof artifactKinds)[number];

export interface ArtifactRef<K extends ArtifactKind = ArtifactKind> {
  kind: K;
  path: string;
  schemaVersion: 1;
  sha256: string;
}

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return isOneOf(artifactKinds, value);
}

export function isArtifactRef(value: unknown): value is ArtifactRef {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["kind", "path", "schemaVersion", "sha256"])
  ) {
    return false;
  }

  return (
    isArtifactKind(value.kind) &&
    isNonEmptyString(value.path) &&
    isSchemaVersion(value.schemaVersion) &&
    isNonEmptyString(value.sha256)
  );
}

export function parseArtifactRef(value: unknown): ArtifactRef {
  return parseSchema(value, isArtifactRef, "ArtifactRef");
}
