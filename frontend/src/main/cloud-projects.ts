import { ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import {
	createCloudClient,
	type CloudClient,
	type WorkspacePlacement,
} from "../../../packages/cloud-client/src/index";
import type { CloudAccount } from "../shared/cloud-account";
import type {
	CloudProjectSnapshot,
	CreateCloudProjectInput,
	GetCloudProjectOperationInput,
	StartCloudProjectSessionInput,
} from "../shared/cloud-projects";
import { createHostedAppClient, type HostedAppClient } from "./cloud-app-client";

type PlacementClient = Pick<CloudClient, "createWorkspacePlacement" | "getWorkspacePlacement">;

export type CloudProjectsDependencies = {
	placementClient: PlacementClient;
	appClient: HostedAppClient;
	getAccount: () => Promise<CloudAccount | null>;
	newIdempotencyKey?: () => string;
};

function requireOrganization(account: CloudAccount | null, organizationId: string): CloudAccount {
	if (!account) throw new Error("Sign in to AO Cloud first.");
	if (!account.organizations.some((organization) => organization.id === organizationId)) {
		throw new Error("This account cannot access the selected AO Cloud organization.");
	}
	return account;
}

function normalizePlacement(placement: WorkspacePlacement, defaultBranch: string) {
	return {
		operationId: placement.id,
		orgId: placement.orgId,
		state: placement.state,
		projectId: placement.projectId,
		defaultBranch,
		failure: placement.state === "failed" ? { message: placement.message || "AO Cloud could not provision this project." } : undefined,
		createdAt: placement.createdAt,
		updatedAt: placement.updatedAt,
	};
}

/**
 * Main-process-only project API. Every network call goes through a generated
 * client; renderer IPC receives only canonical project DTOs and the token-free
 * placement operation.
 */
export function createCloudProjectsService(dependencies: CloudProjectsDependencies) {
	const newIdempotencyKey = dependencies.newIdempotencyKey ?? randomUUID;

	return {
		async list(): Promise<CloudProjectSnapshot> {
			const account = await dependencies.getAccount();
			if (!account) throw new Error("Sign in to AO Cloud first.");
			const groups = await Promise.all(
				account.organizations.map(async (organization) => {
					const response = await dependencies.appClient.listProjects(organization.id);
					const details = await Promise.all(
						response.projects.map((project) => dependencies.appClient.getProject(organization.id, project.id)),
					);
					return {
						organization,
						projects: details.flatMap((detail) =>
							detail.status === "ok" && "defaultBranch" in detail.project ? [detail.project] : [],
						),
					};
				}),
			);
			return { groups };
		},

		async create(input: CreateCloudProjectInput) {
			requireOrganization(await dependencies.getAccount(), input.organizationId);
			const displayName = input.displayName.trim();
			const repositoryUrl = input.repositoryUrl.trim();
			const defaultBranch = input.defaultBranch.trim();
			if (!displayName || !repositoryUrl || !defaultBranch) {
				throw new Error("Project name, repository URL, and default branch are required.");
			}
			const placement = await dependencies.placementClient.createWorkspacePlacement(
				input.organizationId,
				{ displayName, repositoryUrl, defaultBranch, config: input.config },
				{ idempotencyKey: newIdempotencyKey() },
			);
			return normalizePlacement(placement, defaultBranch);
		},

		async getOperation(input: GetCloudProjectOperationInput) {
			requireOrganization(await dependencies.getAccount(), input.organizationId);
			if (!input.operationId.trim()) throw new Error("Cloud project operation is required.");
			return normalizePlacement(
				await dependencies.placementClient.getWorkspacePlacement(input.organizationId, input.operationId),
				input.defaultBranch,
			);
		},

		async startSession(input: StartCloudProjectSessionInput) {
			requireOrganization(await dependencies.getAccount(), input.organizationId);
			if (!input.projectId.trim()) throw new Error("Cloud project is required.");
			return dependencies.appClient.spawnSession(
				input.organizationId,
				{ projectId: input.projectId, kind: "orchestrator", harness: input.harness ?? "codex" },
				newIdempotencyKey(),
			);
		},
	};
}

export function installCloudProjectIPC(input: {
	baseUrl: string;
	getAccessToken: () => Promise<string>;
	getAccount: () => Promise<CloudAccount | null>;
}): void {
	const service = createCloudProjectsService({
		placementClient: createCloudClient({ baseUrl: input.baseUrl, getAccessToken: input.getAccessToken }),
		appClient: createHostedAppClient({ baseUrl: input.baseUrl, getAccessToken: input.getAccessToken }),
		getAccount: input.getAccount,
	});
	ipcMain.handle("cloud:listProjects", () => service.list());
	ipcMain.handle("cloud:createProject", (_event, request: CreateCloudProjectInput) => service.create(request));
	ipcMain.handle("cloud:getProjectOperation", (_event, request: GetCloudProjectOperationInput) =>
		service.getOperation(request),
	);
	ipcMain.handle("cloud:startProjectSession", (_event, request: StartCloudProjectSessionInput) =>
		service.startSession(request),
	);
}
