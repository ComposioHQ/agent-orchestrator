import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const FEEDBACK_TOOL_NAMES = {
  BUG_REPORT: "bug_report",
  IMPROVEMENT_SUGGESTION: "improvement_suggestion",
} as const;

export type FeedbackToolName = (typeof FEEDBACK_TOOL_NAMES)[keyof typeof FEEDBACK_TOOL_NAMES];

const normalizeText = (value: string): string => value.trim().replace(/\s+/g, " ");

const NonEmptyTextSchema = z.string().transform(normalizeText).pipe(z.string().min(1));

const FeedbackInputSchema = z
  .object({
    title: NonEmptyTextSchema,
    body: NonEmptyTextSchema,
    evidence: z.array(NonEmptyTextSchema).min(1),
    session: NonEmptyTextSchema,
    source: NonEmptyTextSchema,
    confidence: z.number().finite().min(0).max(1),
  })
  .strict();

export const BugReportSchema = FeedbackInputSchema;
export const ImprovementSuggestionSchema = FeedbackInputSchema;

export type BugReportInput = z.infer<typeof BugReportSchema>;
export type ImprovementSuggestionInput = z.infer<typeof ImprovementSuggestionSchema>;
export type FeedbackToolInput = BugReportInput | ImprovementSuggestionInput;

export interface FeedbackToolContract {
  name: FeedbackToolName;
  description: string;
  schema: typeof FeedbackInputSchema;
}

export const FEEDBACK_TOOL_CONTRACTS: Record<FeedbackToolName, FeedbackToolContract> = {
  bug_report: {
    name: FEEDBACK_TOOL_NAMES.BUG_REPORT,
    description: "Capture reproducible bugs found while working in AO sessions.",
    schema: BugReportSchema,
  },
  improvement_suggestion: {
    name: FEEDBACK_TOOL_NAMES.IMPROVEMENT_SUGGESTION,
    description: "Capture actionable improvement suggestions discovered in AO sessions.",
    schema: ImprovementSuggestionSchema,
  },
};

export interface PersistedFeedbackReport extends FeedbackToolInput {
  id: string;
  tool: FeedbackToolName;
  createdAt: string;
  dedupeKey: string;
}

const ReportIdSchema = z.string().regex(/^report_[A-Za-z0-9_-]+$/);
const ISODateSchema = z.string().datetime({ offset: true });
const DedupeKeySchema = z.string().regex(/^[a-f0-9]{16}$/);

export function validateFeedbackToolInput(
  tool: FeedbackToolName,
  input: FeedbackToolInput,
): FeedbackToolInput {
  return FEEDBACK_TOOL_CONTRACTS[tool].schema.parse(input);
}

export function generateFeedbackDedupeKey(
  tool: FeedbackToolName,
  input: FeedbackToolInput,
): string {
  const canonicalEvidence = [...input.evidence].map(normalizeText).sort();
  const canonical = [
    tool,
    normalizeText(input.title).toLowerCase(),
    normalizeText(input.body).toLowerCase(),
    normalizeText(input.session).toLowerCase(),
    normalizeText(input.source).toLowerCase(),
    input.confidence.toFixed(4),
    ...canonicalEvidence.map((item) => item.toLowerCase()),
  ].join("|");

  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function serializeReport(report: PersistedFeedbackReport): string {
  const lines: string[] = [
    "version=1",
    `id=${report.id}`,
    `tool=${report.tool}`,
    `createdAt=${report.createdAt}`,
    `dedupeKey=${report.dedupeKey}`,
    `title=${report.title}`,
    `body=${report.body}`,
    `session=${report.session}`,
    `source=${report.source}`,
    `confidence=${report.confidence}`,
  ];

  for (const [index, evidenceItem] of report.evidence.entries()) {
    lines.push(`evidence.${index}=${evidenceItem}`);
  }

  return `${lines.join("\n")}\n`;
}

function parseMetadataFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

function parseReportFile(content: string): PersistedFeedbackReport {
  const raw = parseMetadataFile(content);

  const evidence = Object.entries(raw)
    .filter(([key]) => key.startsWith("evidence."))
    .map(([key, value]) => ({
      index: Number.parseInt(key.split(".")[1] ?? "0", 10),
      value,
    }))
    .sort((a, b) => a.index - b.index)
    .map((item) => item.value);

  const tool = raw["tool"];
  if (
    tool !== FEEDBACK_TOOL_NAMES.BUG_REPORT &&
    tool !== FEEDBACK_TOOL_NAMES.IMPROVEMENT_SUGGESTION
  ) {
    throw new Error(`Invalid feedback report tool type: ${tool ?? "unknown"}`);
  }

  const parsedInput = FEEDBACK_TOOL_CONTRACTS[tool].schema.parse({
    title: raw["title"] ?? "",
    body: raw["body"] ?? "",
    evidence,
    session: raw["session"] ?? "",
    source: raw["source"] ?? "",
    confidence: Number(raw["confidence"]),
  });

  return {
    id: ReportIdSchema.parse(raw["id"] ?? ""),
    tool,
    createdAt: ISODateSchema.parse(raw["createdAt"] ?? ""),
    dedupeKey: DedupeKeySchema.parse(raw["dedupeKey"] ?? ""),
    ...parsedInput,
  };
}

function atomicWriteFileSync(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}

function isReportFileName(fileName: string): boolean {
  return /^report_[A-Za-z0-9_-]+\.kv$/.test(fileName);
}

export class FeedbackReportStore {
  constructor(private readonly reportsDir: string) {}

  persist(tool: FeedbackToolName, input: FeedbackToolInput): PersistedFeedbackReport {
    const validated = validateFeedbackToolInput(tool, input);
    const createdAt = new Date().toISOString();
    const dedupeKey = generateFeedbackDedupeKey(tool, validated);
    const id = `report_${createdAt.replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;

    const report: PersistedFeedbackReport = {
      id,
      tool,
      createdAt,
      dedupeKey,
      ...validated,
    };

    mkdirSync(this.reportsDir, { recursive: true });
    const filePath = join(this.reportsDir, `${id}.kv`);
    atomicWriteFileSync(filePath, serializeReport(report));

    return report;
  }

  list(): PersistedFeedbackReport[] {
    if (!existsSync(this.reportsDir)) return [];

    const reports: PersistedFeedbackReport[] = [];
    for (const name of readdirSync(this.reportsDir)) {
      if (!isReportFileName(name)) continue;
      const reportPath = join(this.reportsDir, name);
      let isFile = false;
      try {
        isFile = statSync(reportPath).isFile();
      } catch {
        isFile = false;
      }
      if (!isFile) continue;

      const content = readFileSync(reportPath, "utf-8");
      const parsed = parseReportFile(content);
      reports.push(parsed);
    }

    return reports.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
