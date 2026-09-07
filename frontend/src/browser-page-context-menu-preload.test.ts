import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => {
	const listeners = new Map<string, (...args: unknown[]) => void>();
	return {
		listeners,
		on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => listeners.set(channel, listener)),
		send: vi.fn(),
	};
});

vi.mock("electron", () => ({
	ipcRenderer: { on: electronMocks.on, send: electronMocks.send },
}));

let menuRoot: ShadowRoot | null = null;
const realAttachShadow = Element.prototype.attachShadow;
vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init: ShadowRootInit) {
	const root = realAttachShadow.call(this, init);
	menuRoot = root;
	return root;
});

await import("./browser-page-context-menu-preload");

function showMenu(): void {
	electronMocks.listeners.get("browser:pageContextMenu:show")?.({}, {
		requestId: "request-1",
		position: { x: 40, y: 60 },
		items: [
			{ type: "action", action: "annotate", label: "Annotate" },
			{ type: "separator" },
			{ type: "action", action: "save-link", label: "Save link as…" },
		],
	});
}

describe("browser page context menu preload", () => {
	beforeEach(() => {
		document.querySelector("[data-ao-browser-context-menu]")?.remove();
		menuRoot = null;
		electronMocks.send.mockClear();
	});

	it("renders an isolated AO-styled menu without the shell overlay marker", () => {
		showMenu();

		const host = document.querySelector<HTMLElement>("[data-ao-browser-context-menu]");
		const menu = menuRoot?.querySelector<HTMLElement>("[role=menu]");
		expect(host).not.toBeNull();
		expect(host).not.toHaveAttribute("data-browser-native-overlay");
		expect(menu?.textContent).toContain("Annotate");
		expect(menu?.textContent).toContain("Save link as…");
		expect(menu?.style.borderRadius).toBe("8px");
		expect(menu?.style.background).toBe("rgb(28, 28, 30)");
	});

	it("routes the selected action with the current request and dismisses", () => {
		showMenu();

		menuRoot?.querySelector<HTMLButtonElement>('button[data-action="save-link"]')?.click();

		expect(electronMocks.send).toHaveBeenCalledWith("browser:pageContextMenu:action", {
			requestId: "request-1",
			action: "save-link",
		});
		expect(document.querySelector("[data-ao-browser-context-menu]")).toBeNull();
	});

	it("dismisses on Escape", () => {
		showMenu();

		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

		expect(electronMocks.send).toHaveBeenCalledWith("browser:pageContextMenu:dismiss", {
			requestId: "request-1",
		});
		expect(document.querySelector("[data-ao-browser-context-menu]")).toBeNull();
	});
});
