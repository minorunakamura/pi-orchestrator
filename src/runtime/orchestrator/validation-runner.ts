import type { ArtifactRef } from "../../core/artifacts/references.ts";
import {
  isValidationExecutionResult,
  parseValidationResult,
  type ValidationContract,
  type ValidationExecutionResult,
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

import type { OrchestratorConfiguration } from "../../core/configuration.ts";

export interface ValidationRunnerDependencies {
  configuration?: Pick<OrchestratorConfiguration, "validation">;
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
  const write = async (name: string): Promise<ArtifactRef<"validation">> => {
    const ref = store.writeJson
      ? await store.writeJson("validation", name, value, parseValidationResult)
      : await store.writeText("validation", name, content);
    validateArtifactRef(ref);
    const expectedRefForName = expectedRef(name, value);
    if (!sameArtifactRef(ref, expectedRefForName)) {
      throw new ValidationRunnerError(
        "Validation artifact writer returned a mismatched reference",
      );
    }
    return ref;
  };
  try {
    return await write(fileName);
  } catch (error) {
    if (!(error instanceof ArtifactImmutableError)) throw error;
    if (store.readText && (await store.readText(expected)) === content)
      return expected;
    const suffix = calculateSha256(content).slice(0, 16);
    return write(`validation-${value.implementationRevision}-${suffix}.json`);
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
    let execution: ValidationExecutionResult;
    try {
      execution = await this.dependencies.validationExecutor.execute(contract);
    } catch {
      // A thrown executor failure does not establish any check result.
      execution = {
        status: "infrastructure-error",
        checks: contract.checks.map(({ id }) => ({
          id,
          status: "infrastructure-error",
          evidence: "Validation executor did not return a reliable result",
        })),
      };
    }
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
      validation.status === "infrastructure-error"
        ? `validation-${validation.implementationRevision}-infrastructure-${calculateSha256(JSON.stringify(validation)).slice(0, 16)}.json`
        : `validation-${validation.implementationRevision}.json`,
    );

    const state =
      validation.status === "passed"
        ? await advanceWorkflow(
            input.state,
            { type: "VALIDATION_PASSED", resultRef: validationRef },
            this.dependencies.stateStore,
          )
        : validation.status === "infrastructure-error" &&
            (this.dependencies.configuration?.validation
              .stopOnInfrastructureFailure ??
              true)
          ? await advanceWorkflow(
              input.state,
              {
                type: "BLOCK",
                reason: "validation-infrastructure-error",
                evidenceRef: validationRef,
              },
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
