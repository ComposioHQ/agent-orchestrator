import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShellTerminal } from "../hooks/useShellTerminals";
import { ShellTerminalTab } from "./ShellTerminalTab";

const { isWindowsPlatform } = vi.hoisted(() => ({ isWindowsPlatform: vi.fn(() => false) }));
vi.mock("../lib/platform", () => ({ isWindowsPlatform }));

afterEach(() => isWindowsPlatform.mockReturnValue(false));

const shell: ShellTerminal = {
	handleId: "shellterm-1",
	projectId: "ao",
	workingDir: "/repos/ao",
	title: "ao",
	createdAt: "2026-07-24T10:00:00Z",
};

function renderTab(overrides: Partial<Parameters<typeof ShellTerminalTab>[0]> = {}) {
	const onSelect = vi.fn();
	const onClose = vi.fn();
	const onRename = vi.fn();
	render(
		<ShellTerminalTab
			isActive={false}
			onClose={onClose}
			onRename={onRename}
			onSelect={onSelect}
			shell={shell}
			{...overrides}
		/>,
	);
	return { onSelect, onClose, onRename };
}

describe("ShellTerminalTab rename", () => {
	it("commits a new title on Enter", () => {
		const { onRename } = renderTab();
		fireEvent.doubleClick(screen.getByRole("tab", { name: "ao" }));
		const input = screen.getByRole("textbox", { name: /rename terminal/i });
		fireEvent.change(input, { target: { value: "deploy" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onRename).toHaveBeenCalledWith("deploy");
	});

	it("commits on blur", () => {
		const { onRename } = renderTab();
		fireEvent.doubleClick(screen.getByRole("tab", { name: "ao" }));
		const input = screen.getByRole("textbox", { name: /rename terminal/i });
		fireEvent.change(input, { target: { value: "logs" } });
		fireEvent.blur(input);
		expect(onRename).toHaveBeenCalledWith("logs");
	});

	it("discards on Escape and leaves the title unchanged", () => {
		const { onRename } = renderTab();
		fireEvent.doubleClick(screen.getByRole("tab", { name: "ao" }));
		const input = screen.getByRole("textbox", { name: /rename terminal/i });
		fireEvent.change(input, { target: { value: "throwaway" } });
		fireEvent.keyDown(input, { key: "Escape" });
		expect(onRename).not.toHaveBeenCalled();
		expect(screen.getByRole("tab", { name: "ao" })).toBeInTheDocument();
	});

	it("discards an empty or unchanged title", () => {
		const { onRename } = renderTab();
		fireEvent.doubleClick(screen.getByRole("tab", { name: "ao" }));
		const input = screen.getByRole("textbox", { name: /rename terminal/i });
		fireEvent.change(input, { target: { value: "   " } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onRename).not.toHaveBeenCalled();
	});

	it("does not enter edit mode when rename is not wired", () => {
		renderTab({ onRename: undefined });
		fireEvent.doubleClick(screen.getByRole("tab", { name: "ao" }));
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
	});

	it("selects the tab on single click", () => {
		const { onSelect } = renderTab();
		fireEvent.click(screen.getByRole("tab", { name: "ao" }));
		expect(onSelect).toHaveBeenCalled();
	});

	it("selects from the full connected pill, not only its title", () => {
		const { onSelect } = renderTab({ appearance: "connected" });
		fireEvent.click(screen.getByRole("tab", { name: "ao" }).parentElement as HTMLElement);
		expect(onSelect).toHaveBeenCalledOnce();
	});

	it("keeps the close affordance visible on an active connected tab", () => {
		renderTab({ appearance: "connected", isActive: true, isPinned: false, onPinnedChange: vi.fn() });
		const actionTray = screen.getByRole("button", { name: "Close terminal ao" }).parentElement;

		expect(screen.getByRole("button", { name: "Close terminal ao" })).toHaveClass("w-control-sm", "opacity-100");
		expect(actionTray).toHaveClass(
			"absolute",
			"inset-y-0",
			"right-0",
			"h-full",
			"translate-x-0",
			"rounded-l-[3px]",
			"border-foreground/25",
			"bg-background",
			"opacity-100",
			"pointer-events-auto",
		);
		expect(actionTray).not.toHaveClass("bg-overlay/95", "bg-raised", "bg-surface");
		expect(screen.getByRole("tab", { name: "ao" }).parentElement).toHaveClass(
			"shrink-0",
			"w-auto",
			"min-w-shell-tab-connected",
			"after:z-20",
		);
		expect(screen.getByRole("tab", { name: "ao" })).toHaveClass("whitespace-nowrap");
		expect(screen.getByRole("tab", { name: "ao" })).not.toHaveClass("truncate");
		expect(screen.getByRole("tab", { name: "ao" })).toHaveAttribute("aria-selected", "true");
	});

	it("overlays Pin and Close only while an inactive connected terminal is hovered or focused", () => {
		renderTab({ appearance: "connected", isActive: false, isPinned: false, onPinnedChange: vi.fn() });
		const actionTray = screen.getByRole("button", { name: "Close terminal ao" }).parentElement;

		expect(actionTray).toHaveClass(
			"absolute",
			"inset-y-0",
			"right-0",
			"h-full",
			"duration-200",
			"pointer-events-none",
			"translate-x-full",
			"opacity-0",
			"group-hover:pointer-events-auto",
			"group-hover:translate-x-0",
			"group-hover:opacity-100",
			"group-hover:animate-in",
			"group-hover:slide-in-from-right",
			"group-hover:fade-in-0",
			"group-focus-within:pointer-events-auto",
			"group-focus-within:translate-x-0",
			"group-focus-within:opacity-100",
		);
		expect(screen.getByRole("button", { name: "Pin tab" })).toHaveClass("w-control-sm");
		expect(screen.getByRole("button", { name: "Close terminal ao" })).toHaveClass("w-control-sm");
	});

	it("keeps a compact pinned-state marker visible while tab actions are hidden", () => {
		renderTab({ appearance: "connected", isActive: false, isPinned: true, onPinnedChange: vi.fn() });

		expect(screen.getByTestId("terminal-pinned-indicator")).toHaveClass(
			"size-icon-xs",
			"-rotate-45",
			"text-muted-foreground",
		);
	});

	it("uses a compact fixed width without reserving label space for inactive actions", () => {
		renderTab({ appearance: "connected", isActive: false });

		expect(screen.getByRole("button", { name: "Close terminal ao" }).parentElement).toHaveClass("absolute");
		expect(screen.getByRole("tab", { name: "ao" })).toHaveClass("w-full", "min-w-0", "text-left");
		expect(screen.getByRole("tab", { name: "ao" }).parentElement).toHaveClass(
			"shrink-0",
			"w-shell-tab-connected",
			"border-r",
			"border-border/60",
		);
	});

	it("uses a neutral active surface with a strong foreground selection line", () => {
		renderTab({ appearance: "connected", isActive: true });

		expect(screen.getByRole("tab", { name: "ao" }).parentElement).toHaveClass(
			"self-stretch",
			"bg-overlay",
			"after:h-0.5",
			"after:bg-foreground/80",
		);
		expect(screen.getByRole("tab", { name: "ao" }).parentElement).not.toHaveClass("rounded-md");
		expect(screen.getByRole("tab", { name: "ao" }).parentElement).not.toHaveClass("before:bg-accent");
		expect(screen.getByRole("tab", { name: "ao" }).parentElement).not.toHaveClass("after:h-px");
	});

	it("optically centers the auxiliary terminal glyph with its label", () => {
		renderTab({ appearance: "connected" });

		expect(screen.getByRole("tab", { name: "ao" }).parentElement?.querySelector("svg")).toHaveClass(
			"size-icon-md",
			"translate-y-px",
		);
	});
});

describe("ShellTerminalTab rename gesture per platform", () => {
	it("macOS/Linux: double-click enters edit, right-click does not", () => {
		renderTab(); // isWindowsPlatform() defaults to false
		const tab = screen.getByRole("tab", { name: "ao" });
		fireEvent.contextMenu(tab);
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
		fireEvent.doubleClick(tab);
		expect(screen.getByRole("textbox", { name: /rename terminal/i })).toBeInTheDocument();
	});

	it("macOS/Linux: two quick clicks enter edit even without a native dblclick (trackpad)", () => {
		renderTab();
		const tab = screen.getByRole("tab", { name: "ao" });
		// Two plain clicks, no dblclick event — mimics a trackpad double-tap that
		// the OS delivers as separate clicks.
		fireEvent.click(tab, { detail: 1 });
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
		fireEvent.click(tab, { detail: 1 });
		expect(screen.getByRole("textbox", { name: /rename terminal/i })).toBeInTheDocument();
	});

	it("Windows: right-click enters edit, double-click does not", () => {
		isWindowsPlatform.mockReturnValue(true);
		renderTab();
		const tab = screen.getByRole("tab", { name: "ao" });
		fireEvent.doubleClick(tab);
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
		fireEvent.contextMenu(tab);
		expect(screen.getByRole("textbox", { name: /rename terminal/i })).toBeInTheDocument();
	});
});
