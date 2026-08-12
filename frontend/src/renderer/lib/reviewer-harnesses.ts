import type { components } from "../../api/schema";

// Reviewers are a narrower vocabulary than worker agents on purpose: a
// reviewer-only tool must not become a valid worker, and the daemon rejects
// anything outside this set.
//
// The set itself comes from the daemon rather than being maintained here. The
// review trigger's request schema is generated from domain.AllReviewerHarnesses,
// so this union IS the server's list; the array below is checked both directions
// to prevent hiding newly-added reviewers.
export type ReviewerHarnessId = NonNullable<components["schemas"]["TriggerReviewRequest"]["harness"]>;

const REVIEWER_HARNESS_IDS = [
	"agy",
	"aider",
	"amp",
	"auggie",
	"autohand",
	"claude-code",
	"codex",
	"cline",
	"continue",
	"copilot",
	"crush",
	"cursor",
	"devin",
	"droid",
	"goose",
	"grok",
	"kilocode",
	"kiro",
	"kimi",
	"kimchi",
	"muse",
	"opencode",
	"pi",
	"qwen",
	"vibe",
] as const satisfies readonly ReviewerHarnessId[];

type UnlistedReviewerHarness = Exclude<ReviewerHarnessId, (typeof REVIEWER_HARNESS_IDS)[number]>;
const _everyReviewerHarnessIsListed: UnlistedReviewerHarness extends never ? true : never = true;
void _everyReviewerHarnessIsListed;

export const KNOWN_REVIEWER_HARNESS_IDS: ReadonlySet<string> = new Set(REVIEWER_HARNESS_IDS);

export function toReviewerHarnessId(value?: string): ReviewerHarnessId | undefined {
	return value && KNOWN_REVIEWER_HARNESS_IDS.has(value) ? (value as ReviewerHarnessId) : undefined;
}

// Mirrors domain.ProjectConfig.ResolveReviewerHarness: with no project reviewer
// configured, only this original, unattended-safe set is inherited from the
// worker's own harness. Every other reviewer requires an explicit choice, so a
// new experimental adapter never silently becomes a project's reviewer. Keep
// this list in step with the daemon's switch — it is deliberately much narrower
// than KNOWN_REVIEWER_HARNESS_IDS.
const WORKER_INHERITED_REVIEWER_IDS: ReadonlySet<string> = new Set([
	"claude-code",
	"codex",
	"opencode",
	"muse",
	"kimchi",
] satisfies readonly ReviewerHarnessId[]);

// The reviewer a worker harness contributes when nothing else names one, or
// undefined when that harness is not inherited and the caller must fall back.
export function inheritedReviewerHarness(worker?: string): ReviewerHarnessId | undefined {
	return worker && WORKER_INHERITED_REVIEWER_IDS.has(worker) ? (worker as ReviewerHarnessId) : undefined;
}
