import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BrowserDownloadsList } from "./BrowserDownloadsList";

describe("BrowserDownloadsList", () => {
	it("shows a nonfatal destination error even when there is no history", () => {
		render(
			<BrowserDownloadsList
				downloads={[]}
				error="Could not prepare the Downloads folder."
				onAction={() => undefined}
			/>,
		);

		expect(screen.getByRole("alert")).toHaveTextContent("Could not prepare the Downloads folder.");
	});

	it("keeps resume and cancel controls for a resumable interruption", async () => {
		const onAction = vi.fn();
		render(
			<BrowserDownloadsList
				downloads={[{
					id: "download-1",
					fileName: "report.pdf",
					receivedBytes: 50,
					totalBytes: 100,
					status: "interrupted",
					active: true,
					resumable: true,
					startedAt: 1,
					updatedAt: 2,
				}]}
				onAction={onAction}
			/>,
		);

		await userEvent.click(screen.getByRole("button", { name: "Resume report.pdf" }));
		expect(onAction).toHaveBeenCalledWith("download-1", "resume");
		await userEvent.click(screen.getByRole("button", { name: "Cancel report.pdf" }));
		expect(onAction).toHaveBeenCalledWith("download-1", "cancel");
		expect(screen.queryByRole("button", { name: "Remove report.pdf" })).not.toBeInTheDocument();
	});
});
