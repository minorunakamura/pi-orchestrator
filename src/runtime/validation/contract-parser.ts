import {
  parseValidationContract,
  type ValidationContract,
} from "../../core/decisions/types.ts";

export class ValidationContractParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ValidationContractParseError";
  }
}

export interface ValidationContractBlock {
  body: string;
  startLine: number;
  endLine: number;
}

interface Fence {
  character: "`" | "~";
  length: number;
  info: string;
}

function openingFence(line: string): Fence | undefined {
  const match = /^\s*(`{3,}|~{3,})(.*)$/u.exec(line);
  if (!match) return undefined;
  return {
    character: match[1].startsWith("`") ? "`" : "~",
    length: match[1].length,
    info: match[2].trim(),
  };
}

function closesFence(line: string, fence: Fence): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith(fence.character.repeat(fence.length)) &&
    trimmed.slice(fence.length).trim().length === 0
  );
}

function findBlocks(markdown: string): ValidationContractBlock[] {
  const lines = markdown.split(/\r?\n/u);
  const blocks: ValidationContractBlock[] = [];
  let activeFence: Fence | undefined;
  let contractStart: number | undefined;
  let body: string[] = [];

  for (const [index, line] of lines.entries()) {
    if (activeFence) {
      if (closesFence(line, activeFence)) {
        if (contractStart !== undefined) {
          blocks.push({
            body: body.join("\n"),
            startLine: contractStart,
            endLine: index,
          });
          contractStart = undefined;
          body = [];
        }
        activeFence = undefined;
      } else if (contractStart !== undefined) {
        body.push(line);
      }
      continue;
    }

    const fence = openingFence(line);
    if (!fence) continue;
    activeFence = fence;
    if (fence.character === "`" || fence.character === "~") {
      if (fence.info === "orchestrator-validation") {
        contractStart = index;
        body = [];
      }
    }
  }

  if (contractStart !== undefined) {
    throw new ValidationContractParseError(
      `Validation Contract block starting at line ${contractStart + 1} is not closed`,
    );
  }

  return blocks;
}

export function findValidationContractBlocks(
  markdown: string,
): readonly ValidationContractBlock[] {
  return findBlocks(markdown);
}

export function extractValidationContractBlock(markdown: string): string {
  const blocks = findBlocks(markdown);
  if (blocks.length !== 1) {
    throw new ValidationContractParseError(
      blocks.length === 0
        ? "Plan must contain exactly one orchestrator-validation block"
        : "Plan must contain exactly one orchestrator-validation block; multiple blocks found",
    );
  }
  return blocks[0].body;
}

export function parseValidationContractBlock(
  markdown: string,
): ValidationContract {
  const json = extractValidationContractBlock(markdown);
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new ValidationContractParseError(
      `Validation Contract JSON is malformed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  try {
    return parseValidationContract(value);
  } catch (error) {
    throw new ValidationContractParseError(
      `Validation Contract is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
