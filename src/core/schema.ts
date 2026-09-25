import { SchemaValidationError } from "./workflow/errors.ts";

export type RecordValue = Record<string, unknown>;

export function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOnlyKeys(
  value: RecordValue,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function hasKey(value: RecordValue, key: string): boolean {
  return Object.hasOwn(value, key);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0;
}

export function isConfidence(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

export function isSchemaVersion(value: unknown): value is 1 {
  return value === 1;
}

export function optional(
  value: RecordValue,
  key: string,
  predicate: (candidate: unknown) => boolean,
): boolean {
  return !hasKey(value, key) || predicate(value[key]);
}

export function parseSchema<T>(
  value: unknown,
  predicate: (candidate: unknown) => candidate is T,
  name: string,
): T {
  if (!predicate(value)) {
    throw new SchemaValidationError(`Invalid ${name}`);
  }
  return value;
}

export function isOneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === "string" && values.some((candidate) => candidate === value)
  );
}
