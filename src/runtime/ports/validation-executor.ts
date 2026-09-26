import type {
  ValidationContract,
  ValidationExecutionResult,
} from "../../core/decisions/types.ts";
export type { ValidationExecutionResult } from "../../core/decisions/types.ts";

export interface ValidationExecutor {
  execute(contract: ValidationContract): Promise<ValidationExecutionResult>;
}
