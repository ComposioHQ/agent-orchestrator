import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorHandoffState, OpenSessionTargetInput } from "../../shared/editor-handoff";
import { TopbarOpenEditorButton } from "./TopbarOpenEditorButton";

vi.mock("../lib/telemetry", () => ({ captureRendererEvent: vi.fn() }));

const openMock = vi.fn(async ({ targetId }: OpenSessionTargetInput) => {
	if (targetId === "file-manager") return { id: "file-manager" as const, name: "Finder", kind: "file_manager" as const };
	if (targetId === "terminal") return { id: "terminal" as const, name: "Terminal", kind: "terminal" as const };
	if (targetId === "vscode") return { id: "vscode" as const, name: "VS Code", kind: "editor" as const };
	return { id: "cursor" as const, name: "Cursor", kind: "editor" as const };
});

const availableState: EditorHandoffState = {
	targets: [
		{ id: "cursor", name: "Cursor", kind: "editor" },
		{ id: "vscode", name: "VS Code", kind: "editor" },
		{ id: "file-manager", name: "Finder", kind: "file_manager" },
		{ id: "terminal", name: "Terminal", kind: "terminal" },
	],
	preferredEditorId: "cursor",
	workspaceAvailable: true,
};

function setState(state: EditorHandoffState) {
	window.ao!.editorHandoff.getState = vi.fn().mockResolvedValue(state);
	window.ao!.editorHandoff.open = openMock;
}

function renderButton() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<TopbarOpenEditorButton sessionId="sess-1" projectId="proj-1" />
		</QueryClientProvider>,
	);
}

describe("TopbarOpenEditorButton", () => {
	beforeEach(() => {
		openMock.mockClear();
		openMock.mockImplementation(async ({ targetId }: OpenSessionTargetInput) => {
			if (targetId === "file-manager") return { id: "file-manager", name: "Finder", kind: "file_manager" };
			if (targetId === "terminal") return { id: "terminal", name: "Terminal", kind: "terminal" };
			if (targetId === "vscode") return { id: "vscode", name: "VS Code", kind: "editor" };
			return { id: "cursor", name: "Cursor", kind: "editor" };
		});
		setState(availableState);
	});

	it("uses persisted Cursor as the primary target and sends no filesystem path", async () => {
		renderButton();
		const button = await screen.findByRole("button", { name: "Open in Cursor" });
		expect(button).toHaveAttribute("data-priority", "primary");
		expect(button.querySelector("[data-compact-label]")).toHaveTextContent("Open");
		await userEvent.click(button);
		await waitFor(() => expect(openMock).toHaveBeenCalledWith({ sessionId: "sess-1" }));
	});

	it("keeps the no-editor state visible and offers Finder and Terminal", async () => {
		setState({
			targets: [
				{ id: "file-manager", name: "Finder", kind: "file_manager" },
				{ id: "terminal", name: "Terminal", kind: "terminal" },
			],
			preferredEditorId: "cursor",
			workspaceAvailable: true,
		});
		renderButton();
		expect(await screen.findByRole("alert")).toHaveTextContent("No supported editor found");
		expect(screen.getByRole("button", { name: "Choose editor" })).toBeDisabled();
		await userEvent.click(screen.getByRole("button", { name: "Open workspace options" }));
		expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual([
			"Open in Finder",
			"Open in Terminal",
		]);
	});

	it("shows a missing workspace and disables every launch action", async () => {
		setState({
			...availableState,
			workspaceAvailable: false,
			unavailableReason: "Session workspace is not available.",
		});
		renderButton();
		expect(await screen.findByRole("alert")).toHaveTextContent("Session workspace is not available.");
		expect(screen.getByRole("button", { name: "Open in Cursor" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Open workspace options" })).toBeDisabled();
	});

	it("opens safe native fallbacks from the menu", async () => {
		renderButton();
		await userEvent.click(await screen.findByRole("button", { name: "Open workspace options" }));
		await userEvent.click(await screen.findByRole("menuitem", { name: "Open in Finder" }));
		await waitFor(() => expect(openMock).toHaveBeenCalledWith({ sessionId: "sess-1", targetId: "file-manager" }));
	});

	it("updates the primary target after a chosen editor succeeds", async () => {
		renderButton();
		await userEvent.click(await screen.findByRole("button", { name: "Open workspace options" }));
		await userEvent.click(await screen.findByRole("menuitem", { name: "VS Code" }));
		expect(await screen.findByRole("button", { name: "Open in VS Code" })).toBeEnabled();
	});

	it("gives each editor its own mark and keeps real brand color behavior", async () => {
		renderButton();
		await userEvent.click(await screen.findByRole("button", { name: "Open workspace options" }));
		const vscode = await screen.findByRole("menuitem", { name: "VS Code" });
		const cursor = await screen.findByRole("menuitem", { name: "Cursor" });
		expect(vscode.querySelector("svg path")?.getAttribute("d")).not.toEqual(
			cursor.querySelector("svg path")?.getAttribute("d"),
		);
		expect(vscode.querySelector("svg")?.style.color).toBe("rgb(31, 156, 240)");
		expect(cursor.querySelector("svg")?.style.color).toBe("");
	});

	it("surfaces an Electron launch failure", async () => {
		openMock.mockRejectedValueOnce(new Error("Could not open Cursor. Check that it is installed and try again."));
		renderButton();
		await userEvent.click(await screen.findByRole("button", { name: "Open in Cursor" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Could not open Cursor");
	});
});
