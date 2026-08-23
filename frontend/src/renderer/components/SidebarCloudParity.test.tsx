// Local and cloud projects must render through the SAME sidebar, board, and
// session components — no forked UI. These cases assert that by driving one
// Sidebar with two projects that differ only by `location`, and checking that
// every rendered affordance matches except the two places where a cloud project
// is deliberately different: the cloud marker, and the local-only project
// settings/removal actions that have no hosted route yet.

import { SidebarProvider } from "@/components/ui/sidebar";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("motion/react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("motion/react")>();
	return {
		...actual,
		AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
	};
});

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";
import { useCloudStore } from "../stores/cloud-store";
import type { WorkspaceSession, WorkspaceSummary } from "../types/workspace";
import { agentsQueryKey } from "../hooks/useAgentsQuery";

const { navigateMock, mockParams, updateStatusMock } = vi.hoisted(() => ({
	navigateMock: vi.fn(),
	mockParams: { projectId: undefined as string | undefined, sessionId: undefined as string | undefined },
	updateStatusMock: vi.fn(),
}));

vi.mock("../lib/rename-session", () => ({ renameSession: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/spawn-orchestrator", () => ({ spawnOrchestrator: vi.fn() }));
vi.mock("../hooks/useCommandPaletteEnabled", () => ({ useCommandPaletteEnabled: () => false }));

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		useNavigate: () => navigateMock,
		useParams: () => ({ ...mockParams }),
		useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => unknown }) =>
			select({ location: { pathname: "/" } }),
	};
});

vi.mock("../lib/bridge", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/bridge")>();
	return {
		aoBridge: {
			...actual.aoBridge,
			updates: { ...actual.aoBridge.updates, getStatus: updateStatusMock },
		},
	};
});

vi.mock("../lib/api-client", () => ({
	apiClient: { GET: vi.fn() },
	apiErrorMessage: (error: unknown) => (error instanceof Error ? error.message : "Request failed"),
}));

function workerSession(overrides: Partial<WorkspaceSession> & Pick<WorkspaceSession, "id" | "workspaceId">) {
	return {
		workspaceName: "Project",
		title: "fix login",
		provider: "claude-code",
		kind: "worker",
		branch: "session/fix-login",
		status: "working",
		updatedAt: "2026-08-22T00:00:00Z",
		prs: [],
		...overrides,
	} satisfies WorkspaceSession;
}

const localProject: WorkspaceSummary = {
	id: "local-1",
	name: "Local Project",
	path: "/repo/local-project",
	orchestratorAgent: "claude-code",
	sessions: [workerSession({ id: "local-1-1", workspaceId: "local-1", workspaceName: "Local Project" })],
};

const cloudProject: WorkspaceSummary = {
	id: "cloud-1",
	name: "Cloud Project",
	location: "cloud",
	orgId: "org-1",
	path: "https://github.com/example/cloud-project",
	orchestratorAgent: "claude-code",
	sessions: [
		workerSession({
			id: "cloud-1-1",
			workspaceId: "cloud-1",
			workspaceName: "Cloud Project",
			location: "cloud",
			orgId: "org-1",
		}),
	],
};

function renderSidebar(workspaces: WorkspaceSummary[]) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	queryClient.setQueryData(agentsQueryKey, {
		supported: [{ id: "claude-code", label: "Claude Code" }],
		installed: [{ id: "claude-code", label: "Claude Code" }],
		authorized: [{ id: "claude-code", label: "Claude Code", authStatus: "authorized" }],
	});
	render(
		<QueryClientProvider client={queryClient}>
			<SidebarProvider defaultOpen>
				<Sidebar
					onCloneProject={vi.fn().mockResolvedValue(undefined)}
					onCreateProject={vi.fn().mockResolvedValue(undefined)}
					onInitializeProject={vi.fn().mockResolvedValue(undefined)}
					onRemoveProject={vi.fn().mockResolvedValue(undefined)}
					workspaces={workspaces}
				/>
			</SidebarProvider>
		</QueryClientProvider>,
	);
}

function projectRow(name: string): HTMLElement {
	const row = screen.getByRole("button", { name: new RegExp(`^${name}`) });
	const container = row.closest("li");
	if (!container) throw new Error(`no sidebar row for ${name}`);
	return container;
}

describe("sidebar local/cloud rendering parity", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		updateStatusMock.mockResolvedValue({ state: "idle" });
		useCloudStore.setState({
			availability: { available: true, enabled: true, apiBaseUrl: "https://cloud.example" },
			account: null,
			loaded: true,
			accountLoaded: true,
			saving: false,
			saveError: false,
		});
	});

	it("lists local and cloud projects side by side in one tree", () => {
		renderSidebar([localProject, cloudProject]);

		expect(screen.getByRole("button", { name: /^Local Project/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^Cloud Project/ })).toBeInTheDocument();
	});

	it("gives both projects the same row affordances", async () => {
		renderSidebar([localProject, cloudProject]);

		for (const name of ["Local Project", "Cloud Project"]) {
			const row = projectRow(name);
			expect(within(row).getByRole("button", { name: `Toggle ${name} sessions` })).toBeInTheDocument();
			expect(within(row).getByRole("button", { name: `Project actions for ${name}` })).toBeInTheDocument();
		}
	});

	it("renders a cloud project's sessions through the same session rows as a local one", async () => {
		const user = userEvent.setup();
		renderSidebar([
			{ ...localProject, sessions: [{ ...localProject.sessions[0]!, title: "local task" }] },
			{ ...cloudProject, sessions: [{ ...cloudProject.sessions[0]!, title: "cloud task" }] },
		]);

		// Both come from the same SessionRow component, so they expose the same
		// "Open <title>" affordance and collapse with the same folder toggle.
		expect(screen.getByLabelText("Open local task")).toBeInTheDocument();
		expect(screen.getByLabelText("Open cloud task")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Toggle Cloud Project sessions" }));

		expect(screen.getByLabelText("Open local task")).toBeInTheDocument();
		expect(screen.queryByLabelText("Open cloud task")).not.toBeInTheDocument();
	});

	it("opens a cloud session through the same navigation path as a local one", async () => {
		const user = userEvent.setup();
		renderSidebar([localProject, cloudProject]);

		await user.click(screen.getAllByLabelText("Open fix login")[1]!);

		expect(navigateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				to: "/projects/$projectId/sessions/$sessionId",
				params: { projectId: "cloud-1", sessionId: "cloud-1-1" },
			}),
		);
	});

	it("marks only the cloud project with the cloud badge", () => {
		renderSidebar([localProject, cloudProject]);

		expect(within(projectRow("Local Project")).queryByLabelText("Cloud project")).not.toBeInTheDocument();
		expect(within(projectRow("Cloud Project")).getByLabelText("Cloud project")).toBeInTheDocument();
	});

	it("navigates into a cloud project through the same selection path as a local one", async () => {
		const user = userEvent.setup();
		renderSidebar([localProject, cloudProject]);

		await user.click(screen.getByRole("button", { name: /^Cloud Project/ }));

		expect(navigateMock).toHaveBeenCalledWith(
			expect.objectContaining({ to: "/projects/$projectId", params: { projectId: "cloud-1" } }),
		);
	});

	it("offers project settings and removal on local projects only", async () => {
		const user = userEvent.setup();
		renderSidebar([localProject, cloudProject]);

		await user.click(screen.getByRole("button", { name: "Project actions for Local Project" }));
		expect(await screen.findByRole("menuitem", { name: "Project settings" })).toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: "Remove project" })).toBeInTheDocument();
		await user.keyboard("{Escape}");

		await user.click(screen.getByRole("button", { name: "Project actions for Cloud Project" }));
		expect(await screen.findByRole("menuitem", { name: "New session" })).toBeInTheDocument();
		// The hosted project settings and delete routes do not exist yet, so the
		// cloud project offers neither instead of opening a view that can only fail.
		expect(screen.queryByRole("menuitem", { name: "Project settings" })).not.toBeInTheDocument();
		expect(screen.queryByRole("menuitem", { name: "Remove project" })).not.toBeInTheDocument();
	});
});
