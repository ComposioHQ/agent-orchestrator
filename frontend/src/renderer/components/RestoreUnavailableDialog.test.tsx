import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "../stores/ui-store";
import type { WorkspaceSession, WorkspaceSummary } from "../types/workspace";
import { RestoreUnavailableDialog } from "./RestoreUnavailableDialog";

const { spawnMock, workspaceQueryMock } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
	workspaceQueryMock: vi.fn(),
}));

vi.mock("../hooks/useWorkspaceQuery", () => ({
	useWorkspaceQuery: () => (() => {
		// useWorkspaceQuery returns one section per host now; these fixtures still
		// describe the local host's workspaces, so wrap them in its section.
		const result = workspaceQueryMock();
		return {
			...result,
			data: result.data
				? [{ host: "local", label: "Local", status: "ready", workspaces: result.data, failure: null }]
				: undefined,
		};
	})(),
}));

vi.mock("../lib/spawn-orchestrator", () => ({
	spawnOrchestrator: spawnMock,
}));

const session: WorkspaceSession = {
	host: "local",
	id: "orch-old",
	workspaceId: "proj-1",
	workspaceName: "Project One",
	title: "orchestrator",
	provider: "codex",
	kind: "orchestrator",
	status: "terminated",
	updatedAt: "2026-07-26T00:00:00Z",
	prs: [],
};

const workspace: WorkspaceSummary = {
	host: "local",
	id: "proj-1",
	name: "Project One",
	path: "/repo/project-one",
	orchestratorAgent: "codex",
	sessions: [session],
};

beforeEach(() => {
	vi.clearAllMocks();
	useUiStore.setState({ settingsModal: null });
	workspaceQueryMock.mockReturnValue({ data: [workspace], isLoading: false });
});

describe("RestoreUnavailableDialog", () => {
	it("opens project settings instead of recreating when no orchestrator agent is configured", async () => {
		const onOpenChange = vi.fn();
		const onRecreated = vi.fn();
		workspaceQueryMock.mockReturnValue({
			data: [{ ...workspace, orchestratorAgent: undefined }],
			isLoading: false,
		});
		render(
			<RestoreUnavailableDialog
				open
				session={session}
				onOpenChange={onOpenChange}
				onRecreated={onRecreated}
			/>,
		);

		await userEvent.click(screen.getByRole("button", { name: "Configure orchestrator agent" }));

		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(useUiStore.getState().settingsModal).toEqual({ scope: "project", project: { host: "local", id: "proj-1" } });
		expect(spawnMock).not.toHaveBeenCalled();
		expect(onRecreated).not.toHaveBeenCalled();
	});

	it("preserves clean recreation when an orchestrator agent is configured", async () => {
		const onOpenChange = vi.fn();
		const onRecreated = vi.fn();
		spawnMock.mockResolvedValue("orch-new");
		render(
			<RestoreUnavailableDialog
				open
				session={session}
				onOpenChange={onOpenChange}
				onRecreated={onRecreated}
			/>,
		);

		await userEvent.click(screen.getByRole("button", { name: "Create new orchestrator" }));

		await waitFor(() => expect(onRecreated).toHaveBeenCalledWith("orch-new"));
		expect(spawnMock).toHaveBeenCalledWith({ host: "local", id: "proj-1" }, "restore_dialog", true);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
