import type { DevelopmentMethod } from "../../core/decisions/planning-routing.ts";
import {
  planSections,
  planSectionsRequired,
  type PlanParserPolicy,
  type PlanSection,
} from "../../core/planning/policy.ts";
import type { ValidationContract } from "../../core/decisions/types.ts";
import {
  findValidationContractBlocks,
  parseValidationContractBlock,
} from "../validation/contract-parser.ts";

export class PlanParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PlanParseError";
  }
}

export interface ParsedPlan {
  content: string;
  developmentMethod: DevelopmentMethod;
  testSeams?: string;
  supportingSkills: readonly "codebase-design"[];
  sections: readonly PlanSection[];
  validationContract: ValidationContract;
}

interface Heading {
  line: number;
  level: number;
  section?: PlanSection;
}

interface Fence {
  character: "`" | "~";
  length: number;
}

function openingFence(line: string): Fence | undefined {
  const match = /^\s*(`{3,}|~{3,})/u.exec(line);
  if (!match) return undefined;
  return {
    character: match[1].startsWith("`") ? "`" : "~",
    length: match[1].length,
  };
}

function closesFence(line: string, fence: Fence): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith(fence.character.repeat(fence.length)) &&
    trimmed.slice(fence.length).trim().length === 0
  );
}

function normalizeHeading(value: string): string {
  return value
    .replace(/[ \t]+#+[ \t]*$/u, "")
    .replace(/\s*\/\s*/gu, " / ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function sectionForHeading(value: string): PlanSection | undefined {
  const normalized = normalizeHeading(value);
  for (const section of planSections) {
    if (normalizeHeading(section) === normalized) return section;
  }
  return undefined;
}

function headings(markdown: string): Heading[] {
  const lines = markdown.split(/\r?\n/u);
  const result: Heading[] = [];
  let activeFence: Fence | undefined;

  for (const [line, value] of lines.entries()) {
    if (activeFence) {
      if (closesFence(value, activeFence)) activeFence = undefined;
      continue;
    }
    const fence = openingFence(value);
    if (fence) {
      activeFence = fence;
      continue;
    }

    const match = /^(#{1,6})[ \t]+(.+?)[ \t]*$/u.exec(value);
    if (!match) continue;
    result.push({
      line,
      level: match[1].length,
      section: sectionForHeading(match[2]),
    });
  }

  return result;
}

function sectionEnd(allHeadings: readonly Heading[], heading: Heading): number {
  return (
    allHeadings.find(
      (candidate) =>
        candidate.line > heading.line && candidate.level <= heading.level,
    )?.line ?? Number.MAX_SAFE_INTEGER
  );
}

function assertSections(
  lines: readonly string[],
  allHeadings: readonly Heading[],
  policy: PlanParserPolicy,
): PlanSection[] {
  const recognized = allHeadings.filter(
    (heading): heading is Heading & { section: PlanSection } =>
      heading.section !== undefined,
  );
  const seen = new Set<PlanSection>();
  for (const heading of recognized) {
    if (seen.has(heading.section)) {
      throw new PlanParseError(`Duplicate plan section: ${heading.section}`);
    }
    seen.add(heading.section);

    const end = sectionEnd(allHeadings, heading);
    const body = lines
      .slice(heading.line + 1, end)
      .join("\n")
      .trim();
    if (body.length === 0) {
      throw new PlanParseError(`Plan section is empty: ${heading.section}`);
    }
  }

  for (const required of planSectionsRequired(policy)) {
    if (!seen.has(required)) {
      throw new PlanParseError(`Missing required plan section: ${required}`);
    }
  }
  return [...seen];
}

function assertValidationBlockBelongsToSection(
  allHeadings: readonly Heading[],
  blocks: readonly { startLine: number }[],
): void {
  const validationHeading = allHeadings.find(
    (heading) => heading.section === "Validation Contract",
  );
  if (!validationHeading || blocks.length === 0) return;

  const openingLine = blocks[0].startLine;
  if (
    openingLine <= validationHeading.line ||
    openingLine >= sectionEnd(allHeadings, validationHeading)
  ) {
    throw new PlanParseError(
      "orchestrator-validation block must be inside the Validation Contract section",
    );
  }
}

export function parsePlan(
  markdown: string,
  policy: PlanParserPolicy = {},
): ParsedPlan {
  if (typeof markdown !== "string" || markdown.trim().length === 0) {
    throw new PlanParseError("Plan must not be empty");
  }

  const lines = markdown.split(/\r?\n/u);
  const allHeadings = headings(markdown);
  const sections = assertSections(lines, allHeadings, policy);

  let validationContract: ValidationContract;
  try {
    validationContract = parseValidationContractBlock(markdown);
  } catch (error) {
    throw new PlanParseError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  const blocks = findValidationContractBlocks(markdown);
  assertValidationBlockBelongsToSection(allHeadings, blocks);

  const body = (section: PlanSection) => {
    const heading = allHeadings.find((item) => item.section === section);
    return heading
      ? lines
          .slice(heading.line + 1, sectionEnd(allHeadings, heading))
          .join("\n")
          .trim()
      : undefined;
  };
  for (const section of ["New Components", "New Dependencies"] as const) {
    if (
      /^(?:[-*]\s*)?(?:n\/a|tbd|unknown|later)[.!]?$/iu.test(
        body(section) ?? "",
      )
    )
      throw new PlanParseError(
        `${section} must declare proposed additions or explicit none`,
      );
  }
  const method = body("Development Method")
    ?.replace(/^[-*]\s+/u, "")
    .trim();
  if (method !== "STANDARD" && method !== "TDD")
    throw new PlanParseError(
      "Development Method must be exactly STANDARD or TDD",
    );
  if (policy.developmentMethod && policy.developmentMethod !== method)
    throw new PlanParseError(
      "Plan Development Method contradicts the durable decision",
    );
  const testSeams = body("Test Seams");
  if (
    method === "TDD" &&
    (!testSeams || /^(?:[-*]\s*)?(?:none|n\/a|tbd)$/iu.test(testSeams))
  )
    throw new PlanParseError(
      "TDD requires explicit Human-reviewable Test Seams",
    );
  const supporting = body("Supporting Skills")
    ?.replace(/^[-*]\s+/u, "")
    .trim();
  if (
    supporting &&
    supporting !== "none" &&
    (method !== "TDD" || supporting !== "codebase-design")
  )
    throw new PlanParseError(
      "Supporting Skills may only select codebase-design for TDD",
    );
  return {
    content: markdown,
    sections,
    validationContract,
    developmentMethod: method,
    ...(testSeams ? { testSeams } : {}),
    supportingSkills:
      supporting === "codebase-design" ? ["codebase-design"] : [],
  };
}
