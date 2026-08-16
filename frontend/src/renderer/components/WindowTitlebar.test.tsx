import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { backMock, forwardMock, canGoForwardMock, canGoBackMock } = vi.hoisted(() => ({
	backMock: vi.fn(),
	forwardMock: vi.fn(),
	canGoForwardMock: vi.fn(() => true),
	canGoBackMock: vi.fn(() => true),
}));

vi.mock("@tanstack/react-router", () => ({
	useCanGoBack: () => canGoBackMock(),
	useRouter: () => ({
		history: {
			back: backMock,
			forward: forwardMock,
		},
	}),
}));

vi.mock("./TitlebarNav", () => ({
	useCanGoForward: () => canGoForwardMock(),
}));

describe("WindowTitlebar", () => {
	const platformDescriptor = Object.getOwnPropertyDescriptor(navigator, "platform");

	async function loadWindowTitlebar() {
		vi.resetModules();
		Object.defineProperty(navigator, "platform", {
			configurable: true,
			value: "Win32",
		});
		return import("./WindowTitlebar");
	}

	beforeEach(() => {
		backMock.mockReset();
		forwardMock.mockReset();
		canGoBackMock.mockReturnValue(true);
		canGoForwardMock.mockReturnValue(true);
	});

	afterEach(() => {
		if (platformDescriptor) {
			Object.defineProperty(navigator, "platform", platformDescriptor);
		} else {
			Reflect.deleteProperty(navigator, "platform");
		}
	});

	it("keeps only View and Help menus beside the Windows titlebar navigation", async () => {
		const { WindowTitlebar } = await loadWindowTitlebar();

		render(<WindowTitlebar />);

		expect(screen.queryByRole("button", { name: "File" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Window" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "View" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Help" })).toBeInTheDocument();
	});

	it("adds back and forward arrows next to the sidebar toggle", async () => {
		const { WindowTitlebar } = await loadWindowTitlebar();
		const user = userEvent.setup();

		render(<WindowTitlebar />);

		await user.click(screen.getByRole("button", { name: "Go back" }));
		await user.click(screen.getByRole("button", { name: "Go forward" }));

		expect(backMock).toHaveBeenCalledTimes(1);
		expect(forwardMock).toHaveBeenCalledTimes(1);
	});
});
