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
	id: "operation-1",
	orgId: "org-1",
	ownerUserId: "user-1",
	state: "pending" as const,
	createdAt: "2026-08-23T00:00:00.000Z",
	updatedAt: "2026-08-23T00:00:00.000Z",
};

describe("Electron-main cloud project boundary", () => {
	const placementClient = {
		createWorkspacePlacement: vi.fn(),
		getWorkspacePlacement: vi.fn(),
	};
	const appClient = {
		listProjects: vi.fn(),
		getProject: vi.fn(),
		spawnSession: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns canonical project DTOs grouped by renderer-safe memberships", async () => {
		appClient.listProjects.mockResolvedValue({
			projects: [{ id: "project-1", name: "App", path: "/workspace/app", kind: "single_repo" }],
		});
		appClient.getProject.mockResolvedValue({
			status: "ok",
			project: {
				id: "project-1",
				name: "App",
				path: "/workspace/app",
				repo: "https://github.com/acme/app.git",
				defaultBranch: "release/2026",
				kind: "single_repo",
			},
		});
		const service = createCloudProjectsService({ placementClient, appClient, getAccount: async () => account });

		await expect(service.list()).resolves.toEqual({
			groups: [{ organization: account.organizations[0], projects: expect.arrayContaining([expect.objectContaining({ id: "project-1" })]) }],
		});
		expect(appClient.listProjects).toHaveBeenCalledWith("org-1");
		expect(appClient.getProject).toHaveBeenCalledWith("org-1", "project-1");
	});

	it("passes a server-discovered non-main default branch through the generated placement client", async () => {
		placementClient.createWorkspacePlacement.mockResolvedValue(pending);
		const service = createCloudProjectsService({
			placementClient,
			appClient,
			getAccount: async () => account,
			newIdempotencyKey: () => "idempotency-1",
		});

		await expect(service.create({
			organizationId: "org-1",
			displayName: " App ",
			repositoryUrl: " https://github.com/acme/app.git ",
			defaultBranch: " release/2026 ",
		})).resolves.toEqual({
			operationId: "operation-1",
			orgId: "org-1",
			state: "pending",
			defaultBranch: "release/2026",
			createdAt: pending.createdAt,
			updatedAt: pending.updatedAt,
		});
		expect(placementClient.createWorkspacePlacement).toHaveBeenCalledWith(
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
		const service = createCloudProjectsService({ placementClient, appClient, getAccount: async () => account });

		await expect(service.create({
			organizationId: "org-other",
			displayName: "App",
			repositoryUrl: "https://github.com/acme/app.git",
			defaultBranch: "develop",
		})).rejects.toThrow("cannot access");
		expect(placementClient.createWorkspacePlacement).not.toHaveBeenCalled();
	});

	it("surfaces list and poll failures instead of replacing them with empty state", async () => {
		appClient.listProjects.mockRejectedValue(new Error("project list unavailable"));
		placementClient.getWorkspacePlacement.mockRejectedValue(new Error("placement unavailable"));
		const service = createCloudProjectsService({ placementClient, appClient, getAccount: async () => account });

		await expect(service.list()).rejects.toThrow("project list unavailable");
		await expect(service.getOperation({
			organizationId: "org-1",
			operationId: "operation-1",
			defaultBranch: "release/2026",
		}))
			.rejects.toThrow("placement unavailable");
	});

	it("surfaces degraded canonical projects instead of silently hiding them", async () => {
		appClient.listProjects.mockResolvedValue({
			projects: [{ id: "project-1", name: "App", path: "/workspace/app", kind: "single_repo" }],
		});
		appClient.getProject.mockResolvedValue({
			status: "degraded",
			project: {
				id: "project-1",
				name: "App",
				path: "/workspace/app",
				kind: "single_repo",
				resolveError: "Provisioned checkout is not ready",
			},
		});
		const service = createCloudProjectsService({ placementClient, appClient, getAccount: async () => account });

		await expect(service.list()).rejects.toThrow("Provisioned checkout is not ready");
	});

	it("can proceed from a ready project to a generated-client sandbox session without inventing a main branch", async () => {
		appClient.spawnSession.mockResolvedValue({ session: { id: "session-1" } });
		const service = createCloudProjectsService({
			placementClient,
			appClient,
			getAccount: async () => account,
			newIdempotencyKey: () => "session-idempotency-1",
		});

		await service.startSession({ organizationId: "org-1", projectId: "project-1" });

		expect(appClient.spawnSession).toHaveBeenCalledWith(
			"org-1",
			{ projectId: "project-1", kind: "orchestrator", harness: "codex" },
			"session-idempotency-1",
		);
		expect(appClient.spawnSession.mock.calls[0]?.[1]).not.toHaveProperty("branch");
	});
});
