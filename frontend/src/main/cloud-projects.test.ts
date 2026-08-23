import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

import { createCloudProjectsService } from "./cloud-projects";

const account = {
	authProvider: "google" as const,
	user: { id: "user-1", email: "dev@example.com", displayName: "Dev" },
	organizations: [{ id: "org-1", slug: "acme", displayName: "Acme", role: "owner" }],
	storedAt: "2026-08-23T00:00:00.000Z",
};

const pending = {
	operationId: "operation-1",
	orgId: "org-1",
	state: "pending" as const,
	defaultBranch: "release/2026",
	createdAt: "2026-08-23T00:00:00.000Z",
	updatedAt: "2026-08-23T00:00:00.000Z",
};

describe("Electron-main cloud project boundary", () => {
	const client = {
		listProjects: vi.fn(),
		createWorkspacePlacement: vi.fn(),
		getWorkspacePlacement: vi.fn(),
		spawnSession: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns canonical project DTOs grouped by renderer-safe memberships", async () => {
		client.listProjects.mockResolvedValue({
			projects: [{ id: "project-1", name: "App", path: "/workspace/app", kind: "single_repo", sessionPrefix: "app" }],
		});
		const service = createCloudProjectsService({ client, getAccount: async () => account });

		await expect(service.list()).resolves.toEqual({
			groups: [{ organization: account.organizations[0], projects: expect.arrayContaining([expect.objectContaining({ id: "project-1" })]) }],
		});
		expect(client.listProjects).toHaveBeenCalledWith("org-1");
	});

	it("passes a server-discovered non-main default branch through the generated placement client", async () => {
		client.createWorkspacePlacement.mockResolvedValue(pending);
		const service = createCloudProjectsService({
			client,
			getAccount: async () => account,
			newIdempotencyKey: () => "idempotency-1",
		});

		await expect(service.create({
			organizationId: "org-1",
			displayName: " App ",
			repositoryUrl: " https://github.com/acme/app.git ",
			defaultBranch: " release/2026 ",
		})).resolves.toEqual(pending);
		expect(client.createWorkspacePlacement).toHaveBeenCalledWith(
			"org-1",
			{
				displayName: "App",
				repositoryUrl: "https://github.com/acme/app.git",
				defaultBranch: "release/2026",
				config: undefined,
			},
			{ idempotencyKey: "idempotency-1" },
		);
	});

	it("rejects ineligible organizations before invoking a cloud client", async () => {
		const service = createCloudProjectsService({ client, getAccount: async () => account });

		await expect(service.create({
			organizationId: "org-other",
			displayName: "App",
			repositoryUrl: "https://github.com/acme/app.git",
			defaultBranch: "develop",
		})).rejects.toThrow("cannot access");
		expect(client.createWorkspacePlacement).not.toHaveBeenCalled();
	});

	it("surfaces list and poll failures instead of replacing them with empty state", async () => {
		client.listProjects.mockRejectedValue(new Error("project list unavailable"));
		client.getWorkspacePlacement.mockRejectedValue(new Error("placement unavailable"));
		const service = createCloudProjectsService({ client, getAccount: async () => account });

		await expect(service.list()).rejects.toThrow("project list unavailable");
		await expect(service.getOperation({ organizationId: "org-1", operationId: "operation-1" }))
			.rejects.toThrow("placement unavailable");
	});

	it("can proceed from a ready project to a generated-client sandbox session without inventing a main branch", async () => {
		client.spawnSession.mockResolvedValue({ session: { id: "session-1" } });
		const service = createCloudProjectsService({
			client,
			getAccount: async () => account,
			newIdempotencyKey: () => "session-idempotency-1",
		});

		await service.startSession({ organizationId: "org-1", projectId: "project-1" });

		expect(client.spawnSession).toHaveBeenCalledWith(
			"org-1",
			{ projectId: "project-1", kind: "orchestrator", harness: "codex" },
			{ idempotencyKey: "session-idempotency-1" },
		);
		expect(client.spawnSession.mock.calls[0]?.[1]).not.toHaveProperty("branch");
	});
});
