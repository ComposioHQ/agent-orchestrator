import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreateProjectFlow, type CloneProjectInput, type CreateProjectInput } from "./CreateProjectFlow";
import { useUiStore } from "../stores/ui-store";

const bridgeMocks = vi.hoisted(() => ({
	checkAncestorRepo: vi.fn(),
	checkGitRepository: vi.fn(),
	chooseDirectory: vi.fn(),
	getRepositoryBranch: vi.fn(),
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
			checkGitRepository: bridgeMocks.checkGitRepository,
			chooseDirectory: bridgeMocks.chooseDirectory,
			getRepositoryBranch: bridgeMocks.getRepositoryBranch,
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
		error,
		kind,
		onSubmit,
		open,
		path,
		shake,
	}: {
		error?: string | null;
		kind: string;
		onSubmit: (selection: { workerAgent: string; orchestratorAgent: string }) => Promise<void>;
		open: boolean;
		path: string | null;
		shake?: boolean;
	}) =>
		open ? (
			<div className={shake ? "modal-shake" : undefined} data-kind={kind} data-path={path ?? ""} data-testid="agent-sheet">
				{error ? <span>{error}</span> : null}
				<button
					type="button"
					onClick={() => void onSubmit({ workerAgent: "codex", orchestratorAgent: "codex" })}
				>
					Submit agents
				</button>
			</div>
		) : null,
}));

// Probe stand-in: the real dialog needs its own form state and validation.
// These tests only care whether the clone flow is on screen and that the
// droppedPath guard leaves it alone, so a thin stub keeps the suite focused.
vi.mock("./CloneRepositoryDialog", () => ({
	default: ({ open, onBack, onChange, onClose, onContinue, value }: {
		onBack?: () => void;
		onChange?: (value: { remoteUrl: string; destinationParent: string }) => void;
		onClose?: () => void;
		onContinue?: (selection: { remoteUrl: string; destinationParent: string; targetPath: string }) => void;
		open: boolean;
		value: { remoteUrl: string; destinationParent: string };
	}) =>
		open ? (
			<div data-testid="clone-dialog">
				<input
					aria-label="Clone URL"
					value={value.remoteUrl}
					onChange={(event) => onChange?.({ ...value, remoteUrl: event.target.value })}
				/>
				<button type="button" onClick={onBack}>Back clone</button>
				<button type="button" onClick={onClose}>Close clone</button>
				<button type="button" onClick={() => onContinue?.({ remoteUrl: "file:///source/empty-repository.git", destinationParent: "/repo", targetPath: "/repo/empty-repository" })}>
					Continue clone
				</button>
			</div>
		) : null,
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

function projectValidation(
	path: string,
	overrides: Partial<{
		isValid: boolean;
		blockingErrors: string[];
		nextStep: "error" | "choose_import_kind" | "prepare_git" | "continue";
		root: Partial<{
			repoPath: string;
			isRepo: boolean;
			hasCommit: boolean;
			hasOrigin: boolean;
			isEmptyFolder: boolean;
			needsGitInit: boolean;
			requiredActions: string[];
			blockingErrors: string[];
		}>;
		childRepos: Array<{
			repoPath: string;
			isRepo: boolean;
			hasCommit: boolean;
			hasOrigin: boolean;
			isEmptyFolder: boolean;
			needsGitInit: boolean;
			requiredActions: string[];
			blockingErrors: string[];
		}>;
		warning: string;
	}> = {},
) {
	return {
		importKind: "project",
		isValid: overrides.isValid ?? true,
		blockingErrors: overrides.blockingErrors ?? [],
		root: {
			repoPath: overrides.root?.repoPath ?? path,
			isRepo: overrides.root?.isRepo ?? true,
			hasCommit: overrides.root?.hasCommit ?? true,
			hasOrigin: overrides.root?.hasOrigin ?? true,
			isEmptyFolder: overrides.root?.isEmptyFolder ?? false,
			needsGitInit: overrides.root?.needsGitInit ?? false,
			requiredActions: overrides.root?.requiredActions ?? [],
			blockingErrors: overrides.root?.blockingErrors ?? [],
		},
		childRepos: overrides.childRepos,
		nextStep: overrides.nextStep ?? "continue",
		warning: overrides.warning,
	};
}

beforeEach(() => {
	bridgeMocks.checkAncestorRepo.mockReset().mockResolvedValue(undefined);
	bridgeMocks.checkGitRepository.mockReset().mockResolvedValue(true);
	bridgeMocks.chooseDirectory.mockReset();
	bridgeMocks.getRepositoryBranch.mockReset().mockResolvedValue(undefined);
	bridgeMocks.scanImportFolder.mockReset().mockImplementation(async ({ path }: { path: string }) => okScan(path));
	apiMocks.POST.mockReset();
	apiMocks.apiErrorMessage.mockClear();
	cloudMocks.cloudEnabled = false;
	cloudMocks.sessionStatus = "unauthenticated";
	cloudMocks.createProject.mockReset();
	cloudMocks.signIn.mockReset();
	window.localStorage.clear();
	useUiStore.setState({ globalToast: null, globalToasts: [] });
});

describe("CreateProjectFlow droppedPath", () => {
	it("does not open on mount", () => {
		render(<CreateProjectFlow mode="choose" {...noop} droppedPath={null} />);
		expect(screen.queryByRole("button", { name: "Import a workspace folder" })).not.toBeInTheDocument();
	});

	it("opens the mode picker without invoking the native folder chooser", async () => {
		const { rerender } = render(<CreateProjectFlow mode="choose" {...noop} droppedPath={null} />);

		rerender(<CreateProjectFlow mode="choose" {...noop} droppedPath={{ nonce: 1, path: "/dropped/proj" }} />);

		expect(await screen.findByRole("button", { name: "Import an existing project" })).toBeInTheDocument();
		expect(bridgeMocks.chooseDirectory).not.toHaveBeenCalled();
	});

	it("uses the dropped path for preflight and opens the agent sheet, skipping the native dialog", async () => {
		const user = userEvent.setup();
		apiMocks.POST.mockResolvedValueOnce({ data: projectValidation("/dropped/proj") });
		const { rerender } = render(<CreateProjectFlow mode="choose" {...noop} droppedPath={null} />);
		rerender(<CreateProjectFlow mode="choose" {...noop} droppedPath={{ nonce: 1, path: "/dropped/proj" }} />);

		await user.click(await screen.findByRole("button", { name: "Import an existing project" }));

		await waitFor(() =>
			expect(apiMocks.POST).toHaveBeenCalledWith("/api/v1/imports/validate", {
				body: { importKind: "project", path: "/dropped/proj" },
			}),
		);
		expect(bridgeMocks.chooseDirectory).not.toHaveBeenCalled();
		const sheet = await screen.findByTestId("agent-sheet");
		expect(sheet).toHaveAttribute("data-path", "/dropped/proj");
		expect(sheet).toHaveAttribute("data-kind", "single_repo");
	});

	it("does not let a stale dropped path leak into the next manual New Project click", async () => {
		const user = userEvent.setup();
		bridgeMocks.chooseDirectory.mockResolvedValue("/manually/chosen");
		apiMocks.POST.mockResolvedValueOnce({ data: projectValidation("/manually/chosen") });
		const { rerender } = render(
			<CreateProjectFlow mode="choose" {...noop} droppedPath={null} openSignal={0} />,
		);

		// Drop a folder, then dismiss the mode picker without picking a kind.
		rerender(<CreateProjectFlow mode="choose" {...noop} droppedPath={{ nonce: 1, path: "/dropped/proj" }} openSignal={0} />);
		await user.click(await screen.findByRole("button", { name: "Close new project dialog" }));
		await waitFor(() => expect(screen.queryByRole("button", { name: "Import an existing project" })).not.toBeInTheDocument());

		// A manual "New Project" (⌘N-style openSignal bump) must fall back to the
		// native dialog, not silently reuse the dismissed drop's path.
		rerender(<CreateProjectFlow mode="choose" {...noop} droppedPath={{ nonce: 1, path: "/dropped/proj" }} openSignal={1} />);
		await user.click(await screen.findByRole("button", { name: "Import an existing project" }));

		await waitFor(() => expect(bridgeMocks.chooseDirectory).toHaveBeenCalledTimes(1));
		await waitFor(() =>
			expect(apiMocks.POST).toHaveBeenCalledWith("/api/v1/imports/validate", {
				body: { importKind: "project", path: "/manually/chosen" },
			}),
		);
	});

	it("ignores a drop while the agent sheet is already open", async () => {
		const user = userEvent.setup();
		apiMocks.POST.mockResolvedValueOnce({ data: projectValidation("/dropped/first") });
		const { rerender } = render(<CreateProjectFlow mode="choose" {...noop} droppedPath={null} />);
		rerender(<CreateProjectFlow mode="choose" {...noop} droppedPath={{ nonce: 1, path: "/dropped/first" }} />);
		await user.click(await screen.findByRole("button", { name: "Import an existing project" }));
		const sheet = await screen.findByTestId("agent-sheet");
		expect(sheet).toHaveAttribute("data-path", "/dropped/first");

		// A second, different folder is dropped while the agent sheet is open.
		rerender(<CreateProjectFlow mode="choose" {...noop} droppedPath={{ nonce: 2, path: "/dropped/second" }} />);

		expect(screen.getByTestId("agent-sheet")).toHaveAttribute("data-path", "/dropped/first");
		expect(screen.queryByRole("button", { name: "Import an existing project" })).not.toBeInTheDocument();
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
		expect(screen.queryByRole("button", { name: "Import an existing project" })).not.toBeInTheDocument();
		expect(bridgeMocks.chooseDirectory).not.toHaveBeenCalled();
	});

	it("routes an empty clone through Prepare project", async () => {
		const user = userEvent.setup();
		apiMocks.POST
			.mockResolvedValueOnce({ data: { path: "/repo/empty-repository", remoteUrl: "file:///source/empty-repository.git" } })
			.mockResolvedValueOnce({
				data: projectValidation("/repo/empty-repository", {
					nextStep: "prepare_git",
					root: { requiredActions: ["git_commit", "set_remote"], hasCommit: false, hasOrigin: false },
				}),
			});

		render(
			<CreateProjectFlow mode="choose" {...noop}>
				{({ choosePath }) => <button onClick={choosePath}>New project</button>}
			</CreateProjectFlow>,
		);

		await user.click(screen.getByRole("button", { name: "New project" }));
		await user.click(await screen.findByRole("button", { name: "Clone from Git" }));
		fireEvent.click(await screen.findByText("Continue clone"));

		expect(await screen.findByText("Prepare project")).toBeInTheDocument();
		expect(apiMocks.POST).toHaveBeenNthCalledWith(1, "/api/v1/projects/clone/prepare", expect.anything());
		expect(apiMocks.POST).toHaveBeenNthCalledWith(2, "/api/v1/imports/validate", {
			body: { importKind: "project", path: "/repo/empty-repository" },
		});
	});

	it("keeps the clone dialog visible until preparation is ready", async () => {
		const user = userEvent.setup();
		let resolveClone!: (value: unknown) => void;
		let resolveValidation!: (value: unknown) => void;
		apiMocks.POST.mockImplementation((path: string) => {
			if (path === "/api/v1/projects/clone/prepare") {
				return new Promise((resolve) => {
					resolveClone = resolve;
				});
			}
			return new Promise((resolve) => {
				resolveValidation = resolve;
			});
		});

		render(
			<CreateProjectFlow mode="choose" {...noop}>
				{({ choosePath }) => <button onClick={choosePath}>New project</button>}
			</CreateProjectFlow>,
		);

		await user.click(screen.getByRole("button", { name: "New project" }));
		await user.click(await screen.findByRole("button", { name: "Clone from Git" }));
		fireEvent.click(await screen.findByText("Continue clone"));
		expect(screen.getByTestId("clone-dialog")).toBeInTheDocument();

		resolveClone({ data: { path: "/repo/empty-repository", remoteUrl: "file:///source/empty-repository.git" } });
		await waitFor(() => expect(apiMocks.POST).toHaveBeenCalledWith("/api/v1/imports/validate", expect.anything()));
		expect(screen.getByTestId("clone-dialog")).toBeInTheDocument();
		resolveValidation({ data: projectValidation("/repo/empty-repository", { nextStep: "prepare_git" }) });
		expect(await screen.findByText("Prepare project")).toBeInTheDocument();
		expect(screen.queryByTestId("clone-dialog")).not.toBeInTheDocument();
	});

	it("cleans up a checkout when validation fails after cloning", async () => {
		const user = userEvent.setup();
		apiMocks.POST.mockImplementation(async (path: string) => {
			if (path === "/api/v1/projects/clone/prepare") {
				return { data: { path: "/repo/incomplete", remoteUrl: "file:///source/incomplete.git" } };
			}
			if (path === "/api/v1/imports/validate") {
				return { error: { message: "rpc failed: request_id=secret" } };
			}
			return {};
		});

		render(
			<CreateProjectFlow mode="choose" {...noop}>
				{({ choosePath }) => <button onClick={choosePath}>New project</button>}
			</CreateProjectFlow>,
		);

		await user.click(screen.getByRole("button", { name: "New project" }));
		await user.click(await screen.findByRole("button", { name: "Clone from Git" }));
		fireEvent.click(await screen.findByText("Continue clone"));

		await waitFor(() => expect(apiMocks.POST).toHaveBeenCalledWith(
			"/api/v1/projects/clone/cleanup",
			{ body: { path: "/repo/incomplete" } },
		));
		expect(screen.getByTestId("clone-dialog")).toBeInTheDocument();
		expect(useUiStore.getState().globalToast?.body).toBe(
			"AO cloned the repository but could not verify the checkout. Try again.",
		);
		expect(useUiStore.getState().globalToast?.body).not.toContain("request_id");
	});

	it("keeps a failed checkout cleanup retryable before leaving clone", async () => {
		const user = userEvent.setup();
		let cleanupAttempts = 0;
		apiMocks.POST.mockImplementation(async (path: string) => {
			if (path === "/api/v1/projects/clone/prepare") {
				return { data: { path: "/repo/incomplete", remoteUrl: "file:///source/incomplete.git" } };
			}
			if (path === "/api/v1/imports/validate") return { error: { message: "validation unavailable" } };
			if (path === "/api/v1/projects/clone/cleanup") {
				cleanupAttempts += 1;
				return cleanupAttempts === 1 ? { error: { message: "permission denied" } } : {};
			}
			return {};
		});

		render(
			<CreateProjectFlow mode="choose" {...noop}>
				{({ choosePath }) => <button onClick={choosePath}>New project</button>}
			</CreateProjectFlow>,
		);

		await user.click(screen.getByRole("button", { name: "New project" }));
		await user.click(await screen.findByRole("button", { name: "Clone from Git" }));
		fireEvent.click(await screen.findByText("Continue clone"));

		await waitFor(() => expect(cleanupAttempts).toBe(1));
		expect(screen.getByTestId("clone-dialog")).toBeInTheDocument();
		expect(useUiStore.getState().globalToast?.body).toBe(
			"AO could not remove the incomplete checkout. Try again before leaving this flow.",
		);

		fireEvent.click(screen.getByText("Back clone"));
		await waitFor(() => expect(cleanupAttempts).toBe(2));
		expect(await screen.findByRole("button", { name: "Clone from Git" })).toBeInTheDocument();
		expect(screen.queryByTestId("clone-dialog")).not.toBeInTheDocument();
	});

	it("starts clone details fresh each time it opens", async () => {
		const user = userEvent.setup();
		render(
			<CreateProjectFlow mode="choose" {...noop}>
				{({ choosePath }) => <button onClick={choosePath}>New project</button>}
			</CreateProjectFlow>,
		);

		await user.click(screen.getByRole("button", { name: "New project" }));
		await user.click(await screen.findByRole("button", { name: "Clone from Git" }));
		fireEvent.change(await screen.findByLabelText("Clone URL"), { target: { value: "https://example.com/old.git" } });
		fireEvent.click(screen.getByText("Back clone"));
		fireEvent.click(await screen.findByRole("button", { name: "Clone from Git" }));

		expect(await screen.findByLabelText("Clone URL")).toHaveValue("");
	});

	it("keeps clone progress open without offering cancellation", async () => {
		const user = userEvent.setup();
		let finishCreate!: () => void;
		const onCreateProject = vi.fn(() => new Promise<void>((resolve) => {
			finishCreate = resolve;
		}));
		apiMocks.POST
			.mockResolvedValueOnce({ data: { path: "/repo/cloned", remoteUrl: "file:///source/cloned.git" } })
			.mockResolvedValueOnce({ data: projectValidation("/repo/cloned") });

		render(
			<CreateProjectFlow mode="choose" {...noop} onCreateProject={onCreateProject}>
				{({ choosePath }) => <button onClick={choosePath}>New project</button>}
			</CreateProjectFlow>,
		);

		await user.click(screen.getByRole("button", { name: "New project" }));
		await user.click(await screen.findByRole("button", { name: "Clone from Git" }));
		fireEvent.click(await screen.findByText("Continue clone"));
		await user.click(await screen.findByRole("button", { name: "Submit agents" }));
		expect(await screen.findByRole("dialog", { name: "Creating the project" })).toBeInTheDocument();

		expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.getByRole("dialog", { name: "Creating the project" })).toBeInTheDocument();
		expect(screen.queryByTestId("agent-sheet")).not.toBeInTheDocument();

		await act(async () => finishCreate());
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Creating the project" })).not.toBeInTheDocument());
	});
});

describe("CreateProjectFlow project import validation", () => {
	it("opens a registered project before validation or agent selection", async () => {
		const user = userEvent.setup();
		const onOpenExistingProject = vi.fn();
		bridgeMocks.chooseDirectory.mockResolvedValue("/repo/existing/");

		render(
			<CreateProjectFlow
				mode="choose"
				{...noop}
				existingProjectPaths={["/repo/existing"]}
				onOpenExistingProject={onOpenExistingProject}
			>
				{({ choosePath }) => <button onClick={choosePath}>New project</button>}
			</CreateProjectFlow>,
		);

		await user.click(screen.getByRole("button", { name: "New project" }));
		await user.click(await screen.findByRole("button", { name: "Import an existing project" }));

		await waitFor(() => expect(onOpenExistingProject).toHaveBeenCalledWith("/repo/existing"));
		expect(apiMocks.POST).not.toHaveBeenCalled();
		expect(screen.queryByTestId("agent-sheet")).not.toBeInTheDocument();
		expect(useUiStore.getState().globalToasts).toHaveLength(1);
		expect(useUiStore.getState().globalToast).toMatchObject({
			title: "Project already added",
			body: "Opened the registered project for this folder.",
		});
	});

	it("offers to import a repository selected as a workspace as a project", async () => {
		const user = userEvent.setup();
		bridgeMocks.chooseDirectory.mockResolvedValue("/repo/project");
		apiMocks.POST
			.mockResolvedValueOnce({
				data: projectValidation("/repo/project", {
					nextStep: "choose_import_kind",
					warning: "This folder is already a Git project. AO will import it as a project instead of a workspace.",
				}),
			})
			.mockResolvedValueOnce({ data: projectValidation("/repo/project") });

		render(
			<CreateProjectFlow mode="choose" {...noop}>
				{({ choosePath }) => <button onClick={choosePath}>New project</button>}
			</CreateProjectFlow>,
		);

		await user.click(screen.getByRole("button", { name: "New project" }));
		await user.click(await screen.findByRole("button", { name: "Import a workspace folder" }));

		expect(await screen.findByText("This is a single project, not a collection of projects. Import it as a project instead.")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Import as project" })).toBeInTheDocument();
		expect(screen.queryByText("proj")).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Import as project" }));
		expect(screen.queryByTestId("agent-sheet")).not.toBeInTheDocument();

		const sheet = await screen.findByTestId("agent-sheet");
		expect(sheet).toHaveAttribute("data-path", "/repo/project");
		expect(sheet).toHaveAttribute("data-kind", "single_repo");
		expect(screen.queryByRole("dialog", { name: "Import workspace" })).not.toBeInTheDocument();
		expect(apiMocks.POST).toHaveBeenNthCalledWith(2, "/api/v1/imports/validate", {
			body: { importKind: "project", path: "/repo/project" },
		});
	});

	it("uses one shared backdrop while switching between flow modals", async () => {
		const user = userEvent.setup();
		bridgeMocks.chooseDirectory.mockResolvedValue("/repo/project");
		apiMocks.POST.mockResolvedValueOnce({ data: projectValidation("/repo/project", { nextStep: "prepare_git" }) });

		render(
			<CreateProjectFlow mode="choose" {...noop}>
				{({ choosePath }) => <button onClick={choosePath}>New project</button>}
			</CreateProjectFlow>,
		);

		await user.click(screen.getByRole("button", { name: "New project" }));
		await user.click(await screen.findByRole("button", { name: "Import an existing project" }));
		await screen.findByText("Prepare project");

		expect(document.querySelectorAll(".dialog-overlay")).toHaveLength(1);
	});

	it("shows validation failure before agent selection", async () => {
		const user = userEvent.setup();
		bridgeMocks.chooseDirectory.mockResolvedValue("/bad-project");
		apiMocks.POST.mockResolvedValueOnce({
			data: projectValidation("/bad-project", {
				isValid: false,
				blockingErrors: ["INVALID_PATH"],
				nextStep: "error",
			}),
		});

		render(
			<CreateProjectFlow mode="choose" {...noop}>
				{({ choosePath }) => <button onClick={choosePath}>New project</button>}
			</CreateProjectFlow>,
		);

		await user.click(screen.getByRole("button", { name: "New project" }));
		await user.click(await screen.findByRole("button", { name: "Import an existing project" }));

		await waitFor(() => expect(useUiStore.getState().globalToast?.body).toBe("Choose a folder AO can read."));
		expect(screen.queryByTestId("agent-sheet")).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Back to import source" }));
		expect(screen.getByRole("button", { name: "Import an existing project" })).toBeInTheDocument();
	});

	it("continues plain roots with child repositories as projects by default", async () => {
		const user = userEvent.setup();
		bridgeMocks.chooseDirectory.mockResolvedValue("/repo/parent");
		apiMocks.POST.mockResolvedValueOnce({
			data: projectValidation("/repo/parent", {
				nextStep: "choose_import_kind",
				root: {
					isRepo: false,
					hasCommit: false,
					hasOrigin: false,
					needsGitInit: true,
					requiredActions: ["git_init", "git_commit", "set_remote"],
				},
				childRepos: [
					{
						repoPath: "/repo/parent/web",
						isRepo: true,
						hasCommit: true,
						hasOrigin: true,
						isEmptyFolder: false,
						needsGitInit: false,
						requiredActions: [],
						blockingErrors: [],
					},
				],
			}),
		});
		apiMocks.POST.mockResolvedValueOnce({
			data: {
				events: [
					{ repoPath: "/repo/parent", action: "git_init", state: "success" },
					{ repoPath: "/repo/parent", action: "git_commit", state: "success" },
					{ repoPath: "/repo/parent", action: "set_remote", state: "success" },
				],
				validation: projectValidation("/repo/parent"),
			},
		});

		render(
			<CreateProjectFlow mode="choose" {...noop}>
				{({ choosePath }) => <button onClick={choosePath}>New project</button>}
			</CreateProjectFlow>,
		);

		await user.click(screen.getByRole("button", { name: "New project" }));
		await user.click(await screen.findByRole("button", { name: "Import an existing project" }));

		expect(await screen.findByText("This folder contains child Git repos")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Clone from Git" })).not.toBeInTheDocument();
		await user.click(await screen.findByRole("button", { name: "Continue" }));
		expect(await screen.findByRole("dialog", { name: "Prepare project" })).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Continue" }));
		expect(await screen.findByTestId("agent-sheet")).toHaveAttribute("data-path", "/repo/parent");
	});

	it("shows only the missing Git preparation steps for a project root", async () => {
		const user = userEvent.setup();
		bridgeMocks.chooseDirectory.mockResolvedValue("/repo/project");
		apiMocks.POST.mockResolvedValueOnce({
			data: projectValidation("/repo/project", {
				nextStep: "prepare_git",
				root: {
					hasCommit: false,
					hasOrigin: false,
					requiredActions: ["git_commit", "set_remote"],
				},
			}),
		});

		render(
			<CreateProjectFlow mode="choose" {...noop}>
				{({ choosePath }) => <button onClick={choosePath}>New project</button>}
			</CreateProjectFlow>,
		);

		await user.click(screen.getByRole("button", { name: "New project" }));
		await user.click(await screen.findByRole("button", { name: "Import an existing project" }));

		expect(await screen.findByText("Prepare project")).toBeInTheDocument();
		expect(screen.getByText("Project setup")).toBeInTheDocument();
		expect(screen.queryByText("Git initialization")).not.toBeInTheDocument();
		expect(screen.getByText("Initial commit")).toBeInTheDocument();
		expect(screen.getByText("Remote setup")).toBeInTheDocument();
		expect(screen.queryByText("Create the first commit so the project has a usable history.")).not.toBeInTheDocument();
		expect(screen.getByLabelText("Origin remote URL")).toBeInTheDocument();
		expect(
			screen.getByText(
				"To create sessions and PRs successfully, make sure this repository also exists on GitHub and that you can push the default branch to it.",
			),
		).toBeInTheDocument();
		expect(screen.queryByText("Plain folder")).not.toBeInTheDocument();
		expect(screen.queryByText("No commit yet")).not.toBeInTheDocument();
		expect(screen.queryByText("No origin remote")).not.toBeInTheDocument();
	});

	it("shows a project-with-child-repos warning before agent selection", async () => {
		const user = userEvent.setup();
		bridgeMocks.chooseDirectory.mockResolvedValue("/repo/project");
		apiMocks.POST.mockResolvedValueOnce({
			data: projectValidation("/repo/project", {
				warning: "This folder contains child Git repositories and will be imported as one project.",
				childRepos: [{
					repoPath: "/repo/project/child",
					isRepo: true,
					hasCommit: true,
					hasOrigin: true,
					isEmptyFolder: false,
					needsGitInit: false,
					requiredActions: [],
					blockingErrors: [],
				}],
			}),
		});

		render(
			<CreateProjectFlow mode="choose" {...noop}>
				{({ choosePath }) => <button onClick={choosePath}>New project</button>}
			</CreateProjectFlow>,
		);

		await user.click(screen.getByRole("button", { name: "New project" }));
		await user.click(await screen.findByRole("button", { name: "Import an existing project" }));

		expect(await screen.findByText("This folder contains child Git repositories and will be imported as one project.")).toBeInTheDocument();
		expect(screen.queryByTestId("agent-sheet")).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Continue" }));
		expect(await screen.findByTestId("agent-sheet")).toHaveAttribute("data-path", "/repo/project");
		expect(apiMocks.POST).toHaveBeenCalledTimes(1);
	});

	it("prefills a default GitHub remote URL for the selected project", async () => {
		const user = userEvent.setup();
		bridgeMocks.chooseDirectory.mockResolvedValue("/repo/project-no-git");
		apiMocks.POST.mockResolvedValueOnce({
			data: projectValidation("/repo/project-no-git", {
				nextStep: "prepare_git",
				root: {
					hasOrigin: false,
					requiredActions: ["set_remote"],
				},
			}),
		});

		render(
			<CreateProjectFlow mode="choose" {...noop}>
				{({ choosePath }) => <button onClick={choosePath}>New project</button>}
			</CreateProjectFlow>,
		);

		await user.click(screen.getByRole("button", { name: "New project" }));
		await user.click(await screen.findByRole("button", { name: "Import an existing project" }));

		expect(await screen.findByLabelText("Origin remote URL")).toHaveValue(
			"https://github.com/username/project-no-git.git",
		);
	});

	it("requires the user to keep all required setup actions approved", async () => {
		const user = userEvent.setup();
		bridgeMocks.chooseDirectory.mockResolvedValue("/repo/project");
		apiMocks.POST.mockResolvedValueOnce({
			data: projectValidation("/repo/project", {
				nextStep: "prepare_git",
				root: {
					hasOrigin: false,
					requiredActions: ["set_remote"],
				},
			}),
		});

		render(
			<CreateProjectFlow mode="choose" {...noop}>
				{({ choosePath }) => <button onClick={choosePath}>New project</button>}
			</CreateProjectFlow>,
		);

		await user.click(screen.getByRole("button", { name: "New project" }));
		await user.click(await screen.findByRole("button", { name: "Import an existing project" }));

		const remoteAction = screen.getByRole("checkbox");
		expect(remoteAction).toBeChecked();
		await user.click(screen.getByLabelText("Origin remote URL"));
		expect(remoteAction).toBeChecked();
		await user.click(remoteAction);

		expect(screen.getByText("Approve all required setup actions to continue importing this project.")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
	});

	it("prepares the project and then opens agent selection", async () => {
		const user = userEvent.setup();
		bridgeMocks.chooseDirectory.mockResolvedValue("/repo/project");
		apiMocks.POST
			.mockResolvedValueOnce({
				data: projectValidation("/repo/project", {
					nextStep: "prepare_git",
					root: {
						isRepo: false,
						hasCommit: false,
						hasOrigin: false,
						needsGitInit: true,
						requiredActions: ["git_init", "git_commit", "set_remote"],
					},
				}),
			})
			.mockResolvedValueOnce({
				data: {
					events: [
						{ repoPath: "/repo/project", action: "git_init", state: "pending" },
						{ repoPath: "/repo/project", action: "git_init", state: "running" },
						{ repoPath: "/repo/project", action: "git_init", state: "success" },
					],
					validation: projectValidation("/repo/project", {
						nextStep: "prepare_git",
						root: { isRepo: true, hasCommit: false, hasOrigin: false, requiredActions: ["git_commit", "set_remote"] },
					}),
				},
			})
			.mockResolvedValueOnce({
				data: {
					events: [
						{ repoPath: "/repo/project", action: "git_commit", state: "pending" },
						{ repoPath: "/repo/project", action: "git_commit", state: "running" },
						{ repoPath: "/repo/project", action: "git_commit", state: "success" },
					],
					validation: projectValidation("/repo/project", {
						nextStep: "prepare_git",
						root: { isRepo: true, hasCommit: true, hasOrigin: false, requiredActions: ["set_remote"] },
					}),
				},
			})
			.mockResolvedValueOnce({
				data: {
					events: [
						{ repoPath: "/repo/project", action: "set_remote", state: "pending" },
						{ repoPath: "/repo/project", action: "set_remote", state: "running" },
						{ repoPath: "/repo/project", action: "set_remote", state: "success" },
					],
					validation: projectValidation("/repo/project"),
				},
			});

		render(
			<CreateProjectFlow mode="choose" {...noop}>
				{({ choosePath }) => <button onClick={choosePath}>New project</button>}
			</CreateProjectFlow>,
		);

		await user.click(screen.getByRole("button", { name: "New project" }));
		await user.click(await screen.findByRole("button", { name: "Import an existing project" }));
		const remoteInput = await screen.findByLabelText("Origin remote URL");
		await user.clear(remoteInput);
		await user.type(remoteInput, "https://github.com/acme/project.git");
		await user.click(screen.getByRole("button", { name: "Continue" }));

		await waitFor(() =>
			expect(apiMocks.POST).toHaveBeenLastCalledWith("/api/v1/imports/prepare-git", {
				body: {
					importKind: "project",
					path: "/repo/project",
					approvedActions: ["git_init", "git_commit", "set_remote"],
					remoteUrl: "https://github.com/acme/project.git",
					stepwise: true,
				},
			}),
		);
		expect(apiMocks.POST).toHaveBeenCalledTimes(4);
		const sheet = await screen.findByTestId("agent-sheet");
		expect(sheet).toHaveAttribute("data-path", "/repo/project");
		expect(screen.queryByText("Prepare project")).not.toBeInTheDocument();
	});

	it("blocks an inaccessible project remote before Git preparation", async () => {
		const user = userEvent.setup();
		bridgeMocks.chooseDirectory.mockResolvedValue("/repo/project");
		bridgeMocks.checkGitRepository.mockResolvedValue(false);
		apiMocks.POST.mockResolvedValueOnce({
			data: projectValidation("/repo/project", {
				nextStep: "prepare_git",
				root: { hasOrigin: false, requiredActions: ["set_remote"] },
			}),
		});

		render(
			<CreateProjectFlow mode="choose" {...noop}>
				{({ choosePath }) => <button onClick={choosePath}>New project</button>}
			</CreateProjectFlow>,
		);

		await user.click(screen.getByRole("button", { name: "New project" }));
		await user.click(await screen.findByRole("button", { name: "Import an existing project" }));
		await user.click(screen.getByRole("button", { name: "Continue" }));

		await waitFor(() => expect(bridgeMocks.checkGitRepository).toHaveBeenCalledWith("https://github.com/username/project.git"));
		expect(apiMocks.POST).toHaveBeenCalledTimes(1);
		expect(useUiStore.getState().globalToast?.body).toBe("This isn't a repository or you don't have access");
		await waitFor(() => expect(screen.getByRole("dialog", { name: "Prepare project" })).toHaveClass("modal-shake"));
		expect(screen.queryByTestId("agent-sheet")).not.toBeInTheDocument();
	});

	it("toasts and shakes the agent sheet when project creation fails", async () => {
		const user = userEvent.setup();
		bridgeMocks.chooseDirectory.mockResolvedValue("/repo/project");
		apiMocks.POST.mockResolvedValueOnce({ data: projectValidation("/repo/project") });
		const onCreateProject = vi.fn().mockRejectedValue(new Error("rpc failed: request_id=secret INTERNAL_FAILURE"));

		render(
			<CreateProjectFlow mode="choose" {...noop} onCreateProject={onCreateProject}>
				{({ choosePath }) => <button onClick={choosePath}>New project</button>}
			</CreateProjectFlow>,
		);

		await user.click(screen.getByRole("button", { name: "New project" }));
		await user.click(await screen.findByRole("button", { name: "Import an existing project" }));
		await user.click(await screen.findByRole("button", { name: "Submit agents" }));

		await waitFor(() => expect(useUiStore.getState().globalToast?.body).toBe("AO could not create this project. Try again."));
		const sheet = screen.getByTestId("agent-sheet");
		expect(sheet).toHaveTextContent("AO could not create this project. Try again.");
		expect(sheet).not.toHaveTextContent("request_id");
		await waitFor(() => expect(sheet).toHaveClass("modal-shake"));
	});

	it("passes the checked-out branch when creating an imported project", async () => {
		const user = userEvent.setup();
		const onCreateProject = vi.fn(async () => undefined);
		bridgeMocks.chooseDirectory.mockResolvedValue("/repo/project");
		bridgeMocks.getRepositoryBranch.mockResolvedValue("main");
		apiMocks.POST.mockResolvedValueOnce({ data: projectValidation("/repo/project") });

		render(
			<CreateProjectFlow mode="choose" {...noop} onCreateProject={onCreateProject}>
				{({ choosePath }) => <button onClick={choosePath}>New project</button>}
			</CreateProjectFlow>,
		);

		await user.click(screen.getByRole("button", { name: "New project" }));
		await user.click(await screen.findByRole("button", { name: "Import an existing project" }));
		await user.click(await screen.findByRole("button", { name: "Submit agents" }));

		await waitFor(() =>
			expect(onCreateProject).toHaveBeenCalledWith({
				path: "/repo/project",
				asWorkspace: false,
				defaultBranch: "main",
				workerAgent: "codex",
				orchestratorAgent: "codex",
			}),
		);
		expect(bridgeMocks.getRepositoryBranch).toHaveBeenCalledWith("/repo/project");
	});

	it("shows queued and running setup progress after continue is clicked", async () => {
		const user = userEvent.setup();
		bridgeMocks.chooseDirectory.mockResolvedValue("/repo/project");
		let resolveInit!: (value: unknown) => void;
		let resolveCommit!: (value: unknown) => void;
		let resolveRemote!: (value: unknown) => void;
		apiMocks.POST
			.mockResolvedValueOnce({
				data: projectValidation("/repo/project", {
					nextStep: "prepare_git",
					root: {
						isRepo: false,
						hasCommit: false,
						hasOrigin: false,
						needsGitInit: true,
						requiredActions: ["git_init", "git_commit", "set_remote"],
					},
				}),
			})
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveInit = resolve;
				}),
			)
			.mockReturnValueOnce(new Promise((resolve) => {
				resolveCommit = resolve;
			}))
			.mockReturnValueOnce(new Promise((resolve) => {
				resolveRemote = resolve;
			}));

		render(
			<CreateProjectFlow mode="choose" {...noop}>
				{({ choosePath }) => <button onClick={choosePath}>New project</button>}
			</CreateProjectFlow>,
		);

		await user.click(screen.getByRole("button", { name: "New project" }));
		await user.click(await screen.findByRole("button", { name: "Import an existing project" }));
		const remoteInput = await screen.findByLabelText("Origin remote URL");
		await user.clear(remoteInput);
		await user.type(remoteInput, "https://github.com/acme/project.git");
		await user.click(screen.getByRole("button", { name: "Continue" }));

		expect(await screen.findByText("Running project setup. AO is preparing this repository now.")).toBeInTheDocument();
		expect(screen.getAllByText("In progress")).toHaveLength(1);
		expect(screen.getAllByText("Queued")).toHaveLength(2);
		expect(apiMocks.POST).toHaveBeenCalledTimes(2);

		resolveInit({
			data: {
				events: [
					{ repoPath: "/repo/project", action: "git_init", state: "success" },
				],
				validation: projectValidation("/repo/project", {
					nextStep: "prepare_git",
					root: { isRepo: true, hasCommit: false, hasOrigin: false, requiredActions: ["git_commit", "set_remote"] },
				}),
			},
		});
		await waitFor(() => expect(apiMocks.POST).toHaveBeenCalledTimes(3));
		expect(screen.getAllByText("Done")).toHaveLength(1);
		expect(screen.getAllByText("In progress")).toHaveLength(1);
		expect(screen.getAllByText("Queued")).toHaveLength(1);

		resolveCommit({
			data: {
				events: [{ repoPath: "/repo/project", action: "git_commit", state: "success" }],
				validation: projectValidation("/repo/project", {
					nextStep: "prepare_git",
					root: { isRepo: true, hasCommit: true, hasOrigin: false, requiredActions: ["set_remote"] },
				}),
			},
		});
		await waitFor(() => expect(apiMocks.POST).toHaveBeenCalledTimes(4));
		expect(screen.getAllByText("Done")).toHaveLength(2);
		expect(screen.getAllByText("In progress")).toHaveLength(1);

		resolveRemote({
			data: {
				events: [{ repoPath: "/repo/project", action: "set_remote", state: "success" }],
				validation: projectValidation("/repo/project"),
			},
		});

		expect((await screen.findByTestId("agent-sheet"))).toHaveAttribute("data-path", "/repo/project");
	});

	it("shows a failed preparation step and allows retry", async () => {
		const user = userEvent.setup();
		bridgeMocks.chooseDirectory.mockResolvedValue("/repo/project");
		apiMocks.POST
			.mockResolvedValueOnce({
				data: projectValidation("/repo/project", {
					nextStep: "prepare_git",
					root: {
						isRepo: false,
						hasCommit: false,
						hasOrigin: false,
						requiredActions: ["git_init", "git_commit", "set_remote"],
					},
				}),
			})
			.mockResolvedValueOnce({
				data: {
					events: [{ repoPath: "/repo/project", action: "git_init", state: "success" }],
					validation: projectValidation("/repo/project", {
						nextStep: "prepare_git",
						root: { isRepo: true, hasCommit: false, hasOrigin: false, requiredActions: ["git_commit", "set_remote"] },
					}),
				},
			})
			.mockResolvedValueOnce({
				data: {
					events: [
						{ repoPath: "/repo/project", action: "git_commit", state: "running" },
						{ repoPath: "/repo/project", action: "git_commit", state: "error", error: "commit hook failed" },
					],
					validation: projectValidation("/repo/project", {
						nextStep: "prepare_git",
						root: {
							hasOrigin: false,
							requiredActions: ["git_commit", "set_remote"],
						},
					}),
				},
			})
			.mockResolvedValueOnce({
				data: {
					events: [{ repoPath: "/repo/project", action: "git_commit", state: "success" }],
					validation: projectValidation("/repo/project", {
						nextStep: "prepare_git",
						root: { isRepo: true, hasCommit: true, hasOrigin: false, requiredActions: ["set_remote"] },
					}),
				},
			})
			.mockResolvedValueOnce({
				data: {
					events: [{ repoPath: "/repo/project", action: "set_remote", state: "success" }],
					validation: projectValidation("/repo/project"),
				},
			});

		render(
			<CreateProjectFlow mode="choose" {...noop}>
				{({ choosePath }) => <button onClick={choosePath}>New project</button>}
			</CreateProjectFlow>,
		);

		await user.click(screen.getByRole("button", { name: "New project" }));
		await user.click(await screen.findByRole("button", { name: "Import an existing project" }));
		const remoteInput = await screen.findByLabelText("Origin remote URL");
		await user.clear(remoteInput);
		await user.type(remoteInput, "https://github.com/acme/project.git");
		await user.click(screen.getByRole("button", { name: "Continue" }));

		await waitFor(() => expect(useUiStore.getState().globalToast?.body).toMatch(/failed while running Initial commit/i));
		await waitFor(() => expect(screen.getByRole("dialog", { name: "Prepare project" })).toHaveClass("modal-shake"));
		expect(screen.getAllByText("Done")).toHaveLength(1);
		expect(screen.getAllByText("Needs attention")).toHaveLength(1);
		expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
		expect(screen.queryByTestId("agent-sheet")).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Retry" }));
		expect((await screen.findByTestId("agent-sheet"))).toHaveAttribute("data-path", "/repo/project");
		expect(apiMocks.POST).toHaveBeenCalledTimes(5);
		expect(apiMocks.POST.mock.calls[3]?.[1]).toMatchObject({
			body: { approvedActions: ["git_commit", "set_remote"], stepwise: true },
		});
	});
});

describe("CreateProjectFlow cloud offering", () => {
	it("hides the Local | Cloud choice when the cloud gate is off", () => {
		cloudMocks.sessionStatus = "authenticated";
		render(<CreateProjectFlow embedded mode="choose" {...noop} />, { wrapper: CloudTestProviders });

		expect(screen.queryByRole("tab", { name: "Cloud" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Import an existing project" })).toBeInTheDocument();
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
		expect(screen.getByRole("button", { name: "Import an existing project" })).toBeInTheDocument();
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
