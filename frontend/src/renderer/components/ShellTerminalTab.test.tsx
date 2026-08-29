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

	it("makes the full connected tile the semantic selection button", () => {
		const { onSelect } = renderTab({ appearance: "connected" });
		const tab = screen.getByRole("tab", { name: "ao" });
		expect(tab).toHaveClass("h-full", "min-w-0", "pl-2", "cursor-pointer", "focus-visible:outline-2");
		fireEvent.click(tab);
		expect(onSelect).toHaveBeenCalledOnce();
	});

	it("cross-fades the terminal glyph into close on hover instead of reserving a trailing close column", () => {
		renderTab({ appearance: "connected", isActive: true });

		const closeButton = screen.getByRole("button", { name: "Close terminal ao" });
		expect(closeButton).toHaveClass(
			"absolute",
			"opacity-0",
			"pointer-events-none",
			"group-hover:opacity-100",
			"duration-fast",
		);
		expect(closeButton).not.toHaveClass("w-control-sm");
		expect(screen.getByRole("tab", { name: "ao" }).querySelector("svg")).toHaveClass(
			"group-hover:opacity-0",
			"duration-fast",
		);
		expect(screen.getByRole("tab", { name: "ao" })).toHaveAttribute("aria-selected", "true");
	});

	it("hugs the truncated title instead of a fixed connected width", () => {
		renderTab({ appearance: "connected", isActive: false });

		const tab = screen.getByRole("tab", { name: "ao" });
		expect(tab.classList.contains("min-w-0")).toBe(true);
		expect(tab.classList.contains("text-left")).toBe(true);
		expect(tab.parentElement?.classList.contains("inline-flex")).toBe(true);
		expect(tab.parentElement?.classList.contains("shrink-0")).toBe(true);
		expect(tab.parentElement?.classList.contains("max-w-shell-tab-max")).toBe(true);
		expect(tab.parentElement?.classList.contains("w-shell-tab-connected")).toBe(false);
		expect(tab.parentElement?.classList.contains("min-w-shell-tab-min")).toBe(false);
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

	it("places the active connected-terminal indicator along the bottom edge", () => {
		renderTab({ appearance: "connected", isActive: true });

		const classes = screen.getByRole("tab", { name: "ao" }).parentElement?.classList;
		expect(classes?.contains("after:bottom-0")).toBe(true);
		expect(classes?.contains("after:top-0")).toBe(false);
	});

	it("closes from the glyph slot without selecting the tab", () => {
		const { onClose, onSelect } = renderTab({ appearance: "connected" });
		fireEvent.click(screen.getByRole("button", { name: "Close terminal ao" }));
		expect(onClose).toHaveBeenCalledOnce();
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("optically centers the auxiliary terminal glyph with its label", () => {
		renderTab({ appearance: "connected" });

		expect(screen.getByRole("tab", { name: "ao" }).parentElement?.querySelector("svg")).toHaveClass("translate-y-px");
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
