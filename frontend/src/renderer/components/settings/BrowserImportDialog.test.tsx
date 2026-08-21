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
			discoverImportSources: vi.fn(async () => ({ sources: [source] })),
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
});
