import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConversationBranchNavigator } from "./ConversationBranchNavigator";

describe("ConversationBranchNavigator", () => {
	it("activates the available previous and next branches", async () => {
		const user = userEvent.setup();
		const onActivate = vi.fn();
		render(
			<ConversationBranchNavigator
				point={{ turnId: "turn-1", position: 2, total: 3, previousBranchId: "branch-previous", nextBranchId: "branch-next" }}
				pending={false}
				onActivate={onActivate}
			/>,
		);
		expect(screen.getByText("2 / 3")).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Previous conversation branch" }));
		expect(onActivate).toHaveBeenCalledWith("branch-previous");
		await user.click(screen.getByRole("button", { name: "Next conversation branch" }));
		expect(onActivate).toHaveBeenCalledWith("branch-next");
	});

	it("renders nothing for a single branch", () => {
		const { container } = render(<ConversationBranchNavigator point={{ turnId: "turn-1", position: 1, total: 1 }} pending={false} onActivate={vi.fn()} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("omits unavailable edges and disables controls while pending", () => {
		render(
			<ConversationBranchNavigator point={{ turnId: "turn-1", position: 1, total: 2, nextBranchId: "next" }} pending onActivate={vi.fn()} error="activation failed" />,
		);
		expect(screen.queryByRole("button", { name: "Previous conversation branch" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Next conversation branch" })).toBeDisabled();
		expect(screen.getByRole("alert")).toHaveTextContent("activation failed");
	});
});
