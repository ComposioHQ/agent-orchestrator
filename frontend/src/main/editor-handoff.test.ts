// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createEditorHandoff, type EditorHandoffDeps } from "./editor-handoff";

function deps(overrides: Partial<EditorHandoffDeps> = {}): EditorHandoffDeps {
	return {
		platform: "darwin",
		env: { PATH: "/bin" },
		homeDir: "/Users/tester",
		resolveWorkspace: vi.fn().mockResolvedValue("/worktrees/ao-1"),
		readPreference: vi.fn().mockResolvedValue("cursor"),
		writePreference: vi.fn().mockResolvedValue(undefined),
		launch: vi.fn().mockResolvedValue(undefined),
		openDirectory: vi.fn().mockResolvedValue(undefined),
		isExecutable: (candidatePath) => candidatePath === "/bin/code",
		isDirectory: (candidatePath) => candidatePath === "/Applications/Cursor.app",
		...overrides,
	};
}

describe("editor handoff", () => {
	it("detects Dock-installed apps and keeps Finder and Terminal as safe fallbacks", async () => {
		const handoff = createEditorHandoff(deps());
		const state = await handoff.getState("ao-1");
		expect(state).toMatchObject({ preferredEditorId: "cursor", workspaceAvailable: true });
		expect(state.targets.map(({ id }) => id)).toEqual(["cursor", "vscode", "file-manager", "terminal"]);
	});

	it("reports a missing workspace without hiding the available targets", async () => {
		const handoff = createEditorHandoff(deps({
			resolveWorkspace: vi.fn().mockRejectedValue(new Error("Session workspace is not available.")),
		}));
		const state = await handoff.getState("ao-1");
		expect(state.workspaceAvailable).toBe(false);
		expect(state.unavailableReason).toBe("Session workspace is not available.");
		expect(state.targets).toHaveLength(4);
	});

	it("opens only the workspace root and persists a chosen editor", async () => {
		const input = deps();
		const handoff = createEditorHandoff(input);
		await expect(handoff.open({ sessionId: "ao-1", targetId: "vscode" })).resolves.toMatchObject({
			id: "vscode",
			kind: "editor",
		});
		expect(input.launch).toHaveBeenCalledWith("/bin/code", ["/worktrees/ao-1"], "/worktrees/ao-1");
		expect(input.writePreference).toHaveBeenCalledWith("vscode");
	});

	it("opens Finder without changing the editor preference", async () => {
		const input = deps();
		const handoff = createEditorHandoff(input);
		await handoff.open({ sessionId: "ao-1", targetId: "file-manager" });
		expect(input.openDirectory).toHaveBeenCalledWith("/worktrees/ao-1");
		expect(input.writePreference).not.toHaveBeenCalled();
	});

	it("does not silently replace a missing preferred editor", async () => {
		const handoff = createEditorHandoff(deps({
			isExecutable: () => false,
			isDirectory: () => false,
		}));
		await expect(handoff.open({ sessionId: "ao-1" })).rejects.toThrow(
			"That editor is not installed. Choose another option.",
		);
	});

	it("turns a launcher failure into a visible path-free error", async () => {
		const input = deps({ launch: vi.fn().mockRejectedValue(new Error("/private/path failed")) });
		const handoff = createEditorHandoff(input);
		await expect(handoff.open({ sessionId: "ao-1", targetId: "vscode" })).rejects.toThrow(
			"Could not open VS Code. Check that it is installed and try again.",
		);
	});
});
