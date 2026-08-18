import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserBookmarksPopover } from "./BrowserBookmarksPopover";

const getBookmarks = vi.fn();

beforeEach(() => {
	getBookmarks.mockReset();
	getBookmarks.mockResolvedValue({
		version: 1,
		roots: {
			bookmark_bar: {
				type: "folder",
				id: "bar",
				name: "Bookmarks bar",
				children: [
					{ type: "url", id: "docs", name: "AO docs", url: "https://ao.example.test/docs" },
					{
						type: "folder",
						id: "nested",
						name: "Nested",
						children: [{ type: "url", id: "nested-docs", name: "Nested docs", url: "https://ao.example.test/nested" }],
					},
				],
			},
			other: { type: "folder", id: "other", name: "Other bookmarks", children: [] },
			synced: { type: "folder", id: "synced", name: "Mobile bookmarks", children: [] },
		},
	});
	window.ao!.browserBookmarks.get = getBookmarks;
});

describe("BrowserBookmarksPopover", () => {
	it("lists imported folders and opens a selected URL through the browser navigation callback", async () => {
		const user = userEvent.setup();
		const onOpenBookmark = vi.fn();
		render(<BrowserBookmarksPopover onOpenBookmark={onOpenBookmark} />);

		await user.click(screen.getByRole("button", { name: "Bookmarks" }));
		expect(await screen.findByText("Bookmarks bar")).toBeInTheDocument();
		expect(screen.getByText("Nested")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "AO docs" })).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "AO docs" }));
		await waitFor(() => expect(onOpenBookmark).toHaveBeenCalledWith("https://ao.example.test/docs"));
		expect(screen.getByTestId("browser-bookmarks-popover")).toHaveAttribute("data-state", "closed");
	});

	it("shows an empty state when AO has no imported bookmark document", async () => {
		getBookmarks.mockResolvedValueOnce(null);
		const user = userEvent.setup();
		render(<BrowserBookmarksPopover onOpenBookmark={() => undefined} />);

		await user.click(screen.getByRole("button", { name: "Bookmarks" }));
		expect(await screen.findByText("No imported bookmarks.")).toBeInTheDocument();
	});
});
