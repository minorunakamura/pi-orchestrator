import type { ArtifactRef } from "../../core/artifacts/references.ts";
import {
  isValidationExecutionResult,
  parseValidationResult,
  type ValidationContract,
  type ValidationResult,
} from "../../core/decisions/types.ts";
import {
  assertStateInvariants,
  sameArtifactRef,
} from "../../core/workflow/invariants.ts";
import type { WorkflowState } from "../../core/workflow/state.ts";
import {
  ArtifactImmutableError,
  createArtifactRef,
  calculateSha256,
  validateArtifactRef,
} from "../persistence/artifact-store.ts";
import { artifactRelativePath } from "../persistence/artifact-paths.ts";
import type { ValidationExecutor } from "../ports/validation-executor.ts";
import {
  advanceWorkflow,
  type WorkflowStateWriter,
} from "./advance-workflow.ts";
import type { WorkflowArtifactWriter } from "./planning-orchestrator.ts";
import { parseValidationContractBlock } from "../validation/contract-parser.ts";
import { assertValidationChecks } from "./coding-evidence.ts";

export interface ValidationRunnerDependencies {
  artifactStore: WorkflowArtifactWriter;
  stateStore: WorkflowStateWriter;
  validationExecutor: ValidationExecutor;
}

export interface ValidationRunInput {
  state: WorkflowState;
  /** Compatibility hint only; must equal the Approved Plan contract. */
  contract?: ValidationContract;
}

export interface ValidationRunResult {
  state: WorkflowState;
  validationRef: ArtifactRef<"validation">;
  validation: ValidationResult;
}

export class ValidationRunnerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ValidationRunnerError";
  }
}

function expectedRef(
  fileName: string,
  value: ValidationResult,
): ArtifactRef<"validation"> {
  const content = JSON.stringify(value);
  return createArtifactRef(
    "validation",
    artifactRelativePath("validation", fileName),
    content,
  );
}

async function persistValidation(
  store: WorkflowArtifactWriter,
  value: ValidationResult,
  fileName: string,
): Promise<ArtifactRef<"validation">> {
  const content = JSON.stringify(value);
  const expected = expectedRef(fileName, value);
  try {
    const ref = store.writeJson
      ? await store.writeJson(
          "validation",
          fileName,
          value,
          parseValidationResult,
        )
      : await store.writeText("validation", fileName, content);
    validateArtifactRef(ref);
    if (!sameArtifactRef(ref, expected)) {
      throw new ValidationRunnerError(
        "Validation artifact writer returned a mismatched reference",
      );
    }
    return ref;
  } catch (error) {
    if (!(error instanceof ArtifactImmutableError)) throw error;
    if (store.readText && (await store.readText(expected)) === content) {
      return expected;
    }
    throw error;
  }
}

export class ValidationRunner {
  constructor(private readonly dependencies: ValidationRunnerDependencies) {}

  async execute(input: ValidationRunInput): Promise<ValidationRunResult> {
    try {
      assertStateInvariants(input.state);
    } catch (error) {
      throw new ValidationRunnerError(
        "Validation requires a valid Workflow State",
        {
          cause: error,
        },
      );
    }
    if (input.state.phase !== "validating") {
      throw new ValidationRunnerError(
        "Validation requires the validating Workflow phase",
      );
    }

    const planRef = input.state.planning.approvedPlanRef!;
    const store = this.dependencies.artifactStore;
    if (!store.readText)
      throw new ValidationRunnerError(
        "Validation requires readable Approved Plan authority",
      );
    const plan = await store.readText(planRef);
    if (calculateSha256(plan) !== planRef.sha256)
      throw new ValidationRunnerError("Approved Plan hash mismatch");
    const contract = parseValidationContractBlock(plan);
    if (
      input.contract &&
      JSON.stringify(input.contract) !== JSON.stringify(contract)
    ) {
      throw new ValidationRunnerError(
        "Caller contract does not match Approved Plan Validation Contract",
      );
    }
    const execution =
      await this.dependencies.validationExecutor.execute(contract);
    if (!isValidationExecutionResult(execution)) {
      throw new ValidationRunnerError(
        "ValidationExecutor returned an invalid execution result",
      );
    }
    assertValidationChecks(contract, execution);
    const validation: ValidationResult = {
      schemaVersion: 1,
      approvedPlanRef: planRef,
      planVersion: input.state.planning.approvedPlanVersion!,
      implementationRef: input.state.coding.implementationRef!,
      validationContractDigest: calculateSha256(JSON.stringify(contract)),
      implementationRevision: input.state.coding.implementationRevision,
      status: execution.status,
      checks: execution.checks,
    };
    const validationRef = await persistValidation(
      this.dependencies.artifactStore,
      validation,
      `validation-${validation.implementationRevision}.json`,
    );

    const state =
      validation.status === "passed"
        ? await advanceWorkflow(
            input.state,
            { type: "VALIDATION_PASSED", resultRef: validationRef },
            this.dependencies.stateStore,
          )
        : input.state;
    return { state, validationRef, validation };
  }

  run(input: ValidationRunInput): Promise<ValidationRunResult> {
    return this.execute(input);
  }
}

export async function executeValidation(
  input: ValidationRunInput,
  dependencies: ValidationRunnerDependencies,
): Promise<ValidationRunResult> {
  return new ValidationRunner(dependencies).execute(input);
}
