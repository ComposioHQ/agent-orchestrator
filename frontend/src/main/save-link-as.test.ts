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
});
