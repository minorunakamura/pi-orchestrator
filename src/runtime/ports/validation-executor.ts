import type {
  ValidationContract,
  ValidationResult,
} from "../../core/decisions/types.ts";

export interface ValidationExecutor {
  execute(contract: ValidationContract): Promise<ValidationResult>;
}
