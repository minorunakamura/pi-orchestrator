import {
  DEFAULT_RETRY_LIMITS,
  parseConfiguration,
  type OrchestratorConfiguration,
} from "../../core/configuration.ts";
import { isRecord, type RecordValue } from "../../core/schema.ts";
import { SchemaValidationError } from "../../core/workflow/errors.ts";

const secretKeys = new Set([
  "apiKey",
  "api_key",
  "authToken",
  "authorization",
  "password",
  "secret",
  "token",
  "secrets",
]);

function removeSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeSecrets);
  if (!isRecord(value)) return value;

  const safe: RecordValue = {};
  for (const [key, nested] of Object.entries(value)) {
    if (!secretKeys.has(key)) safe[key] = removeSecrets(nested);
  }
  return safe;
}

export function loadConfiguration(
  settings: unknown,
): OrchestratorConfiguration {
  const safeSettings = removeSecrets(settings);
  if (!isRecord(safeSettings)) {
    throw new SchemaValidationError("Configuration settings must be an object");
  }

  const normalized: RecordValue = { ...safeSettings };

  if (!Object.hasOwn(safeSettings, "retries")) {
    normalized.retries = { ...DEFAULT_RETRY_LIMITS };
  } else if (isRecord(safeSettings.retries)) {
    normalized.retries = {
      ...DEFAULT_RETRY_LIMITS,
      ...safeSettings.retries,
    };
  }

  if (!Object.hasOwn(safeSettings, "validation")) {
    normalized.validation = { stopOnInfrastructureFailure: true };
  }

  if (!Object.hasOwn(safeSettings, "jev")) normalized.jev = {};

  return parseConfiguration(normalized);
}
