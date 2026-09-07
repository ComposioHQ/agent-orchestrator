import { describe, expect, it, vi } from "vitest";
import { createSaveLinkAs } from "./save-link-as";

describe("save link as", () => {
	it("does not start a download when the save dialog is canceled", async () => {
		const showSaveDialog = vi.fn(async () => ({ canceled: true, filePath: undefined }));
		const saveLink = createSaveLinkAs(showSaveDialog);
		const source = { id: 9, session: { on: vi.fn(), off: vi.fn() }, downloadURL: vi.fn() };

		await saveLink(source, "https://example.test/manual.pdf");

		expect(showSaveDialog).toHaveBeenCalledWith({ defaultPath: "manual.pdf" });
		expect(source.downloadURL).not.toHaveBeenCalled();
	});

	it("assigns the chosen path to the matching authenticated-session download", async () => {
		let listener: ((event: unknown, item: { getURLChain: () => string[]; setSavePath: (path: string) => void }, source: { id: number }) => void) | undefined;
		const session = {
			on: vi.fn((_event: string, next: typeof listener) => { listener = next; }),
			off: vi.fn(),
		};
		const source = { id: 9, session, downloadURL: vi.fn() };
		const showSaveDialog = vi.fn(async () => ({ canceled: false, filePath: "/tmp/manual.pdf" }));
		const setSavePath = vi.fn();
		const saveLink = createSaveLinkAs(showSaveDialog);

		await saveLink(source, "https://example.test/manual.pdf");
		listener?.({}, { getURLChain: () => ["https://example.test/manual.pdf"], setSavePath }, { id: 9 });

		expect(source.downloadURL).toHaveBeenCalledWith("https://example.test/manual.pdf");
		expect(setSavePath).toHaveBeenCalledWith("/tmp/manual.pdf");
		expect(session.off).toHaveBeenCalledWith("will-download", listener);
	});

	it("does not start a stale download after the tab becomes invalid while the dialog is open", async () => {
		let resolveDialog: ((result: { canceled: boolean; filePath: string }) => void) | undefined;
		const showSaveDialog = vi.fn(() => new Promise<{ canceled: boolean; filePath: string }>((resolve) => {
			resolveDialog = resolve;
		}));
		const saveLink = createSaveLinkAs(showSaveDialog);
		const source = {
			id: 9,
			session: { on: vi.fn(), off: vi.fn() },
			downloadURL: vi.fn(),
			on: vi.fn(),
			off: vi.fn(),
		};
		const isValid = vi.fn(() => false);

		const saving = saveLink(source, "https://example.test/manual.pdf", isValid);
		resolveDialog?.({ canceled: false, filePath: "/tmp/manual.pdf" });
		await saving;

		expect(source.downloadURL).not.toHaveBeenCalled();
		expect(source.session.on).not.toHaveBeenCalled();
	});

	it("removes the pending download listener when the source is destroyed", async () => {
		let onDestroyed: (() => void) | undefined;
		const session = { on: vi.fn(), off: vi.fn() };
		const source = {
			id: 9,
			session,
			downloadURL: vi.fn(),
			on: vi.fn((_event: string, listener: () => void) => { onDestroyed = listener; }),
			off: vi.fn(),
		};
		const saveLink = createSaveLinkAs(vi.fn(async () => ({
			canceled: false,
			filePath: "/tmp/manual.pdf",
		})));

		await saveLink(source, "https://example.test/manual.pdf");
		onDestroyed?.();

		expect(session.off).toHaveBeenCalledWith("will-download", expect.any(Function));
		expect(source.off).toHaveBeenCalledWith("destroyed", onDestroyed);
	});
});
