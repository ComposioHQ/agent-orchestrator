import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionBranchBadge } from "./SessionBranchBadge";

describe("SessionBranchBadge", () => {
	it("shows the branch as read-only context", () => {
		render(<SessionBranchBadge branch="feat/session-file-tabs" />);
		expect(screen.getByLabelText("feat/session-file-tabs")).toHaveAttribute("data-compact", "false");
		expect(screen.getByText("feat/session-file-tabs")).toBeInTheDocument();
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("keeps the full branch accessible while competing tabs compact its visible label", () => {
		render(<SessionBranchBadge branch="feat/session-file-tabs" compact />);
		const badge = screen.getByLabelText("feat/session-file-tabs");
		expect(badge).toHaveAttribute("title", "feat/session-file-tabs");
		expect(badge).toHaveAttribute("data-compact", "true");
		expect(badge).toHaveClass("session-branch-badge", "overflow-hidden");
		expect(badge.querySelector(".session-branch-badge__label")).toHaveTextContent("feat/session-file-tabs");
	});

	it("renders nothing without a branch", () => {
		const { container } = render(<SessionBranchBadge />);
		expect(container).toBeEmptyDOMElement();
	});
});
