import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImportSessionsHint } from "./ImportSessionsHint";

const h = vi.hoisted(() => ({ setImportSessionOpen: vi.fn() }));

vi.mock("../stores/ui-store", () => ({
	useUiStore: (select: (state: { setImportSessionOpen: typeof h.setImportSessionOpen }) => unknown) =>
		select({ setImportSessionOpen: h.setImportSessionOpen }),
}));

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

const STORAGE_KEY = "ao.importSessionsHint.dismissed";

beforeEach(() => {
	window.localStorage.clear();
	h.setImportSessionOpen.mockReset();
});

afterEach(() => {
	window.localStorage.clear();
});

describe("ImportSessionsHint", () => {
	it("offers the import route to someone who has not dismissed it", () => {
		render(<ImportSessionsHint />);
		expect(screen.getByTestId("import-sessions-hint")).toBeInTheDocument();
	});

	// The nudge must not cost a disk scan on every launch, so it renders without
	// asking the daemon what is importable. The dialog does that work on open.
	it("renders without querying for importable sessions", () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		render(<ImportSessionsHint />);
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	it("stays gone once dismissed, across restarts", async () => {
		const user = userEvent.setup();
		const { unmount } = render(<ImportSessionsHint />);

		await user.click(screen.getByRole("button", { name: "importSession.hintDismiss" }));
		expect(screen.queryByTestId("import-sessions-hint")).not.toBeInTheDocument();
		expect(window.localStorage.getItem(STORAGE_KEY)).toBe("1");

		// A later launch must not bring it back.
		unmount();
		render(<ImportSessionsHint />);
		expect(screen.queryByTestId("import-sessions-hint")).not.toBeInTheDocument();
	});

	it("opens the import dialog and retires itself when acted on", async () => {
		const user = userEvent.setup();
		render(<ImportSessionsHint />);

		await user.click(screen.getByRole("button", { name: "importSession.hintAction" }));
		expect(h.setImportSessionOpen).toHaveBeenCalledWith(true);
		// Acting on the nudge answers it, so it should not return next launch.
		expect(window.localStorage.getItem(STORAGE_KEY)).toBe("1");
		expect(screen.queryByTestId("import-sessions-hint")).not.toBeInTheDocument();
	});
})
