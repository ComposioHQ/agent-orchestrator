import { describe, expect, it } from "vitest";
import { appI18n } from "../i18n";
import type { PullRequestFacts, WorkspaceSession } from "../types/workspace";
import {
	derivePRReviewPresentation,
	deriveSessionReviewPresentations,
	openReviewStatesFor,
	reviewIsRunning,
	reviewRunDisabled,
	reviewSessionRunAction,
	sessionReviewsQueryOptions,
	type PRReviewState,
	type ReviewRunFacts,
} from "./session-reviews";
import type { SessionPRSummary } from "../hooks/useSessionScmSummary";

function session(overrides: Partial<WorkspaceSession> = {}): WorkspaceSession {
	return {
		workspaceId: "proj-1",
		workspaceName: "app",
		title: "review work",
		provider: "codex",
		kind: "worker",
		branch: "feature/review-work",
		status: "pr_open",
		updatedAt: "2026-06-10T00:00:00Z",
		prs: [],
		id: "session-1",
		...overrides,
	};
}

describe("sessionReviewsQueryOptions", () => {
	it("owns the shared reviews query key", () => {
		expect(sessionReviewsQueryOptions(session(), true).queryKey).toEqual([
			"session-reviews",
			"session-1",
		]);
	});

	it("lets callers opt into a longer staleTime", () => {
		expect(
			sessionReviewsQueryOptions(session(), true).staleTime,
		).toBeUndefined();
		expect(sessionReviewsQueryOptions(session(), true, 60_000).staleTime).toBe(
			60_000,
		);
	});
});

const pr = (number: number, state: PullRequestFacts["state"] = "open"): PullRequestFacts => ({
	url: `https://github.com/o/r/pull/${number}`,
	number,
	state,
	ci: "passing",
	review: "pending",
	mergeability: "clean",
	reviewComments: false,
	updatedAt: "2026-06-10T00:00:00Z",
});

const reviewState = (number: number, status: PRReviewState["status"]): PRReviewState => ({
	prNumber: number,
	prUrl: `https://github.com/o/r/pull/${number}`,
	status,
	targetSha: "sha",
	title: `PR ${number}`,
});

// The Reviews tab and the command palette both read their eligibility from these
// helpers. They previously lived as a private copy inside SessionInspector, and a
// merge silently re-forked them — pin the behaviour so a second copy can't drift
// back in unnoticed.
describe("shared review eligibility helpers", () => {
	it("keeps only the review states belonging to a session's open PRs", () => {
		const target = session({ prs: [pr(1), pr(2, "draft"), pr(3, "merged")] });
		const states = [reviewState(1, "needs_review"), reviewState(2, "ineligible"), reviewState(3, "up_to_date")];
		expect(openReviewStatesFor(target, states).map((state) => state.prNumber)).toEqual([1]);
	});

	it("reports a running review across the session's open PRs", () => {
		expect(reviewIsRunning([reviewState(1, "needs_review"), reviewState(2, "running")])).toBe(true);
		expect(reviewIsRunning([reviewState(1, "needs_review")])).toBe(false);
	});

	it("disables the run when triggering, with no open states, or with every state ineligible", () => {
		expect(reviewRunDisabled([reviewState(1, "needs_review")], true)).toBe(true);
		expect(reviewRunDisabled([], false)).toBe(true);
		expect(reviewRunDisabled([reviewState(1, "ineligible"), reviewState(2, "ineligible")], false)).toBe(true);
		expect(reviewRunDisabled([reviewState(1, "ineligible"), reviewState(2, "needs_review")], false)).toBe(false);
	});

	it("labels the run action from the shared catalog rather than hardcoded English", () => {
		expect(reviewSessionRunAction([reviewState(1, "needs_review")], true)).toBe(
			appI18n.t("inspector.review.reviewing"),
		);
		expect(reviewSessionRunAction([reviewState(1, "running")], false)).toBe(
			appI18n.t("inspector.review.reviewing"),
		);
		expect(reviewSessionRunAction([reviewState(1, "changes_requested")], false)).toBe(
			appI18n.t("inspector.review.rerun"),
		);
		expect(reviewSessionRunAction([reviewState(1, "needs_review")], false)).toBe(
			appI18n.t("inspector.review.run"),
		);
	});
});

const prSummary = (overrides: Partial<SessionPRSummary> = {}): SessionPRSummary => ({
	additions: 10,
	author: "ada",
	changedFiles: 2,
	ci: { state: "passing", failingChecks: [], autoInjectCI: true },
	deletions: 3,
	headSha: "head-2",
	mergeability: { state: "mergeable", reasons: [], prUrl: "https://github.com/o/r/pull/1" },
	number: 1,
	provider: "github",
	repo: "o/r",
	review: { decision: "none", hasUnresolvedHumanComments: false, unresolvedBy: [] },
	sourceBranch: "feature/reviews",
	state: "open",
	targetBranch: "main",
	title: "Review state model",
	updatedAt: "2026-06-10T00:00:00Z",
	url: "https://github.com/o/r/pull/1",
	...overrides,
});

const run = (overrides: Partial<ReviewRunFacts> = {}): ReviewRunFacts => ({
	autoInjectReview: true,
	batchId: "batch-1",
	body: "review body",
	createdAt: "2026-06-10T00:00:00Z",
	githubReviewId: "review-1",
	harness: "codex",
	id: "run-1",
	prUrl: "https://github.com/o/r/pull/1",
	reviewId: "review-record-1",
	sessionId: "session-1",
	status: "delivered",
	targetSha: "head-2",
	triggerSource: "manual",
	verdict: "approved",
	...overrides,
});

describe("derivePRReviewPresentation", () => {
	it.each([
		{
			name: "draft PR",
			pr: prSummary({ state: "draft" }),
			ao: reviewState(1, "ineligible"),
			want: { progress: "ineligible", attention: "draft" },
		},
		{
			name: "merged PR",
			pr: prSummary({ state: "merged" }),
			ao: reviewState(1, "ineligible"),
			want: { progress: "ineligible", attention: "complete" },
		},
		{
			name: "closed PR",
			pr: prSummary({ state: "closed" }),
			ao: reviewState(1, "ineligible"),
			want: { progress: "ineligible", attention: "closed" },
		},
		{
			name: "running AO review",
			pr: prSummary(),
			ao: { ...reviewState(1, "running"), latestRun: run({ status: "running", verdict: "" }) },
			want: { progress: "running", attention: "review_running" },
		},
		{
			name: "AO changes requested",
			pr: prSummary(),
			ao: { ...reviewState(1, "changes_requested"), latestRun: run({ verdict: "changes_requested" }) },
			want: { progress: "changes_requested", attention: "changes_requested" },
		},
		{
			name: "external unresolved comments",
			pr: prSummary({
				review: {
					decision: "approved",
					hasUnresolvedHumanComments: true,
					unresolvedBy: [{ reviewerId: "lin", count: 1, links: [{ file: "src/a.ts", line: 9, autoInjectReview: true }] }],
				},
			}),
			ao: { ...reviewState(1, "up_to_date"), latestRun: run() },
			want: { progress: "changes_requested", attention: "changes_requested" },
		},
		{
			name: "stale earlier pass",
			pr: prSummary(),
			ao: { ...reviewState(1, "needs_review"), previousRun: run({ targetSha: "head-1" }) },
			want: { progress: "stale", attention: "needs_review" },
		},
		{
			name: "failed AO review",
			pr: prSummary(),
			ao: { ...reviewState(1, "needs_review"), latestRun: run({ status: "failed", verdict: "" }) },
			want: { progress: "failed", attention: "needs_review" },
		},
		{
			name: "cancelled AO review",
			pr: prSummary(),
			ao: { ...reviewState(1, "needs_review"), latestRun: run({ status: "cancelled", verdict: "" }) },
			want: { progress: "cancelled", attention: "needs_review" },
		},
		{
			name: "approved but conflicting",
			pr: prSummary({ mergeability: { state: "conflicting", reasons: ["conflicts"], prUrl: "https://github.com/o/r/pull/1" } }),
			ao: { ...reviewState(1, "up_to_date"), latestRun: run() },
			want: { progress: "approved", attention: "merge_blocked" },
		},
		{
			name: "approved but provider blocked",
			pr: prSummary({ mergeability: { state: "blocked", reasons: ["policy"], prUrl: "https://github.com/o/r/pull/1" } }),
			ao: { ...reviewState(1, "up_to_date"), latestRun: run() },
			want: { progress: "approved", attention: "merge_blocked" },
		},
		{
			name: "approved but CI failing",
			pr: prSummary({ ci: { state: "failing", failingChecks: [], autoInjectCI: true } }),
			ao: { ...reviewState(1, "up_to_date"), latestRun: run() },
			want: { progress: "approved", attention: "ci_failing" },
		},
		{
			name: "approved but CI pending",
			pr: prSummary({ ci: { state: "pending", failingChecks: [], autoInjectCI: true } }),
			ao: { ...reviewState(1, "up_to_date"), latestRun: run() },
			want: { progress: "approved", attention: "waiting_ci" },
		},
		{
			name: "approved and mergeable",
			pr: prSummary({ review: { decision: "approved", hasUnresolvedHumanComments: false, unresolvedBy: [] } }),
			ao: { ...reviewState(1, "up_to_date"), latestRun: run() },
			want: { progress: "approved", attention: "ready_to_merge" },
		},
		{
			name: "provider review required",
			pr: prSummary({ review: { decision: "review_required", hasUnresolvedHumanComments: false, unresolvedBy: [] } }),
			ao: reviewState(1, "needs_review"),
			want: { progress: "review_required", attention: "needs_review" },
		},
		{
			name: "not reviewed",
			pr: prSummary(),
			ao: reviewState(1, "needs_review"),
			want: { progress: "not_started", attention: "needs_review" },
		},
		{
			name: "approved with unknown CI and unstable mergeability",
			pr: prSummary({
				ci: { state: "unknown", failingChecks: [], autoInjectCI: true },
				mergeability: { state: "unstable", reasons: [], prUrl: "https://github.com/o/r/pull/1" },
			}),
			ao: { ...reviewState(1, "up_to_date"), latestRun: run() },
			want: { progress: "approved", attention: "unknown", ci: "unknown", mergeability: "unstable" },
		},
	])("derives $name without collapsing independent facts", ({ pr: summary, ao, want }) => {
		expect(derivePRReviewPresentation(summary, ao, [])).toMatchObject(want);
	});

	it("counts unresolved inline and general comments separately", () => {
		const presentation = derivePRReviewPresentation(
			prSummary({
				review: {
					decision: "changes_requested",
					hasUnresolvedHumanComments: true,
					unresolvedBy: [{
						reviewerId: "lin",
						count: 3,
						links: [
							{ file: "src/a.ts", line: 9, autoInjectReview: true },
							{ url: "https://github.com/o/r/pull/1#discussion", autoInjectReview: false },
						],
					}],
				},
			}),
			reviewState(1, "needs_review"),
			[],
		);
		expect(presentation.comments).toEqual({ unresolved: 3, inline: 1, general: 2 });
	});

	it("requires a positive line number for inline comments", () => {
		const presentation = derivePRReviewPresentation(
			prSummary({
				review: {
					decision: "changes_requested",
					hasUnresolvedHumanComments: true,
					unresolvedBy: [
						{
							reviewerId: "lin",
							count: 3,
							links: [
								{ file: "src/a.ts", line: 0, autoInjectReview: true },
								{ file: "src/b.ts", line: -1, autoInjectReview: true },
								{ file: "src/c.ts", line: 1, autoInjectReview: true },
							],
						},
					],
				},
			}),
			undefined,
			[],
		);

		expect(presentation.comments).toEqual({ unresolved: 3, inline: 1, general: 2 });
	});

	it("counts distinct trigger batches as cycles and derives delivery from the current run", () => {
		const current = run({ batchId: "batch-2", deliveredAt: "2026-06-10T00:02:00Z" });
		const presentation = derivePRReviewPresentation(
			prSummary(),
			{ ...reviewState(1, "up_to_date"), latestRun: current },
			[run(), current, run({ id: "run-3", batchId: "batch-2", harness: "claude-code" })],
		);
		expect(presentation.cycleCount).toBe(2);
		expect(presentation.injection).toBe("delivered");
		expect(presentation.reviewedSha).toBe("head-2");
	});

	it.each([
		{ name: "no run", current: undefined, want: "not_applicable" },
		{ name: "disabled", current: run({ autoInjectReview: false, status: "complete" }), want: "disabled" },
		{ name: "pending delivery", current: run({ status: "complete", deliveredAt: undefined }), want: "pending" },
		{ name: "delivered", current: run({ status: "delivered" }), want: "delivered" },
		{ name: "failed", current: run({ status: "failed" }), want: "failed" },
		{ name: "failed while injection is disabled", current: run({ autoInjectReview: false, status: "failed" }), want: "failed" },
	])("derives injection state for $name", ({ current, want }) => {
		const presentation = derivePRReviewPresentation(
			prSummary(),
			current ? { ...reviewState(1, "up_to_date"), latestRun: current } : reviewState(1, "needs_review"),
			[],
		);
		expect(presentation.injection).toBe(want);
	});

	it("uses each legacy run ID as a cycle when batch IDs are absent", () => {
		const presentation = derivePRReviewPresentation(prSummary(), reviewState(1, "needs_review"), [
			run({ id: "legacy-1", batchId: "" }),
			run({ id: "legacy-2", batchId: "" }),
		]);
		expect(presentation.cycleCount).toBe(2);
	});

	it("preserves bot-only comments without turning approval into human changes requested", () => {
		const presentation = derivePRReviewPresentation(
			prSummary({
				review: {
					decision: "approved",
					hasUnresolvedHumanComments: false,
					unresolvedBy: [{ reviewerId: "review-bot", isBot: true, count: 2, links: [] }],
				},
			}),
			{ ...reviewState(1, "up_to_date"), latestRun: run() },
			[],
		);
		expect(presentation).toMatchObject({ progress: "approved", comments: { unresolved: 2 }, hasExternalReview: true });
	});

	it("is unchanged by duplicate normalized provider review entries", () => {
		const externalReview = {
			autoInjectReview: true,
			body: "approved",
			reviewerId: "lin",
			reviewUrl: "https://github.com/o/r/pull/1#review",
			submittedAt: "2026-06-10T00:00:00Z",
			verdict: "approved" as const,
		};
		const once = derivePRReviewPresentation(
			prSummary({ review: { decision: "approved", hasUnresolvedHumanComments: false, unresolvedBy: [], reviews: [externalReview] } }),
			undefined,
			[],
		);
		const twice = derivePRReviewPresentation(
			prSummary({ review: { decision: "approved", hasUnresolvedHumanComments: false, unresolvedBy: [], reviews: [externalReview, externalReview] } }),
			undefined,
			[],
		);
		expect(twice).toEqual(once);
	});

	it("matches AO states and runs to PRs by canonical URL", () => {
		const secondURL = "https://github.com/another/repo/pull/1";
		const presentations = deriveSessionReviewPresentations(
			[prSummary(), prSummary({ number: 1, url: secondURL, headSha: "head-b" })],
			[reviewState(1, "needs_review"), { ...reviewState(1, "up_to_date"), prUrl: secondURL, latestRun: run({ prUrl: secondURL, targetSha: "head-b" }) }],
			[run(), run({ id: "run-2", batchId: "batch-2", prUrl: secondURL, targetSha: "head-b" })],
		);
		expect(presentations.map(({ prNumber, progress, cycleCount }) => ({ prNumber, progress, cycleCount }))).toEqual([
			{ prNumber: 1, progress: "not_started", cycleCount: 1 },
			{ prNumber: 1, progress: "approved", cycleCount: 1 },
		]);
	});
});
