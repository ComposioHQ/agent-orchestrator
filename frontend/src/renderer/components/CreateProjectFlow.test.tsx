import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreateProjectFlow, type CloneProjectInput, type CreateProjectInput } from "./CreateProjectFlow";

const bridgeMocks = vi.hoisted(() => ({
	checkAncestorRepo: vi.fn(),
	chooseDirectory: vi.fn(),
	scanImportFolder: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
	POST: vi.fn(),
	apiErrorMessage: vi.fn((error: unknown, fallback = "Request failed") =>
		typeof error === "object" && error !== null && "message" in error ? String((error as { message?: unknown }).message) : fallback,
	),
}));

vi.mock("../lib/bridge", () => ({
	aoBridge: {
		app: {
			checkAncestorRepo: bridgeMocks.checkAncestorRepo,
			chooseDirectory: bridgeMocks.chooseDirectory,
			scanImportFolder: bridgeMocks.scanImportFolder,
		},
	},
}));

vi.mock("../lib/api-client", () => ({
	apiClient: {
		POST: apiMocks.POST,
	},
	apiErrorMessage: apiMocks.apiErrorMessage,
}));

// Cloud stand-ins: the flow only consumes the gate flag, the session status,
// and the typed client's createProject; everything else stays out of scope.
const cloudMocks = vi.hoisted(() => ({
	cloudEnabled: false,
	sessionStatus: "unauthenticated",
	createProject: vi.fn(),
	signIn: vi.fn(),
}));

vi.mock("../hooks/useCloudGate", () => ({
	useCloudGate: () => ({ cloudEnabled: cloudMocks.cloudEnabled, localEnabled: true, client: "" }),
}));

vi.mock("../lib/cloud-session", () => ({
	useCloudSession: () => ({
		configured: true,
		session: null,
		status: cloudMocks.sessionStatus,
		signIn: cloudMocks.signIn,
		signOut: async () => undefined,
	}),
}));

vi.mock("../hooks/useCloudCp", () => ({
	useCloudCp: () => ({
		client: { createProject: cloudMocks.createProject },
		ready: cloudMocks.cloudEnabled && cloudMocks.sessionStatus === "authenticated",
		baseUrl: "https://cp.example.com",
	}),
}));

vi.mock("../hooks/useCloudOrg", () => ({
	useCloudOrg: () => ({
		org: { id: "org-1", slug: "acme", displayName: "Acme", role: "admin" },
		isLoading: false,
		error: undefined,
		ready: true,
	}),
}));

// The cloud form invalidates the workspace query via useQueryClient, so cloud
// tests render inside a provider. Local-only tests don't need one.
function CloudTestProviders({ children }: { children: ReactNode }) {
	const [queryClient] = useState(() => new QueryClient());
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

// Probe stand-in: the real sheet needs a QueryClientProvider + agent catalog to
// render. These tests only care which path/kind CreateProjectFlow hands it and
// whether it's open, so a thin stub keeps the suite fast and focused.
vi.mock("./CreateProjectAgentSheet", () => ({
	CreateProjectAgentSheet: ({
		kind,
		open,
		path,
	}: {
		kind: string;
		open: boolean;
		path: string | null;
	}) => (open ? <div data-kind={kind} data-path={path ?? ""} data-testid="agent-sheet" /> : null),
}));

// Probe stand-in: the real dialog needs its own form state and validation.
// These tests only care whether the clone flow is on screen and that the
// droppedPath guard leaves it alone, so a thin stub keeps the suite focused.
vi.mock("./CloneRepositoryDialog", () => ({
	default: ({ open }: { open: boolean }) => (open ? <div data-testid="clone-dialog" /> : null),
}));

function okScan(path: string) {
	return {
		path,
		repos: [
			{
				branch: "main",
				hasRemote: true,
				name: "proj",
				path,
				relativePath: ".",
				remote: "git@github.com:example/proj.git",
				status: "ok" as const,
			},
		],
	};
}

const noop = {
	onCloneProject: async (_input: CloneProjectInput) => undefined,
	onCreateProject: async (_input: CreateProjectInput) => undefined,
	onInitializeProject: async (_path: string) => undefined,
};

function renderChooseFlow(props: Partial<ComponentProps<typeof CreateProjectFlow>> = {}) {
	return render(
		<CreateProjectFlow mode="choose" {...noop} {...props}>
			{({ choosePath, disabled, label }) => (
				<button type="button" disabled={disabled} onClick={choosePath}>
					{label}
				</button>
			)}
		</CreateProjectFlow>,
	);
}

beforeEach(() => {
	bridgeMocks.checkAncestorRepo.mockReset().mockResolvedValue(undefined);
	bridgeMocks.chooseDirectory.mockReset();
	bridgeMocks.scanImportFolder.mockReset().mockImplementation(async ({ path }: { path: string }) => okScan(path));
	apiMocks.POST.mockReset();
	apiMocks.apiErrorMessage.mockClear();
	cloudMocks.cloudEnabled = false;
	cloudMocks.sessionStatus = "unauthenticated";
	cloudMocks.createProject.mockReset();
	cloudMocks.signIn.mockReset();
});

function workspaceValidation(path: string, childRepos: Array<Partial<{
	repoPath: string;
	isRepo: boolean;
	hasCommit: boolean;
	hasOrigin: boolean;
	isEmptyFolder: boolean;
	needsGitInit: boolean;
	requiredActions: string[];
	blockingErrors: string[];
}>>) {
	return {
		importKind: "workspace",
		isValid: true,
		blockingErrors: [],
		root: {
			repoPath: path,
			isRepo: false,
			hasCommit: false,
			hasOrigin: false,
			isEmptyFolder: false,
			needsGitInit: true,
			requiredActions: ["git_init", "git_commit", "set_remote"],
			blockingErrors: [],
		},
		childRepos: childRepos.map((repo, index) => ({
			repoPath: repo.repoPath ?? `${path}/repo-${index + 1}`,
			isRepo: repo.isRepo ?? true,
			hasCommit: repo.hasCommit ?? true,
			hasOrigin: repo.hasOrigin ?? true,
			isEmptyFolder: repo.isEmptyFolder ?? false,
			needsGitInit: repo.needsGitInit ?? false,
			requiredActions: repo.requiredActions ?? [],
			blockingErrors: repo.blockingErrors ?? [],
		})),
		nextStep: childRepos.some((repo) => (repo.requiredActions?.length ?? 0) > 0) ? "prepare_git" : "continue",
	};
}

describe("CreateProjectFlow droppedPath", () => {
	it("does not open on mount", () => {
		render(<CreateProjectFlow mode="choose" {...noop} droppedPath={null} />);
		expect(screen.queryByRole("button", { name: "Add a workspace folder" })).not.toBeInTheDocument();
	});

	it("opens the mode picker without invoking the native folder chooser", async () => {
		const { rerender } = render(<CreateProjectFlow mode="choose" {...noop} droppedPath={null} />);

		rerender(<CreateProjectFlow mode="choose" {...noop} droppedPath={{ nonce: 1, path: "/dropped/proj" }} />);

		expect(await screen.findByRole("button", { name: "Open local repository" })).toBeInTheDocument();
		expect(bridgeMocks.chooseDirectory).not.toHaveBeenCalled();
	});

	it("uses the dropped path for preflight and opens the agent sheet, skipping the native dialog", async () => {
		const user = userEvent.setup();
		const { rerender } = render(<CreateProjectFlow mode="choose" {...noop} droppedPath={null} />);
		rerender(<CreateProjectFlow mode="choose" {...noop} droppedPath={{ nonce: 1, path: "/dropped/proj" }} />);

		await user.click(await screen.findByRole("button", { name: "Open local repository" }));

		await waitFor(() =>
			expect(bridgeMocks.scanImportFolder).toHaveBeenCalledWith({ mode: "project", path: "/dropped/proj" }),
		);
		expect(bridgeMocks.chooseDirectory).not.toHaveBeenCalled();
		const sheet = await screen.findByTestId("agent-sheet");
		expect(sheet).toHaveAttribute("data-path", "/dropped/proj");
		expect(sheet).toHaveAttribute("data-kind", "single_repo");
	});

	it("does not let a stale dropped path leak into the next manual New Project click", async () => {
		const user = userEvent.setup();
		bridgeMocks.chooseDirectory.mockResolvedValue("/manually/chosen");
		const { rerender } = render(
			<CreateProjectFlow mode="choose" {...noop} droppedPath={null} openSignal={0} />,
		);

		// Drop a folder, then dismiss the mode picker without picking a kind.
		rerender(<CreateProjectFlow mode="choose" {...noop} droppedPath={{ nonce: 1, path: "/dropped/proj" }} openSignal={0} />);
		await user.click(await screen.findByRole("button", { name: "Close new project dialog" }));
		await waitFor(() => expect(screen.queryByRole("button", { name: "Open local repository" })).not.toBeInTheDocument());

		// A manual "New Project" (⌘N-style openSignal bump) must fall back to the
		// native dialog, not silently reuse the dismissed drop's path.
		rerender(<CreateProjectFlow mode="choose" {...noop} droppedPath={{ nonce: 1, path: "/dropped/proj" }} openSignal={1} />);
		await user.click(await screen.findByRole("button", { name: "Open local repository" }));

		await waitFor(() => expect(bridgeMocks.chooseDirectory).toHaveBeenCalledTimes(1));
		await waitFor(() =>
			expect(bridgeMocks.scanImportFolder).toHaveBeenCalledWith({ mode: "project", path: "/manually/chosen" }),
		);
	});

	it("ignores a drop while the agent sheet is already open", async () => {
		const user = userEvent.setup();
		const { rerender } = render(<CreateProjectFlow mode="choose" {...noop} droppedPath={null} />);
		rerender(<CreateProjectFlow mode="choose" {...noop} droppedPath={{ nonce: 1, path: "/dropped/first" }} />);
		await user.click(await screen.findByRole("button", { name: "Open local repository" }));
		const sheet = await screen.findByTestId("agent-sheet");
		expect(sheet).toHaveAttribute("data-path", "/dropped/first");

		// A second, different folder is dropped while the agent sheet is open.
		rerender(<CreateProjectFlow mode="choose" {...noop} droppedPath={{ nonce: 2, path: "/dropped/second" }} />);

		expect(screen.getByTestId("agent-sheet")).toHaveAttribute("data-path", "/dropped/first");
		expect(screen.queryByRole("button", { name: "Open local repository" })).not.toBeInTheDocument();
	});

	it("ignores a drop while the clone-from-Git dialog is open", async () => {
		const user = userEvent.setup();
		const { rerender } = render(
			<CreateProjectFlow mode="choose" {...noop} droppedPath={null} openSignal={0} />,
		);

		// Open the mode picker manually and switch to the clone flow.
		rerender(<CreateProjectFlow mode="choose" {...noop} droppedPath={null} openSignal={1} />);
		await user.click(await screen.findByRole("button", { name: "Clone from Git" }));
		expect(await screen.findByTestId("clone-dialog")).toBeInTheDocument();

		// A folder is dropped while the clone dialog is on screen.
		rerender(
			<CreateProjectFlow mode="choose" {...noop} droppedPath={{ nonce: 1, path: "/dropped/proj" }} openSignal={1} />,
		);

		expect(screen.getByTestId("clone-dialog")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Open local repository" })).not.toBeInTheDocument();
		expect(bridgeMocks.chooseDirectory).not.toHaveBeenCalled();
	});
});

describe("CreateProjectFlow workspace import validation", () => {
	it("continues to agent selection when workspace children are ready", async () => {
		const user = userEvent.setup();
		bridgeMocks.chooseDirectory.mockResolvedValue("/workspace");
		apiMocks.POST.mockResolvedValueOnce({ data: workspaceValidation("/workspace", [{ repoPath: "/workspace/api" }]) });

		renderChooseFlow();
		await user.click(screen.getByRole("button", { name: "New project" }));
		await user.click(await screen.findByRole("button", { name: "Add a workspace folder" }));

		await waitFor(() =>
			expect(apiMocks.POST).toHaveBeenCalledWith("/api/v1/imports/validate", {
				body: { importKind: "workspace", path: "/workspace" },
			}),
		);
		const sheet = await screen.findByTestId("agent-sheet");
		expect(sheet).toHaveAttribute("data-kind", "workspace");
		expect(sheet).toHaveAttribute("data-path", "/workspace");
	});

	it("shows validation failure before agent selection", async () => {
		const user = userEvent.setup();
		bridgeMocks.chooseDirectory.mockResolvedValue("/bad-workspace");
		apiMocks.POST.mockResolvedValueOnce({
			data: {
				...workspaceValidation("/bad-workspace", []),
				isValid: false,
				blockingErrors: ["INVALID_PATH"],
				nextStep: "error",
			},
		});

		renderChooseFlow();
		await user.click(screen.getByRole("button", { name: "New project" }));
		await user.click(await screen.findByRole("button", { name: "Add a workspace folder" }));

		expect(await screen.findByText("Choose a folder AO can read.")).toBeInTheDocument();
		expect(screen.queryByTestId("agent-sheet")).not.toBeInTheDocument();
	});

	it("shows only each workspace child's missing preparation steps", async () => {
		const user = userEvent.setup();
		bridgeMocks.chooseDirectory.mockResolvedValue("/workspace");
		apiMocks.POST.mockResolvedValueOnce({
			data: workspaceValidation("/workspace", [
				{ repoPath: "/workspace/ready" },
				{ repoPath: "/workspace/unborn", hasCommit: false, hasOrigin: false, requiredActions: ["git_commit", "set_remote"] },
				{ repoPath: "/workspace/plain", isRepo: false, needsGitInit: true, requiredActions: ["git_init", "git_commit", "set_remote"] },
			]),
		});

		renderChooseFlow();
		await user.click(screen.getByRole("button", { name: "New project" }));
		await user.click(await screen.findByRole("button", { name: "Add a workspace folder" }));

		expect(await screen.findByText("Prepare workspace repositories")).toBeInTheDocument();
		expect(screen.getByText("Workspace root")).toBeInTheDocument();
		expect(screen.getByText("/workspace/ready")).toBeInTheDocument();
		expect(screen.getByText("/workspace/unborn")).toBeInTheDocument();
		expect(screen.getByText("/workspace/plain")).toBeInTheDocument();
		expect(screen.getAllByText("Git initialization")).toHaveLength(1);
		expect(screen.getAllByText("initial commit")).toHaveLength(2);
		expect(screen.getAllByText("remote setup")).toHaveLength(2);
	});

	it("prepares workspace repositories and then opens agent selection", async () => {
		const user = userEvent.setup();
		bridgeMocks.chooseDirectory.mockResolvedValue("/workspace");
		apiMocks.POST
			.mockResolvedValueOnce({
				data: workspaceValidation("/workspace", [
					{ repoPath: "/workspace/no-remote", hasOrigin: false, requiredActions: ["set_remote"] },
					{ repoPath: "/workspace/plain", isRepo: false, needsGitInit: true, requiredActions: ["git_init", "git_commit", "set_remote"] },
				]),
			})
			.mockResolvedValueOnce({
				data: {
					events: [
						{ repoPath: "/workspace/no-remote", action: "set_remote", state: "pending" },
						{ repoPath: "/workspace/no-remote", action: "set_remote", state: "running" },
						{ repoPath: "/workspace/no-remote", action: "set_remote", state: "success" },
						{ repoPath: "/workspace/plain", action: "git_init", state: "pending" },
						{ repoPath: "/workspace/plain", action: "git_init", state: "running" },
						{ repoPath: "/workspace/plain", action: "git_init", state: "success" },
					],
					validation: workspaceValidation("/workspace", [{ repoPath: "/workspace/no-remote" }, { repoPath: "/workspace/plain" }]),
				},
			});

		renderChooseFlow();
		await user.click(screen.getByRole("button", { name: "New project" }));
		await user.click(await screen.findByRole("button", { name: "Add a workspace folder" }));
		const remoteInputs = await screen.findAllByLabelText("Repository URL");
		await user.type(remoteInputs[0], "https://example.invalid/plain.git");
		await user.type(remoteInputs[1], "https://example.invalid/no-remote.git");
		await user.click(screen.getByRole("button", { name: "Continue" }));

		await waitFor(() =>
			expect(apiMocks.POST).toHaveBeenLastCalledWith("/api/v1/imports/prepare-git", {
				body: {
					importKind: "workspace",
					path: "/workspace",
					repositories: [
						{
							repoPath: "/workspace/no-remote",
							approvedActions: ["set_remote"],
							remoteUrl: "https://example.invalid/no-remote.git",
						},
						{
							repoPath: "/workspace/plain",
							approvedActions: ["git_init", "git_commit", "set_remote"],
							remoteUrl: "https://example.invalid/plain.git",
						},
					],
				},
			}),
		);
		expect(await screen.findByTestId("agent-sheet")).toHaveAttribute("data-kind", "workspace");
	});

	it("keeps partial preparation failures in the workspace preparation dialog", async () => {
		const user = userEvent.setup();
		bridgeMocks.chooseDirectory.mockResolvedValue("/workspace");
		apiMocks.POST
			.mockResolvedValueOnce({
				data: workspaceValidation("/workspace", [
					{ repoPath: "/workspace/api", hasOrigin: false, requiredActions: ["set_remote"] },
				]),
			})
			.mockResolvedValueOnce({
				data: {
					events: [
						{ repoPath: "/workspace/api", action: "set_remote", state: "pending" },
						{ repoPath: "/workspace/api", action: "set_remote", state: "running" },
						{ repoPath: "/workspace/api", action: "set_remote", state: "error" },
					],
					validation: workspaceValidation("/workspace", [
						{ repoPath: "/workspace/api", hasOrigin: false, requiredActions: ["set_remote"] },
					]),
				},
			});

		renderChooseFlow();
		await user.click(screen.getByRole("button", { name: "New project" }));
		await user.click(await screen.findByRole("button", { name: "Add a workspace folder" }));
		await user.type(await screen.findByLabelText("Repository URL"), "https://example.invalid/api.git");
		await user.click(screen.getByRole("button", { name: "Continue" }));

		expect((await screen.findAllByText(/api failed while running remote setup/i)).length).toBeGreaterThan(0);
		expect(screen.queryByTestId("agent-sheet")).not.toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Back to code source" })).toBeInTheDocument();
		});
	});

describe("CreateProjectFlow cloud offering", () => {
	it("hides the Local | Cloud choice when the cloud gate is off", () => {
		cloudMocks.sessionStatus = "authenticated";
		render(<CreateProjectFlow embedded mode="choose" {...noop} />, { wrapper: CloudTestProviders });

		expect(screen.queryByRole("tab", { name: "Cloud" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Open local repository" })).toBeInTheDocument();
	});

	it("shows the Cloud choice and sign-in prompt when the user is signed out", async () => {
		cloudMocks.cloudEnabled = true;
		const user = userEvent.setup();
		render(<CreateProjectFlow embedded mode="choose" {...noop} />, { wrapper: CloudTestProviders });

		expect(screen.getByRole("tab", { name: "Local", selected: true })).toBeInTheDocument();
		await user.click(screen.getByRole("tab", { name: "Cloud" }));
		expect(screen.getByText(/sign in to AO Cloud to create a cloud project/i)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Sign in to AO Cloud" }));
		expect(cloudMocks.signIn).toHaveBeenCalledOnce();
	});

	it("shows the choice defaulting to Local when the gate is on and the user is signed in", () => {
		cloudMocks.cloudEnabled = true;
		cloudMocks.sessionStatus = "authenticated";
		render(<CreateProjectFlow embedded mode="choose" {...noop} />, { wrapper: CloudTestProviders });

		expect(screen.getByRole("tab", { name: "Local", selected: true })).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "Cloud", selected: false })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Open local repository" })).toBeInTheDocument();
	});

	it("creates a cloud project through the control-plane client instead of the daemon flow", async () => {
		cloudMocks.cloudEnabled = true;
		cloudMocks.sessionStatus = "authenticated";
		cloudMocks.createProject.mockResolvedValue({ project: { id: "cp-1" } });
		const onCreateProject = vi.fn();
		const user = userEvent.setup();
		render(<CreateProjectFlow embedded mode="choose" {...noop} onCreateProject={onCreateProject} />, {
			wrapper: CloudTestProviders,
		});

		await user.click(screen.getByRole("tab", { name: "Cloud" }));
		await user.type(screen.getByLabelText("Repository URL"), "https://github.com/acme/web-app");
		await user.type(screen.getByLabelText("Project name"), "web-app");
		await user.click(screen.getByRole("button", { name: "Create cloud project" }));

		await waitFor(() =>
			expect(cloudMocks.createProject).toHaveBeenCalledWith("org-1", {
				displayName: "web-app",
				repositoryUrl: "https://github.com/acme/web-app",
				defaultBranch: "main",
			}),
		);
		expect(onCreateProject).not.toHaveBeenCalled();
		expect(bridgeMocks.chooseDirectory).not.toHaveBeenCalled();
	});

	it("blocks a non-https repository URL without calling the control plane", async () => {
		cloudMocks.cloudEnabled = true;
		cloudMocks.sessionStatus = "authenticated";
		const user = userEvent.setup();
		render(<CreateProjectFlow embedded mode="choose" {...noop} />, { wrapper: CloudTestProviders });

		await user.click(screen.getByRole("tab", { name: "Cloud" }));
		await user.type(screen.getByLabelText("Repository URL"), "git@github.com:acme/web-app.git");
		await user.type(screen.getByLabelText("Project name"), "web-app");
		await user.click(screen.getByRole("button", { name: "Create cloud project" }));

		expect(await screen.findByText("Enter an https repository URL.")).toBeInTheDocument();
		expect(cloudMocks.createProject).not.toHaveBeenCalled();
	});
});
