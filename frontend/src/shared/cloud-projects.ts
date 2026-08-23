import type {
	CreateWorkspacePlacementInput,
	ProjectSummary,
	SpawnSessionRequest,
	SpawnSessionResponse,
	WorkspacePlacementOperation,
} from "../../../packages/cloud-client/src/index";
import type { CloudOrganization } from "./cloud-account";

/** Canonical /api/v1 projects grouped by the renderer-safe account memberships. */
export type CloudProjectGroup = {
	organization: CloudOrganization;
	projects: ProjectSummary[];
};

export type CloudProjectSnapshot = {
	groups: CloudProjectGroup[];
};

export type CreateCloudProjectInput = CreateWorkspacePlacementInput & {
	organizationId: string;
};

export type GetCloudProjectOperationInput = {
	organizationId: string;
	operationId: string;
};

export type CloudProjectOperation = WorkspacePlacementOperation;

export type StartCloudProjectSessionInput = {
	organizationId: string;
	projectId: string;
	harness?: SpawnSessionRequest["harness"];
};

export type CloudProjectSessionResult = SpawnSessionResponse;
