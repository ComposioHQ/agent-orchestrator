import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudProjectFlow } from "./CloudProjectFlow";

const bridge = vi.hoisted(() => ({
	listProjects: vi.fn(),
	createProject: vi.fn(),
	getProjectOperation: vi.fn(),
	startProjectSession: vi.fn(),
}));

const account = {
	authProvider: "google" as const,
	user: { id: "user-1", email: "dev@example.com", displayName: "Dev" },
	organizations: [{ id: "org-1", slug: "acme", displayName: "Acme", role: "owner" }],
	storedAt: "2026-08-23T00:00:00.000Z",
};

vi.mock("../lib/bridge", () => ({
	aoBridge: { cloud: bridge },
}));

vi.mock("../lib/cloud-session", () => ({
	useCloudSession: () => ({
		enabled: true,
		available: true,
		session: account,
		status: "authenticated",
		signIn: vi.fn(),
		signOut: vi.fn(),
	}),
}));

const emptySnapshot = {
	groups: [{ organization: account.organizations[0], projects: [] }],
};

const pending = {
	operationId: "operation-1",
	orgId: "org-1",
	state: "pending" as const,
	defaultBranch: "release/2026",
	createdAt: "2026-08-23T00:00:00.000Z",
	updatedAt: "2026-08-23T00:00:00.000Z",
};

describe("CloudProjectFlow", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		bridge.listProjects.mockResolvedValue(emptySnapshot);
		bridge.startProjectSession.mockResolvedValue({ session: { id: "session-1" } });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps project-list failures visible and retryable", async () => {
		bridge.listProjects.mockRejectedValueOnce(new Error("Cloud list is offline")).mockResolvedValue(emptySnapshot);
		const user = userEvent.setup();
		render(<CloudProjectFlow open onOpenChange={vi.fn()} />);

		expect(await screen.findByRole("alert")).toHaveTextContent("Cloud list is offline");
		await user.click(screen.getByRole("button", { name: "Retry list" }));

		await waitFor(() => expect(bridge.listProjects).toHaveBeenCalledTimes(2));
		expect(await screen.findByText("No cloud projects yet.")).toBeInTheDocument();
	});

	it("shows create failures with an explicit retry action", async () => {
		bridge.createProject.mockRejectedValue(new Error("Placement was rejected"));
		const user = userEvent.setup();
		render(<CloudProjectFlow open onOpenChange={vi.fn()} />);
		await screen.findByText("No cloud projects yet.");

		await user.selectOptions(screen.getByLabelText("Organization"), "org-1");
		await user.type(screen.getByLabelText("Project name"), "App");
		await user.type(screen.getByLabelText("Repository URL"), "https://github.com/acme/app.git");
		await user.type(screen.getByLabelText("Default branch"), "release/2026");
		await user.click(screen.getByRole("button", { name: "Create cloud project" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("Placement was rejected");
		expect(screen.getByRole("button", { name: "Retry create" })).toBeInTheDocument();
	});

	it("selects the first account organization when the project list is empty", async () => {
		bridge.listProjects.mockResolvedValue({ groups: [] });
		const user = userEvent.setup();
		render(<CloudProjectFlow open onOpenChange={vi.fn()} />);
		await screen.findByText("No cloud projects yet.");

		await user.type(screen.getByLabelText("Project name"), "App");
		await user.type(screen.getByLabelText("Repository URL"), "https://github.com/acme/app.git");
		await user.type(screen.getByLabelText("Default branch"), "main");

		expect(screen.getByLabelText("Organization")).toHaveValue("org-1");
		expect(screen.getByRole("button", { name: "Create cloud project" })).toBeEnabled();
	});

	it("polls pending placement with backoff, refreshes canonical projects at ready, and preserves DefaultBranch", async () => {
		vi.useFakeTimers();
		bridge.createProject.mockResolvedValue(pending);
		bridge.getProjectOperation.mockResolvedValue({
			...pending,
			state: "ready",
			projectId: "project-1",
			updatedAt: "2026-08-23T00:00:01.000Z",
		});
		bridge.listProjects
			.mockResolvedValueOnce(emptySnapshot)
			.mockResolvedValueOnce({
				groups: [{
					organization: account.organizations[0],
					projects: [{
						id: "project-1",
						name: "App",
						path: "/sandbox/app",
						repo: "https://github.com/acme/app.git",
						defaultBranch: "release/2026",
						kind: "single_repo",
					}],
				}],
			});
		render(<CloudProjectFlow open onOpenChange={vi.fn()} />);
		await act(async () => { await Promise.resolve(); });

		fireEvent.change(screen.getByLabelText("Organization"), { target: { value: "org-1" } });
		fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "App" } });
		fireEvent.change(screen.getByLabelText("Repository URL"), { target: { value: "https://github.com/acme/app.git" } });
		fireEvent.change(screen.getByLabelText("Default branch"), { target: { value: "release/2026" } });
		fireEvent.click(screen.getByRole("button", { name: "Create cloud project" }));
		await act(async () => { await Promise.resolve(); });

		expect(screen.getByText(/Provisioning App/)).toHaveTextContent("release/2026");
		await act(async () => { await vi.advanceTimersByTimeAsync(500); });

		expect(bridge.getProjectOperation).toHaveBeenCalledWith({ organizationId: "org-1", operationId: "operation-1", defaultBranch: "release/2026" });
		expect(bridge.createProject).toHaveBeenCalledWith(expect.objectContaining({ defaultBranch: "release/2026" }));
		expect(screen.getByText("App is ready.")).toBeInTheDocument();
		expect(screen.getByText(/ready for a sandbox session/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Start sandbox session" }));
		await act(async () => { await Promise.resolve(); });
		expect(bridge.startProjectSession).toHaveBeenCalledWith({ organizationId: "org-1", projectId: "project-1" });
		expect(screen.getByText("Sandbox session session-1 started.")).toBeInTheDocument();
	});

	it("keeps poll failures actionable and shows a terminal placement failure after retry", async () => {
		vi.useFakeTimers();
		bridge.createProject.mockResolvedValue(pending);
		bridge.getProjectOperation
			.mockRejectedValueOnce(new Error("Placement status is unavailable"))
			.mockResolvedValueOnce({
				...pending,
				state: "failed",
				failure: { message: "Repository access was denied" },
			});
		render(<CloudProjectFlow open onOpenChange={vi.fn()} />);
		await act(async () => { await Promise.resolve(); });
		fireEvent.change(screen.getByLabelText("Organization"), { target: { value: "org-1" } });
		fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "App" } });
		fireEvent.change(screen.getByLabelText("Repository URL"), { target: { value: "https://github.com/acme/app.git" } });
		fireEvent.change(screen.getByLabelText("Default branch"), { target: { value: "release/2026" } });
		fireEvent.click(screen.getByRole("button", { name: "Create cloud project" }));
		await act(async () => { await Promise.resolve(); });

		await act(async () => { await vi.advanceTimersByTimeAsync(500); });
		expect(screen.getByRole("alert")).toHaveTextContent("Placement status is unavailable");
		fireEvent.click(screen.getByRole("button", { name: "Retry status" }));
		await act(async () => { await vi.advanceTimersByTimeAsync(500); });

		expect(screen.getByRole("alert")).toHaveTextContent("Repository access was denied");
		expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
	});

	it("keeps a canonical refresh failure visible after placement becomes ready", async () => {
		vi.useFakeTimers();
		bridge.createProject.mockResolvedValue(pending);
		bridge.getProjectOperation.mockResolvedValue({ ...pending, state: "ready", projectId: "project-1" });
		bridge.listProjects
			.mockResolvedValueOnce(emptySnapshot)
			.mockRejectedValueOnce(new Error("Canonical project refresh failed"));
		render(<CloudProjectFlow open onOpenChange={vi.fn()} />);
		await act(async () => { await Promise.resolve(); });
		fireEvent.change(screen.getByLabelText("Organization"), { target: { value: "org-1" } });
		fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "App" } });
		fireEvent.change(screen.getByLabelText("Repository URL"), { target: { value: "https://github.com/acme/app.git" } });
		fireEvent.change(screen.getByLabelText("Default branch"), { target: { value: "release/2026" } });
		fireEvent.click(screen.getByRole("button", { name: "Create cloud project" }));
		await act(async () => { await Promise.resolve(); });

		await act(async () => { await vi.advanceTimersByTimeAsync(500); });

		expect(screen.getByRole("alert")).toHaveTextContent("Canonical project refresh failed");
		expect(screen.getByRole("button", { name: "Retry list" })).toBeInTheDocument();
	});

	it("cancels scheduled polling when the dialog unmounts", async () => {
		vi.useFakeTimers();
		bridge.createProject.mockResolvedValue(pending);
		const { unmount } = render(<CloudProjectFlow open onOpenChange={vi.fn()} />);
		await act(async () => { await Promise.resolve(); });
		fireEvent.change(screen.getByLabelText("Organization"), { target: { value: "org-1" } });
		fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "App" } });
		fireEvent.change(screen.getByLabelText("Repository URL"), { target: { value: "https://github.com/acme/app.git" } });
		fireEvent.change(screen.getByLabelText("Default branch"), { target: { value: "develop" } });
		fireEvent.click(screen.getByRole("button", { name: "Create cloud project" }));
		await act(async () => { await Promise.resolve(); });

		unmount();
		await vi.advanceTimersByTimeAsync(5_000);

		expect(bridge.getProjectOperation).not.toHaveBeenCalled();
	});
});
