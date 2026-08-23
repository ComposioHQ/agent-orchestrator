import type { components } from "../api/schema";

export type CloudOrganizationProjectSnapshot = {
	organizationId: string;
	projects: components["schemas"]["ProjectSummary"][];
	sessions: components["schemas"]["ControllersSessionView"][];
};

export type CreateCloudProjectInput = {
	organizationId: string;
	displayName: string;
	repositoryUrl: string;
	defaultBranch: string;
	config: components["schemas"]["ProjectConfig"];
	orchestratorHarness: components["schemas"]["SpawnSessionRequest"]["harness"];
};

export type CreateCloudProjectResult = {
	organizationId: string;
	project: components["schemas"]["ProjectSummary"];
	session?: components["schemas"]["ControllersSessionView"];
	sessionError?: string;
};
