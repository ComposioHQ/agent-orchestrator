import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreateCloudProjectDialog } from "./CreateCloudProjectDialog";

const mocks = vi.hoisted(() => ({
	cloudSession: {
		configured: true,
		session: null as null | { user: { email: string } },
		status: "unauthenticated" as "authenticated" | "loading" | "unauthenticated",
		signIn: vi.fn(),
		signOut: vi.fn(),
	},
	connectLocalHarness: vi.fn(),
	createProject: vi.fn(),
	createSession: vi.fn(),
	getOverview: vi.fn(),
}));

vi.mock("../lib/cloud-session", () => ({ useCloudSession: () => mocks.cloudSession }));
vi.mock("../lib/bridge", () => ({
	aoBridge: {
		cloud: {
			connectLocalHarness: mocks.connectLocalHarness,
			createProject: mocks.createProject,
			createSession: mocks.createSession,
			getOverview: mocks.getOverview,
		},
	},
}));

function renderDialog() {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<CreateCloudProjectDialog onBack={() => undefined} onOpenChange={() => undefined} open />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	mocks.cloudSession.configured = true;
	mocks.cloudSession.session = null;
	mocks.cloudSession.status = "unauthenticated";
	mocks.cloudSession.signIn.mockReset();
	mocks.connectLocalHarness.mockReset().mockResolvedValue({ connected: true });
	mocks.createProject.mockReset().mockResolvedValue({ id: "project-1", displayName: "repository" });
	mocks.createSession.mockReset().mockResolvedValue({ id: "session-1" });
	mocks.getOverview.mockReset().mockResolvedValue({
		organization: { id: "org-1", displayName: "Example", role: "owner" },
		projects: [],
		sessions: [],
		harnesses: [{ harness: "claude-code", connected: false }],
	});
});

describe("CreateCloudProjectDialog", () => {
	it("starts sign-in as part of selecting Cloud", async () => {
		renderDialog();

		await waitFor(() => expect(mocks.cloudSession.signIn).toHaveBeenCalledOnce());
		expect(screen.getByText("Finish signing in in your browser. This window will continue automatically.")).toBeInTheDocument();
	});

	it("creates the project, connects the selected local login, and starts its orchestrator", async () => {
		mocks.cloudSession.status = "authenticated";
		mocks.cloudSession.session = { user: { email: "person@example.com" } };
		const user = userEvent.setup();
		renderDialog();

		await user.type(await screen.findByLabelText("Git repository"), "https://github.com/acme/repository.git");
		await user.click(screen.getByRole("button", { name: "Create Cloud project" }));

		await waitFor(() => expect(mocks.connectLocalHarness).toHaveBeenCalledWith("claude-code"));
		expect(mocks.connectLocalHarness).toHaveBeenCalledWith("codex");
		expect(mocks.createProject).toHaveBeenCalledWith("org-1", {
			displayName: "repository",
			repositoryUrl: "https://github.com/acme/repository.git",
			defaultBranch: "main",
			workerAgent: "claude-code",
			orchestratorAgent: "claude-code",
		});
		expect(mocks.createSession).toHaveBeenCalledWith({
			orgId: "org-1",
			projectId: "project-1",
			kind: "orchestrator",
			harness: "claude-code",
			displayName: "repository orchestrator",
			prompt: "",
		});
		expect(await screen.findByText("repository is a Cloud project")).toBeInTheDocument();
	});

	it("reuses an existing Cloud project instead of failing with a duplicate", async () => {
		mocks.cloudSession.status = "authenticated";
		mocks.cloudSession.session = { user: { email: "person@example.com" } };
		mocks.getOverview.mockResolvedValue({
			organization: { id: "org-1", displayName: "Example", role: "owner" },
			projects: [{ id: "project-existing", displayName: "repository", repositoryUrl: "https://github.com/acme/repository" }],
			sessions: [],
			harnesses: [{ harness: "claude-code", connected: true }],
		});
		const user = userEvent.setup();
		renderDialog();

		await user.type(await screen.findByLabelText("Git repository"), "https://github.com/acme/repository.git");
		await user.click(screen.getByRole("button", { name: "Create Cloud project" }));

		await waitFor(() => expect(mocks.createSession).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "project-existing" }),
		));
		expect(mocks.createProject).not.toHaveBeenCalled();
	});

	it("uses Codex when Claude Code is not signed in locally", async () => {
		mocks.cloudSession.status = "authenticated";
		mocks.cloudSession.session = { user: { email: "person@example.com" } };
		mocks.connectLocalHarness.mockImplementation(async (harness: string) => {
			if (harness === "claude-code") throw new Error("not signed in");
			return { connected: true };
		});
		const user = userEvent.setup();
		renderDialog();

		await user.type(await screen.findByLabelText("Git repository"), "https://github.com/acme/repository.git");
		await user.click(screen.getByRole("button", { name: "Create Cloud project" }));

		await waitFor(() =>
			expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({ harness: "codex" })),
		);
	});

	it("surfaces provider rejection instead of claiming no local login exists", async () => {
		mocks.cloudSession.status = "authenticated";
		mocks.cloudSession.session = { user: { email: "person@example.com" } };
		mocks.connectLocalHarness.mockImplementation(async (harness: string) => {
			if (harness === "claude-code") {
				throw new Error("No local Claude Code subscription login was found.");
			}
			throw new Error("The Codex credential is invalid or expired. Request request-123.");
		});
		const user = userEvent.setup();
		renderDialog();

		await user.type(await screen.findByLabelText("Git repository"), "https://github.com/acme/repository.git");
		await user.click(screen.getByRole("button", { name: "Create Cloud project" }));

		expect(
			await screen.findByText("The Codex credential is invalid or expired. Request request-123."),
		).toBeInTheDocument();
		expect(screen.queryByText("No local Claude Code or Codex login was found. Sign in to either agent locally and retry.")).not.toBeInTheDocument();
		expect(mocks.createProject).not.toHaveBeenCalled();
	});
});
