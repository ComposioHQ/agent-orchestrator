import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { parseKeyValueContent } from "./key-value.js";

export type ReviewThreadSource = "human" | "bugbot" | "other";
export type ReviewThreadSeverity = "high" | "medium" | "low" | "unknown";
export type ReviewThreadStatus = "open" | "resolved";
export type ResolutionType = "fixed" | "already_fixed" | "not_actionable" | "duplicate";
export type ResolutionActorType = "agent" | "human";
export type VerificationStatus = "pending" | "pass" | "fail";

export interface ReviewThreadSnapshot {
  prNumber: number;
  threadId: string;
  source: ReviewThreadSource;
  path?: string;
  bodyHash: string;
  severity: ReviewThreadSeverity;
  status: ReviewThreadStatus;
  capturedAt: Date;
}

export interface ResolutionEvidence {
  changedFiles: string[];
  testCommands: string[];
  testResults: string[];
}

export interface ResolutionRecord {
  id: string;
  prNumber: number;
  threadId: string;
  resolutionType: ResolutionType;
  actorType: ResolutionActorType;
  actorId: string;
  fixCommitSha?: string;
  evidence: ResolutionEvidence;
  rationale?: string;
  verificationStatus: VerificationStatus;
  verificationNotes: string[];
  verifiedHeadSha?: string;
  appliedAt?: Date;
  createdAt: Date;
}

export interface IntegrityBlocker {
  code:
    | "THREAD_UNRESOLVED"
    | "THREAD_SNAPSHOTS_UNAVAILABLE"
    | "MISSING_RESOLUTION"
    | "UNVERIFIED_RESOLUTION"
    | "INVALID_RESOLUTION"
    | "VERIFICATION_DRIFT"
    | "REQUIRED_CHECK_MISSING"
    | "REQUIRED_CHECK_NOT_PASSING";
  message: string;
  threadId?: string;
  checkName?: string;
}

export interface ReviewIntegrityEvaluation {
  status: "pass" | "fail";
  unresolvedThreadCount: number;
  unverifiedResolvedThreadCount: number;
  blockers: IntegrityBlocker[];
}

function blockerCodeForValidationMessage(message: string): IntegrityBlocker["code"] {
  return message.includes("invalidated by new commit")
    ? "VERIFICATION_DRIFT"
    : "INVALID_RESOLUTION";
}

export interface MergeGuardEvaluation {
  allowMerge: boolean;
  reviewIntegrityStatus: "pass" | "fail";
  blockers: IntegrityBlocker[];
}

export interface ResolutionValidationOptions {
  requireEvidenceForBotThreads?: boolean;
  currentHeadSha?: string;
  isCommitReachable?: (sha: string) => boolean;
  getCommitTimestamp?: (sha: string) => Date | null;
}

const DEFAULT_EVIDENCE: ResolutionEvidence = {
  changedFiles: [],
  testCommands: [],
  testResults: [],
};

function normalizeRecord(record: ResolutionRecord): ResolutionRecord {
  return {
    ...record,
    evidence: {
      changedFiles: [...(record.evidence?.changedFiles ?? [])],
      testCommands: [...(record.evidence?.testCommands ?? [])],
      testResults: [...(record.evidence?.testResults ?? [])],
    },
    verificationNotes: [...(record.verificationNotes ?? [])],
  };
}

function recordFileName(id: string): string {
  return `${id}.kv`;
}

function isRecordFileName(name: string): boolean {
  return /^resolution_[A-Za-z0-9_-]+\.kv$/.test(name);
}

function normalizeText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function encodeValue(value: string): string {
  return encodeURIComponent(value);
}

function decodeValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function serializeRecord(record: ResolutionRecord): string {
  const lines: string[] = [
    "version=1",
    `id=${encodeValue(record.id)}`,
    `prNumber=${record.prNumber}`,
    `threadId=${encodeValue(record.threadId)}`,
    `resolutionType=${record.resolutionType}`,
    `actorType=${record.actorType}`,
    `actorId=${encodeValue(record.actorId)}`,
    `verificationStatus=${record.verificationStatus}`,
    `createdAt=${record.createdAt.toISOString()}`,
  ];

  if (record.fixCommitSha) lines.push(`fixCommitSha=${encodeValue(record.fixCommitSha)}`);
  if (record.rationale) lines.push(`rationale=${encodeValue(record.rationale)}`);
  if (record.verifiedHeadSha) lines.push(`verifiedHeadSha=${encodeValue(record.verifiedHeadSha)}`);
  if (record.appliedAt) lines.push(`appliedAt=${record.appliedAt.toISOString()}`);

  for (const [i, file] of record.evidence.changedFiles.entries()) {
    lines.push(`evidence.changedFiles.${i}=${encodeValue(file)}`);
  }
  for (const [i, cmd] of record.evidence.testCommands.entries()) {
    lines.push(`evidence.testCommands.${i}=${encodeValue(cmd)}`);
  }
  for (const [i, result] of record.evidence.testResults.entries()) {
    lines.push(`evidence.testResults.${i}=${encodeValue(result)}`);
  }
  for (const [i, note] of record.verificationNotes.entries()) {
    lines.push(`verificationNotes.${i}=${encodeValue(note)}`);
  }

  return `${lines.join("\n")}\n`;
}

function parseIndexedValues(raw: Record<string, string>, prefix: string): string[] {
  return Object.entries(raw)
    .filter(([k]) => k.startsWith(prefix))
    .map(([k, v]) => ({ index: Number.parseInt(k.slice(prefix.length), 10), value: v }))
    .filter((x) => Number.isFinite(x.index) && x.index >= 0)
    .sort((a, b) => a.index - b.index)
    .map((x) => decodeValue(x.value) ?? "");
}

function parseRecord(content: string): ResolutionRecord {
  const raw = parseKeyValueContent(content);
  const createdAt = new Date(raw["createdAt"] ?? "");
  const appliedAtRaw = raw["appliedAt"];
  const appliedAt = appliedAtRaw ? new Date(appliedAtRaw) : undefined;

  const status = raw["verificationStatus"];
  const verificationStatus: VerificationStatus =
    status === "pass" || status === "fail" || status === "pending" ? status : "pending";

  const parsedResolutionTypeRaw = raw["resolutionType"];
  const resolutionType: ResolutionType =
    parsedResolutionTypeRaw === "fixed" ||
    parsedResolutionTypeRaw === "already_fixed" ||
    parsedResolutionTypeRaw === "not_actionable" ||
    parsedResolutionTypeRaw === "duplicate"
      ? parsedResolutionTypeRaw
      : "not_actionable";

  const parsedActorTypeRaw = raw["actorType"];
  const actorType: ResolutionActorType =
    parsedActorTypeRaw === "agent" || parsedActorTypeRaw === "human" ? parsedActorTypeRaw : "agent";

  const verificationNotes = parseIndexedValues(raw, "verificationNotes.");
  if (parsedResolutionTypeRaw && parsedResolutionTypeRaw !== resolutionType) {
    verificationNotes.push(`invalid resolutionType in record: ${parsedResolutionTypeRaw}`);
  }
  if (parsedActorTypeRaw && parsedActorTypeRaw !== actorType) {
    verificationNotes.push(`invalid actorType in record: ${parsedActorTypeRaw}`);
  }

  return {
    id: decodeValue(raw["id"]) ?? `resolution_${Date.now()}_${randomUUID().slice(0, 8)}`,
    prNumber: Number.parseInt(raw["prNumber"] ?? "0", 10),
    threadId: decodeValue(raw["threadId"]) ?? "",
    resolutionType,
    actorType,
    actorId: decodeValue(raw["actorId"]) ?? "unknown",
    fixCommitSha: normalizeText(decodeValue(raw["fixCommitSha"])),
    rationale: normalizeText(decodeValue(raw["rationale"])),
    evidence: {
      changedFiles: parseIndexedValues(raw, "evidence.changedFiles."),
      testCommands: parseIndexedValues(raw, "evidence.testCommands."),
      testResults: parseIndexedValues(raw, "evidence.testResults."),
    },
    verificationStatus,
    verificationNotes,
    verifiedHeadSha: normalizeText(decodeValue(raw["verifiedHeadSha"])),
    appliedAt: appliedAt && !Number.isNaN(appliedAt.getTime()) ? appliedAt : undefined,
    createdAt: Number.isNaN(createdAt.getTime()) ? new Date() : createdAt,
  };
}

export class ReviewResolutionStore {
  constructor(private readonly recordsDir: string) {}

  persist(
    input: Omit<ResolutionRecord, "id" | "createdAt"> & { id?: string; createdAt?: Date },
  ): ResolutionRecord {
    const id =
      input.id ??
      `resolution_${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
    const createdAt = input.createdAt ?? new Date();
    const record = normalizeRecord({ ...input, id, createdAt });

    mkdirSync(this.recordsDir, { recursive: true });
    atomicWriteFileSync(join(this.recordsDir, recordFileName(record.id)), serializeRecord(record));
    return record;
  }

  list(prNumber?: number): ResolutionRecord[] {
    if (!existsSync(this.recordsDir)) return [];
    const records: ResolutionRecord[] = [];

    for (const name of readdirSync(this.recordsDir)) {
      if (!isRecordFileName(name)) continue;
      const path = join(this.recordsDir, name);
      try {
        if (!statSync(path).isFile()) continue;
        const parsed = parseRecord(readFileSync(path, "utf-8"));
        if (prNumber !== undefined && parsed.prNumber !== prNumber) continue;
        records.push(parsed);
      } catch {
        continue;
      }
    }

    return records.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  latestByThread(prNumber: number): Map<string, ResolutionRecord> {
    const map = new Map<string, ResolutionRecord>();
    for (const record of this.list(prNumber)) {
      map.set(record.threadId, record);
    }
    return map;
  }
}

function hasEvidence(record: ResolutionRecord): boolean {
  return (
    record.evidence.changedFiles.length > 0 ||
    record.evidence.testCommands.length > 0 ||
    record.evidence.testResults.length > 0
  );
}

export function validateResolutionRecord(
  record: ResolutionRecord,
  thread: ReviewThreadSnapshot | undefined,
  opts: ResolutionValidationOptions = {},
): string[] {
  const blockers: string[] = [];
  const requireEvidenceForBotThreads = opts.requireEvidenceForBotThreads ?? true;
  const rationale = normalizeText(record.rationale);

  if (record.resolutionType === "fixed") {
    if (!record.fixCommitSha) blockers.push("fixed requires fixCommitSha");
    if (
      record.fixCommitSha &&
      opts.isCommitReachable &&
      !opts.isCommitReachable(record.fixCommitSha)
    ) {
      blockers.push("fixCommitSha is not reachable from PR head");
    }
    if (record.evidence.testResults.length === 0) {
      blockers.push("fixed requires verification test results");
    }
    if (record.evidence.changedFiles.length === 0 && !rationale) {
      blockers.push("fixed requires changedFiles evidence or rationale mapping");
    }
  }

  if (record.resolutionType === "already_fixed") {
    if (!record.fixCommitSha) blockers.push("already_fixed requires fixCommitSha");
    if (
      record.fixCommitSha &&
      opts.isCommitReachable &&
      !opts.isCommitReachable(record.fixCommitSha)
    ) {
      blockers.push("already_fixed commit is not reachable from PR head");
    }
    if (record.fixCommitSha && opts.getCommitTimestamp) {
      const commitTs = opts.getCommitTimestamp(record.fixCommitSha);
      if (!commitTs) {
        blockers.push("already_fixed commit timestamp could not be determined");
      } else if (commitTs.getTime() > record.createdAt.getTime()) {
        blockers.push("already_fixed commit must predate resolution action");
      }
    }
  }

  if (record.resolutionType === "not_actionable" || record.resolutionType === "duplicate") {
    if (!rationale) blockers.push(`${record.resolutionType} requires rationale`);
  }

  if (
    thread?.source === "bugbot" &&
    requireEvidenceForBotThreads &&
    !hasEvidence(record) &&
    !rationale
  ) {
    blockers.push("bot thread resolution requires evidence or rationale");
  }

  if (
    record.verifiedHeadSha &&
    opts.currentHeadSha &&
    record.verifiedHeadSha !== opts.currentHeadSha
  ) {
    blockers.push("verification invalidated by new commit");
  }

  return blockers;
}

export function evaluateReviewIntegrity(
  threads: ReviewThreadSnapshot[],
  recordsByThread: Map<string, ResolutionRecord>,
  opts: ResolutionValidationOptions = {},
): ReviewIntegrityEvaluation {
  const blockers: IntegrityBlocker[] = [];
  let unresolvedThreadCount = 0;
  let unverifiedResolvedThreadCount = 0;

  for (const thread of threads) {
    if (thread.status === "open") {
      unresolvedThreadCount += 1;
      blockers.push({
        code: "THREAD_UNRESOLVED",
        threadId: thread.threadId,
        message: `Thread ${thread.threadId} is unresolved`,
      });
      continue;
    }

    const record = recordsByThread.get(thread.threadId);
    if (!record) {
      unverifiedResolvedThreadCount += 1;
      blockers.push({
        code: "MISSING_RESOLUTION",
        threadId: thread.threadId,
        message: `Resolved thread ${thread.threadId} has no ResolutionRecord`,
      });
      continue;
    }

    if (record.verificationStatus !== "pass") {
      unverifiedResolvedThreadCount += 1;
      blockers.push({
        code: "UNVERIFIED_RESOLUTION",
        threadId: thread.threadId,
        message: `Thread ${thread.threadId} resolution is not verified`,
      });
      continue;
    }

    const validationBlockers = validateResolutionRecord(record, thread, opts);
    if (validationBlockers.length > 0) {
      unverifiedResolvedThreadCount += 1;
      for (const b of validationBlockers) {
        blockers.push({
          code: blockerCodeForValidationMessage(b),
          threadId: thread.threadId,
          message: b,
        });
      }
    }
  }

  return {
    status: blockers.length === 0 ? "pass" : "fail",
    unresolvedThreadCount,
    unverifiedResolvedThreadCount,
    blockers,
  };
}

export interface MergeGuardInput {
  integrity: ReviewIntegrityEvaluation;
  requiredChecks: string[];
  checkConclusions: Map<string, "passed" | "pending" | "failed" | "missing">;
}

export function evaluateMergeGuard(input: MergeGuardInput): MergeGuardEvaluation {
  const blockers: IntegrityBlocker[] = [...input.integrity.blockers];

  for (const requiredCheck of input.requiredChecks) {
    const status = input.checkConclusions.get(requiredCheck) ?? "missing";
    if (status === "missing") {
      blockers.push({
        code: "REQUIRED_CHECK_MISSING",
        checkName: requiredCheck,
        message: `Required check "${requiredCheck}" is missing`,
      });
      continue;
    }
    if (status !== "passed") {
      blockers.push({
        code: "REQUIRED_CHECK_NOT_PASSING",
        checkName: requiredCheck,
        message: `Required check "${requiredCheck}" is ${status}`,
      });
    }
  }

  return {
    allowMerge: blockers.length === 0,
    reviewIntegrityStatus: input.integrity.status,
    blockers,
  };
}

export function createResolutionRecord(input: {
  prNumber: number;
  threadId: string;
  resolutionType: ResolutionType;
  actorType: ResolutionActorType;
  actorId: string;
  fixCommitSha?: string;
  evidence?: Partial<ResolutionEvidence>;
  rationale?: string;
}): Omit<ResolutionRecord, "id" | "createdAt"> {
  return {
    prNumber: input.prNumber,
    threadId: input.threadId,
    resolutionType: input.resolutionType,
    actorType: input.actorType,
    actorId: input.actorId,
    fixCommitSha: normalizeText(input.fixCommitSha),
    evidence: {
      changedFiles: [...(input.evidence?.changedFiles ?? DEFAULT_EVIDENCE.changedFiles)],
      testCommands: [...(input.evidence?.testCommands ?? DEFAULT_EVIDENCE.testCommands)],
      testResults: [...(input.evidence?.testResults ?? DEFAULT_EVIDENCE.testResults)],
    },
    rationale: normalizeText(input.rationale),
    verificationStatus: "pending",
    verificationNotes: [],
  };
}
