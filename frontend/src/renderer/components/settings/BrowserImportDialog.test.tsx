import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AoBridge } from "../../../preload";
import { aoBridge } from "../../lib/bridge";
import { BrowserImportDialog } from "./BrowserImportDialog";

const source = {
	id: "a".repeat(32),
	name: "Google Chrome",
	family: "chromium" as const,
	profiles: [{ id: "b".repeat(32), name: "Default", default: true }],
	cookieSupport: "partial" as const,
	cookieSupportReason: "chromium-encryption-partial" as const,
	historySupport: true as const,
};

const firefoxSource = {
	id: "c".repeat(32),
	name: "Firefox",
	family: "firefox" as const,
	profiles: [{ id: "d".repeat(32), name: "default-release", default: true }],
	cookieSupport: "supported" as const,
	cookieSupportReason: "firefox-plaintext" as const,
	historySupport: true as const,
};

describe("BrowserImportDialog", () => {
	const originalBridge = aoBridge.browserProfiles;

	afterEach(() => {
		aoBridge.browserProfiles = originalBridge;
	});

	it("guides a detected profile into a new AO profile and reports completion", async () => {
		const importedProfile = {
			id: "11111111-1111-4111-8111-111111111111",
			name: "Google Chrome",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		};
		const bridge: AoBridge["browserProfiles"] = {
			list: vi.fn(async () => ({ profiles: [] })),
			create: vi.fn(),
			rename: vi.fn(),
			clear: vi.fn(),
			delete: vi.fn(),
			discoverImportSources: vi.fn(async () => ({ sources: [source, firefoxSource] })),
			import: vi.fn(async () => ({
				sourceName: source.name,
				entries: [{
					sourceProfileNames: ["Default"],
					destinationProfile: importedProfile,
					importedCookies: 12,
					skippedCookies: 1,
					importedHistoryEntries: 34,
					warnings: [{ code: "encrypted-cookies-skipped" as const, count: 1 }],
				}],
			})),
			onImportProgress: vi.fn(() => () => undefined),
		};
		aoBridge.browserProfiles = bridge;
		const onImported = vi.fn();

		render(<BrowserImportDialog onImported={onImported} onOpenChange={() => undefined} open />);
		expect(await screen.findByText("Google Chrome")).toBeInTheDocument();
		const chromeButton = screen.getByRole("button", { name: /Google Chrome/ });
		const firefoxButton = screen.getByRole("button", { name: /Firefox/ });
		expect(chromeButton).toHaveAttribute("aria-pressed", "true");
		expect(chromeButton).toHaveAttribute("data-selected", "true");
		expect(chromeButton).toHaveClass("ring-2");
		expect(chromeButton).toHaveClass("bg-accent", "text-accent-foreground");
		await userEvent.click(firefoxButton);
		expect(firefoxButton).toHaveAttribute("aria-pressed", "true");
		expect(chromeButton).toHaveAttribute("aria-pressed", "false");
		await userEvent.click(chromeButton);
		await userEvent.click(screen.getByRole("button", { name: "Next" }));
		expect(screen.getByRole("checkbox", { name: /Default/ })).toBeChecked();
		await userEvent.click(screen.getByRole("button", { name: "Next" }));
		expect(screen.getByRole("textbox", { name: "Destination profile name" })).toHaveValue("Google Chrome");
		await userEvent.click(screen.getByRole("button", { name: "Start import" }));

		expect(await screen.findByText("Import complete")).toBeInTheDocument();
		expect(screen.getByText("12 cookies · 34 history entries")).toBeInTheDocument();
		await waitFor(() => expect(onImported).toHaveBeenCalledOnce());
		expect(bridge.import).toHaveBeenCalledWith(expect.objectContaining({
			sourceId: source.id,
			profileIds: [source.profiles[0]!.id],
			includeCookies: true,
			includeHistory: true,
			destination: { mode: "merge", name: "Google Chrome" },
		}));
	});

	it("clears a failed import when navigating back to choose another browser", async () => {
		const bridge: AoBridge["browserProfiles"] = {
			list: vi.fn(async () => ({ profiles: [] })),
			create: vi.fn(),
			rename: vi.fn(),
			clear: vi.fn(),
			delete: vi.fn(),
			discoverImportSources: vi.fn(async () => ({ sources: [source, firefoxSource] })),
			import: vi.fn(async () => { throw new Error("Firefox cookie data is unavailable."); }),
			onImportProgress: vi.fn(() => () => undefined),
		};
		aoBridge.browserProfiles = bridge;

		render(<BrowserImportDialog onImported={() => undefined} onOpenChange={() => undefined} open />);
		await userEvent.click(await screen.findByRole("button", { name: /Firefox/ }));
		await userEvent.click(screen.getByRole("button", { name: "Next" }));
		await userEvent.click(screen.getByRole("button", { name: "Next" }));
		await userEvent.click(screen.getByRole("button", { name: "Start import" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Firefox cookie data is unavailable.");

		await userEvent.click(screen.getByRole("button", { name: "Back" }));
		await userEvent.click(screen.getByRole("button", { name: "Back" }));
		const chromeButton = screen.getByRole("button", { name: /Google Chrome/ });
		await userEvent.click(chromeButton);
		expect(chromeButton).toHaveAttribute("aria-pressed", "true");
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});
