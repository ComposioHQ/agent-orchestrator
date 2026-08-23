import { ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import {
	createCloudClient,
	type CloudClient,
	type ProjectSummary,
	type WorkspacePlacementOperation,
} from "../../../packages/cloud-client/src/index";
import type { CloudAccount } from "../shared/cloud-account";
import type {
	CloudProjectSnapshot,
	CreateCloudProjectInput,
	GetCloudProjectOperationInput,
	StartCloudProjectSessionInput,
} from "../shared/cloud-projects";

type ProjectCloudClient = Pick<
	CloudClient,
	"createWorkspacePlacement" | "getWorkspacePlacement" | "listProjects" | "spawnSession"
>;

export type CloudProjectsDependencies = {
	client: ProjectCloudClient;
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

/**
 * Main-process-only project API. Every network call goes through the generated
 * Cloud client; renderer IPC receives only canonical project DTOs and the
 * token-free placement operation.
 */
export function createCloudProjectsService(dependencies: CloudProjectsDependencies) {
	const newIdempotencyKey = dependencies.newIdempotencyKey ?? randomUUID;

	return {
		async list(): Promise<CloudProjectSnapshot> {
			const account = await dependencies.getAccount();
			if (!account) throw new Error("Sign in to AO Cloud first.");
			const groups = await Promise.all(
				account.organizations.map(async (organization) => {
					const response = await dependencies.client.listProjects(organization.id);
					return {
						organization,
						projects: response.projects as ProjectSummary[],
					};
				}),
			);
			return { groups };
		},

		async create(input: CreateCloudProjectInput): Promise<WorkspacePlacementOperation> {
			requireOrganization(await dependencies.getAccount(), input.organizationId);
			const displayName = input.displayName.trim();
			const repositoryUrl = input.repositoryUrl.trim();
			const defaultBranch = input.defaultBranch.trim();
			if (!displayName || !repositoryUrl || !defaultBranch) {
				throw new Error("Project name, repository URL, and default branch are required.");
			}
			return dependencies.client.createWorkspacePlacement(
				input.organizationId,
				{ displayName, repositoryUrl, defaultBranch, config: input.config },
				{ idempotencyKey: newIdempotencyKey() },
			);
		},

		async getOperation(input: GetCloudProjectOperationInput): Promise<WorkspacePlacementOperation> {
			requireOrganization(await dependencies.getAccount(), input.organizationId);
			if (!input.operationId.trim()) throw new Error("Cloud project operation is required.");
			return dependencies.client.getWorkspacePlacement(input.organizationId, input.operationId);
		},

		async startSession(input: StartCloudProjectSessionInput) {
			requireOrganization(await dependencies.getAccount(), input.organizationId);
			if (!input.projectId.trim()) throw new Error("Cloud project is required.");
			return dependencies.client.spawnSession(
				input.organizationId,
				{ projectId: input.projectId, kind: "orchestrator", harness: input.harness ?? "codex" },
				{ idempotencyKey: newIdempotencyKey() },
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
		client: createCloudClient({ baseUrl: input.baseUrl, getAccessToken: input.getAccessToken }),
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
