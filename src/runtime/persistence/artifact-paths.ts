import { join } from "node:path";
import {
  artifactKinds,
  type ArtifactKind,
} from "../../core/artifacts/references.ts";

export const artifactDirectories: Readonly<Record<ArtifactKind, string>> = {
  task: "context",
  scout: "context",
  diagnosis: "context",
  "conditional-stage": "decisions",
  "clarification-mode": "decisions",
  "development-method": "decisions",
  research: "context",
  clarification: "context",
  "domain-document-write": "context",
  plan: "plans",
  "plan-review": "plan-reviews",
  "plan-simplicity-review": "plan-reviews",
  "execution-routing": "decisions",
  "jev-request": "decisions",
  "agent-launch": "agent-runs",
  "oracle-advisory": "advisory",
  implementation: "implementation",
  "plan-deviation": "implementation",
  validation: "validation",
  "correctness-review": "reviews",
  "ponytail-review": "reviews",
  "finding-evaluation": "reviews",
  "accepted-findings": "reviews",
  "round-decision": "reviews",
  "code-review": "code-reviews",
  reconciliation: "reconciliation",
};

function isArtifactKind(value: string): value is ArtifactKind {
  return artifactKinds.some((candidate) => candidate === value);
}

function assertArtifactKind(kind: string): asserts kind is ArtifactKind {
  if (!isArtifactKind(kind)) {
    throw new Error(`Unknown artifact kind: ${kind}`);
  }
}

function assertFileName(fileName: string): void {
  if (
    fileName.length === 0 ||
    fileName === "." ||
    fileName === ".." ||
    fileName.includes("/") ||
    fileName.includes("\\")
  ) {
    throw new Error(`Invalid artifact file name: ${fileName}`);
  }
}

export function artifactDirectoryName(kind: ArtifactKind): string {
  assertArtifactKind(kind);
  return artifactDirectories[kind];
}

export function artifactRelativePath(
  kind: ArtifactKind,
  fileName: string,
): string {
  assertFileName(fileName);
  return `${artifactDirectoryName(kind)}/${fileName}`;
}

export function artifactDirectoryPath(
  rootDirectory: string,
  kind: ArtifactKind,
): string {
  return join(rootDirectory, artifactDirectoryName(kind));
}

export function artifactPath(
  rootDirectory: string,
  kind: ArtifactKind,
  fileName: string,
): string {
  return join(rootDirectory, artifactRelativePath(kind, fileName));
}
