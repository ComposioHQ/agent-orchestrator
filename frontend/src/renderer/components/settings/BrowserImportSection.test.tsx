import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserImportSection } from "./BrowserImportSection";

const { detect, importSource, getStatus, useEphemeral } = vi.hoisted(() => ({
	detect: vi.fn(),
	importSource: vi.fn(),
	getStatus: vi.fn(),
	useEphemeral: vi.fn(),
}));

vi.mock("../../lib/bridge", () => ({
	aoBridge: {
		browserImport: {
			detect,
			import: importSource,
			getStatus,
			useEphemeral,
		},
	},
}));

const source = {
	id: "opaque-source-id",
	browser: "chrome" as const,
	label: "Google Chrome",
	profileName: "Default profile",
	bookmarkCount: 4,
};

beforeEach(() => {
	detect.mockReset();
	importSource.mockReset();
	getStatus.mockReset();
	useEphemeral.mockReset();
	detect.mockResolvedValue({ sources: [source], supportedData: ["bookmarks"] });
	getStatus.mockResolvedValue({ persistence: "ephemeral", destinationActive: false, summary: null });
	useEphemeral.mockResolvedValue({ persistence: "ephemeral", destinationActive: false, summary: null });
	importSource.mockResolvedValue({
		sourceBrowser: "chrome",
		sourceProfile: "Default profile",
		importedBookmarks: 4,
		skippedBookmarks: 1,
		destination: "ao-persistent-browser",
		persistence: "persistent",
	});
});

describe("BrowserImportSection", () => {
	it("discloses the bookmark-only scope and keeps import disabled until explicit opt-in", async () => {
		render(<BrowserImportSection />);

		expect(await screen.findByText(/AO reads only bookmark files/i)).toBeInTheDocument();
		expect(screen.getByText(/does not import passwords, extensions, cookies/i)).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Find supported browser profiles" }));
		const importButton = await screen.findByRole("button", { name: "Import and use" });
		expect(importButton).toBeDisabled();
	});

	it("scans, requires the persistent opt-in, and imports the selected source", async () => {
		const user = userEvent.setup();
		render(<BrowserImportSection />);

		await user.click(await screen.findByRole("button", { name: "Find supported browser profiles" }));
		const radio = await screen.findByRole("radio", { name: /Google Chrome.*Default profile.*4 bookmarks/i });
		expect(radio).toBeChecked();
		const importButton = screen.getByRole("button", { name: "Import and use" });
		expect(importButton).toBeDisabled();

		await user.click(screen.getByRole("checkbox", { name: /Use the imported bookmarks/i }));
		await user.click(importButton);

		await waitFor(() => expect(importSource).toHaveBeenCalledWith({ sourceId: source.id, activate: true }));
		expect((await screen.findAllByText(/Imported 4 bookmarks/)).length).toBeGreaterThan(0);
		expect(screen.getByText(/unsupported entries were skipped/)).toBeInTheDocument();
	});

	it("supports dismissal and retry after a detection failure", async () => {
		const user = userEvent.setup();
		detect.mockRejectedValueOnce(new Error("scan failed"));
		render(<BrowserImportSection />);

		await user.click(await screen.findByRole("button", { name: "Find supported browser profiles" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Browser import failed.");

		await user.click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByRole("radio", { name: /Google Chrome/ })).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Keep temporary browser" }));
		expect(await screen.findByRole("status")).toHaveTextContent("No browser data was imported");
	});

	it("shows persistent status and allows switching future workers back to temporary storage", async () => {
		getStatus.mockResolvedValue({
			persistence: "persistent",
			destinationActive: false,
			summary: {
				sourceBrowser: "chrome",
				sourceProfile: "Default profile",
				importedBookmarks: 2,
				skippedBookmarks: 0,
				importedAt: "2026-08-18T00:00:00.000Z",
			},
		});
		const user = userEvent.setup();
		render(<BrowserImportSection />);

		expect(await screen.findByText(/persistent browser is enabled/i)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Use temporary browser for new workers" }));
		await waitFor(() => expect(useEphemeral).toHaveBeenCalledTimes(1));
	});
});
