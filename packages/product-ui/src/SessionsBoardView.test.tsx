import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	SessionCardView,
	SessionsArchiveView,
	SessionsBoardGridView,
	type BoardSessionPresentation,
	type BoardSplitLaneLabels,
} from "./SessionsBoardView";
import {
	boardAttentionZoneOrder,
	getAttentionZoneViewForZone,
} from "./session-presentation";
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

const splitLabels: BoardSplitLaneLabels = {
	columnAria: (label) => `${label} sessions`,
	countSessions: (count, label) => `${count} ${label} session${count === 1 ? "" : "s"}`,
	idleWorkingAria: "Idle / Working sessions",
	laneSummary: (primary, secondary) => `${primary} / ${secondary} lane summary`,
	readyMergedAria: "Ready / Merged sessions",
	tones: {
		idle: { countLabel: "idle", label: "Idle", regionLabel: "Idle sessions" },
		working: { countLabel: "working", label: "Working", regionLabel: "Working sessions" },
		ready: { countLabel: "ready", label: "Ready", regionLabel: "Ready sessions" },
		merged: { countLabel: "merged", label: "Merged", regionLabel: "Merged sessions" },
	},
};

const baseSession: BoardSessionPresentation = {
	id: "session-1",
	provider: "codex",
	status: "idle",
	title: "portable task",
	updatedAt: "2026-08-09T10:00:00Z",
};

describe("SessionsBoardView", () => {
	it("renders portable split lanes with one shared scroller", () => {
		const sessions: BoardSessionPresentation[] = [
			baseSession,
			{ ...baseSession, id: "working", status: "working", title: "working task" },
			{ ...baseSession, id: "ready", status: "mergeable", title: "ready task" },
			{ ...baseSession, id: "merged", status: "merged", title: "merged task" },
		];
		render(
			<SessionsBoardGridView
				columns={boardAttentionZoneOrder.map((zone) => getAttentionZoneViewForZone(zone))}
				labels={splitLabels}
				renderSessionCard={(session) => <div data-testid={`card-${session.id}`}>{session.title}</div>}
				sessions={sessions}
			/>,
		);

		const workLane = screen.getByRole("region", { name: "Idle / Working sessions" });
		expect(within(workLane).getByRole("region", { name: "Idle sessions" })).toHaveTextContent("portable task");
		expect(within(workLane).getByRole("region", { name: "Working sessions" })).toHaveTextContent("working task");
		expect(workLane.querySelectorAll(".overflow-y-auto")).toHaveLength(1);

		const mergeLane = screen.getByRole("region", { name: "Ready / Merged sessions" });
		expect(within(mergeLane).getByLabelText("1 ready session")).toHaveTextContent("1");
		expect(within(mergeLane).getByLabelText("1 merged session")).toHaveTextContent("1");
	});

	it("renders a neutral card with grouped multi-PR, usage, and action presentation", () => {
		const onOpen = vi.fn();
		render(
			<SessionCardView
				action={<button type="button">Restore</button>}
				branchAction={<button type="button">Copy branch</button>}
				externalLink={ExternalLink}
				labels={{
					formatTime: () => "5m ago",
					intakeIssue: (id) => `Issue ${id}`,
					pr: {
						short: "PR",
						states: { closed: "closed", draft: "draft", merged: "merged", open: "open" },
					},
					updatedAt: (timestamp) => `Updated ${timestamp}`,
				}}
				onOpen={onOpen}
				prs={[
					{ number: 10, state: "open", url: "https://example.com/pull/10" },
					{ number: 11, state: "open", url: "https://example.com/pull/11" },
					{ number: 12, state: "merged", url: "https://example.com/pull/12" },
				]}
				renderAvatar={(provider) => <span role="img" aria-label={provider}>C</span>}
				session={{ ...baseSession, branch: "feat/portable", trackerIssueId: "github:42" }}
				usage={{ accessibleLabel: "12,400 tokens", compactLabel: "12.4K tok" }}
			/>,
		);

		expect(screen.getByLabelText("#10, #11 open")).toHaveTextContent("PR#10,#11open");
		expect(screen.getByLabelText("#12 merged")).toHaveTextContent("PR#12merged");
		expect(screen.getByText("12.4K tok")).toHaveAccessibleName("12,400 tokens");
		expect(screen.getByText("5m ago")).toHaveAttribute("title", "Updated 2026-08-09T10:00:00Z");
		expect(screen.getByText("github:42")).toHaveAttribute("title", "Issue github:42");

		fireEvent.click(screen.getByRole("button", { name: "portable task" }));
		expect(onOpen).toHaveBeenCalledOnce();
	});

	it("keeps archive expansion controlled and preserves the grid list", () => {
		const onExpandedChange = vi.fn();
		const { rerender } = render(
			<SessionsArchiveView
				archiveExpanded={false}
				labels={{ archive: "Archive", archiveAria: "Archive, 1 session", archivedSessions: "Archived sessions" }}
				onArchiveExpandedChange={onExpandedChange}
				renderSessionCard={(session) => <div role="listitem">{session.title}</div>}
				sessions={[baseSession]}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Archive, 1 session" }));
		expect(onExpandedChange).toHaveBeenCalledWith(true);

		rerender(
			<SessionsArchiveView
				archiveExpanded
				labels={{ archive: "Archive", archiveAria: "Archive, 1 session", archivedSessions: "Archived sessions" }}
				onArchiveExpandedChange={onExpandedChange}
				renderSessionCard={(session) => <div role="listitem">{session.title}</div>}
				sessions={[baseSession]}
			/>,
		);
		const archive = screen.getByRole("list", { name: "Archived sessions" });
		expect(archive).toHaveClass("board-scrollbar", "grid", "overflow-y-auto");
		expect(within(archive).getByText("portable task")).toBeInTheDocument();
	});
});
