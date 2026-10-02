import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../src/core/schema.ts";

export function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an object fixture payload");
  return value;
}

/** Builds the intentionally partial host object used at the ExtensionAPI test boundary. */
export function makeExtensionApiFixture<T extends object>(
  value: T,
): ExtensionAPI & T {
  // The host framework supplies the remaining ExtensionAPI members at runtime.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as ExtensionAPI & T;
}

/** Builds the intentionally partial command context used by command tests. */
export function makeExtensionCommandContextFixture<T extends object>(
  value: T,
): ExtensionCommandContext & T {
  // Pi supplies the remaining command-context members outside this unit boundary.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as ExtensionCommandContext & T;
}

/** Keeps intentionally invalid test payloads out of production parsers. */
export function makeInvalidPayload<T>(value: unknown, _type?: T): T {
  // The unsafe shape is the subject of these negative-path tests.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as T;
}
