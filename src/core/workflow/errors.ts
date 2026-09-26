export class SchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaValidationError";
  }
}

export type TransitionErrorCode =
  | "invalid-state"
  | "invalid-event"
  | "invalid-transition"
  | "invariant-violation";

export class TransitionError extends Error {
  constructor(
    message: string,
    public readonly code: TransitionErrorCode = "invalid-transition",
  ) {
    super(message);
    this.name = "TransitionError";
  }
}

export class InvariantViolationError extends TransitionError {
  constructor(message: string) {
    super(message, "invariant-violation");
    this.name = "InvariantViolationError";
  }
}
