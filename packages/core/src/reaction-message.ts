import type { AutomatedComment, CICheck, ReviewComment, Runtime, SCM, Session } from "./types.js";

const MAX_CHECKS = 4;
const MAX_COMMENTS = 3;
const MAX_COMMENT_CHARS = 160;
const MAX_OUTPUT_CHARS = 320;
const MAX_MESSAGE_CHARS = 2_400;

export interface ReactionMessageContext {
  reactionKey: string;
  fallbackMessage: string;
  session: Session;
  scm: SCM | null;
  runtime: Runtime | null;
}

function truncateText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatLocation(path?: string, line?: number): string {
  if (!path) return "general";
  return typeof line === "number" ? `${path}:${line}` : path;
}

function withCount(total: number, limit: number): string {
  if (total <= limit) return String(total);
  return `${limit} of ${total}`;
}

async function safeCall<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function asArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function buildOutputSnippet(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const lines = trimmed.split("\n");
  const tail = lines.slice(-8).join("\n");
  if (tail.length <= MAX_OUTPUT_CHARS) return tail;
  return `${tail.slice(0, Math.max(0, MAX_OUTPUT_CHARS - 13)).trimEnd()}\n...(truncated)`;
}

function clampMessage(message: string, fallback: string): string {
  if (!message.trim()) return fallback;
  if (message.length <= MAX_MESSAGE_CHARS) return message;
  const suffix = "\n\n...(message truncated)";
  return `${message.slice(0, Math.max(0, MAX_MESSAGE_CHARS - suffix.length)).trimEnd()}${suffix}`;
}

function formatCheck(check: CICheck): string {
  const status = check.status === "failed" ? "failed" : check.status;
  const name = truncateText(singleLine(check.name), 80);
  const url = check.url ? ` ${truncateText(check.url, 120)}` : "";
  return `- ${name} [${status}]${url}`;
}

function formatReviewComment(comment: ReviewComment): string {
  const excerpt = truncateText(singleLine(comment.body), MAX_COMMENT_CHARS);
  const location = formatLocation(comment.path, comment.line);
  const url = comment.url ? ` ${truncateText(comment.url, 120)}` : "";
  return `- ${comment.author} @ ${location}: "${excerpt}"${url}`;
}

function formatAutomatedComment(comment: AutomatedComment): string {
  const excerpt = truncateText(singleLine(comment.body), MAX_COMMENT_CHARS);
  const location = formatLocation(comment.path, comment.line);
  const url = comment.url ? ` ${truncateText(comment.url, 120)}` : "";
  return `- [${comment.severity}] ${comment.botName} @ ${location}: "${excerpt}"${url}`;
}

function formatSteps(steps: string[]): string[] {
  return steps.map((step, index) => `${index + 1}. ${step}`);
}

async function getRuntimeOutputSnippet(runtime: Runtime | null, session: Session): Promise<string | null> {
  if (!runtime || !session.runtimeHandle) return null;
  const output = await safeCall(() => runtime.getOutput(session.runtimeHandle!, 80), "");
  return buildOutputSnippet(output);
}

async function buildCIFailedMessage(
  fallbackMessage: string,
  session: Session,
  scm: SCM,
  runtime: Runtime | null,
): Promise<string> {
  if (!session.pr) return fallbackMessage;

  const [checksRaw, commentsRaw, outputSnippet] = await Promise.all([
    safeCall(() => scm.getCIChecks(session.pr!), [] as CICheck[]),
    safeCall(() => scm.getPendingComments(session.pr!), [] as ReviewComment[]),
    getRuntimeOutputSnippet(runtime, session),
  ]);

  const checks = asArray(checksRaw);
  const comments = asArray(commentsRaw).filter((comment) => !comment.isResolved);
  const failingChecks = checks.filter((check) => check.status === "failed");
  const shownChecks = failingChecks.slice(0, MAX_CHECKS);
  const shownComments = comments.slice(0, MAX_COMMENTS);

  if (shownChecks.length === 0 && shownComments.length === 0) return fallbackMessage;

  const lines: string[] = [
    `CI failed for PR #${session.pr.number}: ${truncateText(singleLine(session.pr.title), 120)}`,
    "",
  ];

  if (shownChecks.length > 0) {
    lines.push(`Failing checks (${withCount(failingChecks.length, MAX_CHECKS)}):`);
    lines.push(...shownChecks.map(formatCheck));
    lines.push("");
  }

  if (shownComments.length > 0) {
    lines.push(`Top unresolved review comments (${withCount(comments.length, MAX_COMMENTS)}):`);
    lines.push(...shownComments.map(formatReviewComment));
    lines.push("");
  }

  const steps: string[] = [];
  if (shownChecks.length > 0) {
    steps.push("Fix failing CI checks in the order listed above.");
  }
  if (shownComments.length > 0) {
    steps.push("After CI is green, address unresolved review comments and push follow-up commits.");
    steps.push("Reply on each review thread once fixes are pushed.");
  }
  steps.push("Run `gh pr checks` to confirm CI is passing.");

  lines.push("Recommended fix order:");
  lines.push(...formatSteps(steps));

  if (outputSnippet) {
    lines.push("");
    lines.push("Recent terminal output (truncated):");
    lines.push(outputSnippet);
  }

  return clampMessage(lines.join("\n"), fallbackMessage);
}

async function buildChangesRequestedMessage(
  fallbackMessage: string,
  session: Session,
  scm: SCM,
): Promise<string> {
  if (!session.pr) return fallbackMessage;

  const [commentsRaw, checksRaw] = await Promise.all([
    safeCall(() => scm.getPendingComments(session.pr!), [] as ReviewComment[]),
    safeCall(() => scm.getCIChecks(session.pr!), [] as CICheck[]),
  ]);

  const comments = asArray(commentsRaw).filter((comment) => !comment.isResolved);
  const shownComments = comments.slice(0, MAX_COMMENTS);
  const failingChecks = asArray(checksRaw).filter((check) => check.status === "failed");
  const shownChecks = failingChecks.slice(0, MAX_CHECKS);

  if (shownComments.length === 0 && shownChecks.length === 0) return fallbackMessage;

  const lines: string[] = [
    `Changes requested on PR #${session.pr.number}: ${truncateText(singleLine(session.pr.title), 120)}`,
    "",
  ];

  if (shownChecks.length > 0) {
    lines.push(`Still-failing CI checks (${withCount(failingChecks.length, MAX_CHECKS)}):`);
    lines.push(...shownChecks.map(formatCheck));
    lines.push("");
  }

  if (shownComments.length > 0) {
    lines.push(`Unresolved review comments (${withCount(comments.length, MAX_COMMENTS)}):`);
    lines.push(...shownComments.map(formatReviewComment));
    lines.push("");
  }

  const steps: string[] = [];
  if (shownChecks.length > 0) {
    steps.push("Fix failing CI checks first so review validation can proceed cleanly.");
  }
  if (shownComments.length > 0) {
    steps.push("Address unresolved review comments in the order listed above.");
  }
  steps.push("Push the fixes and reply on each updated review thread.");
  steps.push("Run `gh pr checks` to verify all checks are green.");

  lines.push("Recommended fix order:");
  lines.push(...formatSteps(steps));

  return clampMessage(lines.join("\n"), fallbackMessage);
}

async function buildAutomatedReviewMessage(
  fallbackMessage: string,
  session: Session,
  scm: SCM,
): Promise<string> {
  if (!session.pr) return fallbackMessage;

  const comments = asArray(
    await safeCall(() => scm.getAutomatedComments(session.pr!), [] as AutomatedComment[]),
  );
  if (comments.length === 0) return fallbackMessage;

  const severityRank: Record<AutomatedComment["severity"], number> = {
    error: 0,
    warning: 1,
    info: 2,
  };
  const sorted = [...comments].sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  const shown = sorted.slice(0, MAX_COMMENTS);

  const lines: string[] = [
    `Automated review feedback on PR #${session.pr.number}: ${truncateText(singleLine(session.pr.title), 120)}`,
    "",
    `Top bot findings (${withCount(sorted.length, MAX_COMMENTS)}):`,
    ...shown.map(formatAutomatedComment),
    "",
    "Recommended fix order:",
  ];

  const steps: string[] = [];
  if (sorted.some((comment) => comment.severity === "error")) {
    steps.push("Fix error-severity findings first.");
  }
  if (sorted.some((comment) => comment.severity === "warning")) {
    steps.push("Then fix warning-level findings.");
  }
  steps.push("Re-run tests/checks and push updates.");

  lines.push(...formatSteps(steps));

  return clampMessage(lines.join("\n"), fallbackMessage);
}

export async function buildReactionMessage(ctx: ReactionMessageContext): Promise<string> {
  if (!ctx.fallbackMessage) return "";
  if (!ctx.session.pr || !ctx.scm) return ctx.fallbackMessage;

  switch (ctx.reactionKey) {
    case "ci-failed":
      return buildCIFailedMessage(ctx.fallbackMessage, ctx.session, ctx.scm, ctx.runtime);
    case "changes-requested":
      return buildChangesRequestedMessage(ctx.fallbackMessage, ctx.session, ctx.scm);
    case "bugbot-comments":
      return buildAutomatedReviewMessage(ctx.fallbackMessage, ctx.session, ctx.scm);
    default:
      return ctx.fallbackMessage;
  }
}
