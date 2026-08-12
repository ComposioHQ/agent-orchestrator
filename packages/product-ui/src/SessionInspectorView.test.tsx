import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	InspectorActivityTimelineView,
	InspectorPullRequestCardView,
	InspectorReviewsView,
	SessionInspectorShellView,
	type InspectorReviewLabels,
} from "./SessionInspectorView";
import type { ExternalLinkProps } from "./external-link";

function ExternalLink({ ariaLabel, children, stopPropagation, ...props }: ExternalLinkProps) {
	return (
		<a
			{...props}
			aria-label={ariaLabel}
			onClick={stopPropagation ? (event) => event.stopPropagation() : undefined}
		>
			{children}
		</a>
	);
}

const tabs = [
	{ id: "summary" as const, icon: <svg />, label: "Summary" },
	{ badge: true, id: "browser" as const, icon: <svg />, label: "Browser" },
	{ displayLabel: "2 Files", id: "files" as const, icon: <svg />, label: "Files" },
];

describe("SessionInspectorShellView", () => {
	it("preserves the tab semantics, responsive labels, badge, and host slots", () => {
		const onViewChange = vi.fn();
		const { rerender } = render(
			<SessionInspectorShellView
				activeView="summary"
				ariaLabel="Session inspector"
				browserPoppedOut={false}
				browserView={<div role="tabpanel">browser slot</div>}
				filesView={<div role="tabpanel">files slot</div>}
				onViewChange={onViewChange}
				summaryView={<div role="tabpanel">summary slot</div>}
				tabs={tabs}
			/>,
		);

		expect(screen.getByRole("complementary", { name: "Session inspector" })).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "Summary" })).toHaveAttribute("aria-selected", "true");
		expect(screen.getByRole("tab", { name: "Summary" })).toHaveAttribute("tabindex", "0");
		expect(screen.getByRole("tab", { name: "Browser" })).toHaveAttribute("tabindex", "-1");
		expect(within(screen.getByRole("tab", { name: "Files" })).getByText("2 Files")).toHaveClass(
			"@max-[350px]/inspector:hidden",
		);
		expect(screen.getByTestId("browser-unseen-indicator")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("tab", { name: "Browser" }));
		expect(onViewChange).toHaveBeenCalledWith("browser");
		fireEvent.keyDown(screen.getByRole("tab", { name: "Summary" }), { key: "ArrowRight" });
		expect(onViewChange).toHaveBeenLastCalledWith("browser");
		expect(screen.getByRole("tab", { name: "Browser" })).toHaveFocus();

		rerender(
			<SessionInspectorShellView
				activeView="browser"
				ariaLabel="Session inspector"
				browserPoppedOut={false}
				browserView={<div role="tabpanel">browser slot</div>}
				onViewChange={onViewChange}
				summaryView={<div role="tabpanel">summary slot</div>}
				tabs={tabs}
			/>,
		);
		const body = screen.getByRole("tablist").nextElementSibling;
		expect(body).toHaveClass("session-inspector__body--browser", "p-0", "overflow-hidden");
		expect(body).not.toHaveClass("p-3");
		expect(screen.getByText("browser slot")).toBeInTheDocument();
	});

	it("renders the loading state without tab chrome", () => {
		render(
			<SessionInspectorShellView
				activeView="summary"
				ariaLabel="Session inspector"
				browserPoppedOut={false}
				loadingText="Loading session…"
				onViewChange={vi.fn()}
				tabs={tabs}
			/>,
		);
		expect(screen.getByText("Loading session…")).toHaveClass("text-settings-muted");
		expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
	});
});

describe("portable inspector presentations", () => {
	it("renders PR facts and host-owned actions from a neutral view model", () => {
		render(
			<InspectorPullRequestCardView
				countNounLabel={(count, noun) => `${count} ${noun}s`}
				externalLink={ExternalLink}
				mergeAction={<button type="button">Merge</button>}
				openLabel="Open PR #12"
				pr={{
					additions: 4,
					author: "ada",
					card: {
						primary: { key: "merge", label: "Ready to merge", links: [], tone: "success" },
						supporting: [],
					},
					changedFiles: 2,
					deletions: 1,
					href: "https://example.com/pull/12",
					number: 12,
					provider: "github",
					sourceBranch: "feature",
					state: "open",
					stateLabel: "open",
					targetBranch: "main",
					title: "Portable inspector",
				}}
			/>,
		);
		expect(screen.getByRole("link", { name: "Portable inspector" })).toHaveAttribute(
			"href",
			"https://example.com/pull/12",
		);
		expect(screen.getByRole("link", { name: "Open PR #12" })).toBeInTheDocument();
		expect(screen.getByText("Ready to merge")).toHaveClass("text-success");
		expect(screen.getByRole("button", { name: "Merge" })).toBeInTheDocument();
	});

	it("renders timeline events with current-state marker treatment", () => {
		render(
			<InspectorActivityTimelineView
				events={[
					{
						content: <span>Working</span>,
						markerBreathe: true,
						markerTone: "#60a5fa",
						timestamp: null,
						tone: "now",
					},
					{ content: <span>Created workspace</span>, timestamp: "2h ago", tone: "neutral" },
				]}
			/>,
		);
		const events = screen.getAllByTestId("inspector-timeline-event");
		expect(events).toHaveLength(2);
		expect(events[0].querySelector(".animate-status-pulse")).toHaveStyle({ background: "#60a5fa" });
		expect(screen.getByText("2h ago")).toHaveClass("font-mono", "text-passive");
	});

	it("owns grouped review disclosure while the host supplies markdown and assets", () => {
		const renderAvatar = vi.fn((harness: string) => <span data-testid="avatar">{harness}</span>);
		const renderMarkdown = vi.fn((body: string) => <p>{body}</p>);
		render(
			<InspectorReviewsView
				externalLink={ExternalLink}
				groups={[
					{
						ao: {
							notInjected: true,
							runs: [
								{
									body: "Looks good.",
									createdAtLabel: "5m ago",
									harness: "codex",
									id: "run-1",
									status: "delivered",
									url: "https://example.com/review",
									verdict: { label: "Approved", tone: "success" },
								},
							],
						},
						github: {
							entries: [
								{
									body: "Ship it.",
									id: "github-review-1",
									isBot: true,
									reviewerId: "review-bot",
									submittedAt: "2026-08-09T10:00:00Z",
									submittedAtLabel: "5m ago",
									verdict: { label: "Approved", tone: "success" },
								},
							],
							unresolved: 0,
							unresolvedBy: [],
						},
						meta: "#12 · 5m ago",
						number: 12,
						title: "Portable inspector",
						verdict: { label: "Approved", tone: "success" },
					},
				]}
				isLoading={false}
				labels={reviewLabels}
				renderAvatar={renderAvatar}
				renderMarkdown={renderMarkdown}
			/>,
		);

		const row = screen.getByTestId("review-pr-row");
		expect(row).not.toHaveAttribute("aria-expanded");
		expect(screen.getByText("Looks good.")).toBeInTheDocument();
		expect(screen.getByText("Ship it.")).toBeInTheDocument();
		expect(screen.getByText("Not injected")).toBeInTheDocument();
		expect(renderAvatar).toHaveBeenCalledWith("codex");
		expect(renderMarkdown).toHaveBeenCalledTimes(2);
	});

	it("shows the newest GitHub review when history prepends", () => {
		const olderBody = "Older review ".repeat(30).trim();
		const newerBody = "Newer review ".repeat(30).trim();
		const olderReview = {
			body: olderBody,
			id: "github-review-old",
			reviewerId: "ada",
			submittedAt: "2026-08-09T10:00:00Z",
			submittedAtLabel: "10m ago",
			verdict: { label: "Changes requested", tone: "danger" as const },
		};
		const group = (entries: typeof olderReview[]) => [
			{
				github: { entries, unresolved: 0, unresolvedBy: [] },
				meta: "#12",
				number: 12,
				title: "Portable inspector",
			},
		];
		const view = (entries: typeof olderReview[]) => (
			<InspectorReviewsView
				externalLink={ExternalLink}
				groups={group(entries)}
				isLoading={false}
				labels={reviewLabels}
				renderAvatar={() => null}
				renderMarkdown={(body) => <p>{body}</p>}
			/>
		);
		const { rerender } = render(view([olderReview]));
		fireEvent.click(screen.getByRole("button", { name: "Show more" }));

		const olderSummary = screen.getByText(olderBody).closest('[data-testid="github-review-summary"]');
		expect(olderSummary).not.toHaveClass("line-clamp-4");

		rerender(
			view([
				{
					...olderReview,
					body: newerBody,
					id: "github-review-new",
					reviewerId: "grace",
					submittedAt: "2026-08-09T11:00:00Z",
					submittedAtLabel: "Now",
				},
				olderReview,
			]),
		);

		expect(screen.queryByText(olderBody)).not.toBeInTheDocument();
		expect(screen.getByText(newerBody).closest('[data-testid="github-review-summary"]')).toHaveClass(
			"line-clamp-4",
		);
	});
});

const reviewLabels: InspectorReviewLabels = {
	aoSource: "AO",
	bot: "Bot",
	earlierPass: "Earlier pass",
	githubSource: "On GitHub",
	loadingReviews: "Loading reviews",
	loadMoreReviews: (count) => `Load ${count} more`,
	noPastReviewSummaries: "No summaries",
	notInjected: "Not injected",
	openComments: "Open comments",
	reviews: "Reviews",
	showLatestReviewOnly: "Show latest only",
	showLess: "Show less",
	showMore: "Show more",
	commentNumber: (number) => `Comment ${number}`,
	unresolvedCount: (count) => `${count} unresolved`,
	viewOnPR: "View on PR",
};
