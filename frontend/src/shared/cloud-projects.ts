import type {
	CreateWorkspacePlacementInput,
	WorkspacePlacement,
} from "../../../packages/cloud-client/src/index";
import type { components } from "../api/schema";
import type { CloudOrganization } from "./cloud-account";

/** Canonical /api/v1 projects grouped by the renderer-safe account memberships. */
export type CloudProjectGroup = {
	organization: CloudOrganization;
	projects: components["schemas"]["Project"][];
};

export type CloudProjectSnapshot = {
	groups: CloudProjectGroup[];
};

export type CreateCloudProjectInput = Omit<
	CreateWorkspacePlacementInput,
	"displayName" | "repositoryUrl" | "defaultBranch"
> & {
	organizationId: string;
	displayName: string;
	repositoryUrl: string;
	defaultBranch: string;
};

export type GetCloudProjectOperationInput = {
	organizationId: string;
	operationId: string;
	defaultBranch: string;
};

export type CloudProjectOperation = Pick<
	WorkspacePlacement,
	"orgId" | "projectId" | "state" | "createdAt" | "updatedAt"
> & {
	operationId: WorkspacePlacement["id"];
	defaultBranch: string;
	failure?: { message: string };
};

export type StartCloudProjectSessionInput = {
	organizationId: string;
	projectId: string;
	harness?: components["schemas"]["SpawnSessionRequest"]["harness"];
};

export type CloudProjectSessionResult = components["schemas"]["SpawnSessionResponse"];
