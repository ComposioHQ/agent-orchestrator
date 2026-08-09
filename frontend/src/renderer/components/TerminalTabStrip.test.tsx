import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ShellTerminal } from "../hooks/useShellTerminals";
import type { WorkspaceSession } from "../types/workspace";
import { TerminalTabStrip } from "./TerminalTabStrip";

vi.mock("motion/react", () => ({
	Reorder: {
		Group: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
		Item: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
	},
	useDragControls: () => ({ start: vi.fn() }),
}));

const owner = {
	id: "owner",
	workspaceId: "project",
	workspaceName: "Project",
	title: "Owner",
	provider: "codex",
	kind: "worker",
	status: "working",
	updatedAt: "2026-08-10T00:00:00Z",
	prs: [],
} satisfies WorkspaceSession;
const shell = {
	handleId: "shell-1",
	sessionId: owner.id,
	workingDir: "/project",
	title: "Shell",
	createdAt: "2026-08-10T00:00:00Z",
} satisfies ShellTerminal;

describe("TerminalTabStrip", () => {
	it("keeps the owner fixed and groups Pin immediately before Close", () => {
		const onPinnedChange = vi.fn();
		render(
			<TerminalTabStrip
				activeKey="session:owner"
				layout={{
					pinned: ["shell:shell-1"],
					unpinned: [],
					history: ["session:owner"],
				}}
				onClose={vi.fn()}
				onPinnedChange={onPinnedChange}
				onReorder={vi.fn()}
				onSelect={vi.fn()}
				ownerSession={owner}
				reviewerTerminal={{ handleId: "reviewer-1", harness: "codex", label: "Reviewer" }}
				shellTerminals={[shell]}
			/>,
		);

		expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))).toEqual(["Owner", "Shell", "Reviewer"]);
		expect(screen.queryByRole("button", { name: "Close session tab Owner" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Pin tab" })).toBeInTheDocument();
		const unpin = screen.getByRole("button", { name: "Unpin tab" });
		const close = screen.getByRole("button", { name: "Close terminal Shell" });
		expect(unpin.nextElementSibling).toBe(close);
		fireEvent.click(unpin);
		expect(onPinnedChange).toHaveBeenCalledWith("shell:shell-1", false);
	});
});
