import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_RETRY_LIMITS,
  parseConfiguration,
  type OrchestratorConfiguration,
} from "../../core/configuration.ts";
import { isRecord, type RecordValue } from "../../core/schema.ts";
import { SchemaValidationError } from "../../core/workflow/errors.ts";

export const PI_ORCHESTRATOR_SETTINGS_KEY = "piOrchestrator" as const;

type SettingsManagerReader = Pick<
  SettingsManager,
  "getGlobalSettings" | "getProjectSettings" | "drainErrors"
>;

export interface ProductionConfigurationOptions {
  agentDir?: string;
  projectTrusted?: boolean;
  settingsManager?: SettingsManagerReader;
}

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

function mergeSettings(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (base === undefined || !isRecord(base) || !isRecord(override))
    return override;
  const merged: RecordValue = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = isRecord(merged[key])
      ? mergeSettings(merged[key], value)
      : value;
  }
  return merged;
}

function configurationSettings(manager: SettingsManagerReader): unknown {
  const globalSettings: unknown = manager.getGlobalSettings();
  const projectSettings: unknown = manager.getProjectSettings();
  const global = isRecord(globalSettings) ? globalSettings : {};
  const project = isRecord(projectSettings) ? projectSettings : {};
  return mergeSettings(
    global[PI_ORCHESTRATOR_SETTINGS_KEY],
    project[PI_ORCHESTRATOR_SETTINGS_KEY],
  );
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

/**
 * Read the operator configuration through Pi's existing global/project
 * settings boundary. The returned object is the non-secret domain snapshot;
 * Pi settings and credentials are never passed to the orchestrator.
 */
export function loadProductionConfiguration(
  cwd: string,
  options: ProductionConfigurationOptions = {},
): OrchestratorConfiguration {
  const manager =
    options.settingsManager ??
    SettingsManager.create(cwd, options.agentDir ?? getAgentDir(), {
      projectTrusted: options.projectTrusted ?? true,
    });
  if (manager.drainErrors().length > 0) {
    throw new SchemaValidationError("Unable to load Pi settings");
  }
  return loadConfiguration(configurationSettings(manager));
}
