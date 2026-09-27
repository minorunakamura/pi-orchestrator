export const portFailureKinds = [
  "domain",
  "infrastructure",
  "timeout",
  "reconciliation",
  "policy",
] as const;

export type PortFailureKind = (typeof portFailureKinds)[number];

export class RuntimePortError extends Error {
  constructor(
    public readonly kind: PortFailureKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RuntimePortError";
  }
}
