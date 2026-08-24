export type CloudHarness = "claude-code" | "codex";

export interface CloudOrganization {
	id: string;
	displayName: string;
	role: string;
}

export interface CloudProject {
	id: string;
	orgId: string;
	displayName: string;
	repositoryUrl: string;
	defaultBranch: string;
	executionLocation: "cloud";
	createdAt: string;
	updatedAt: string;
}

export interface CloudSessionSummary {
	id: string;
	projectId: string;
	kind: "worker" | "orchestrator";
	harness: CloudHarness;
	displayName: string;
	status: string;
	runtimeConnected: boolean;
	runtimeState?: string;
	runtimeError?: string;
	createdAt: string;
	updatedAt: string;
}

export interface CloudHarnessConnection {
	harness: CloudHarness;
	connected: boolean;
	validationState?: "pending" | "valid" | "invalid";
	credentialType?: string;
}

export interface CloudBetaOverview {
	apiBaseUrl: string;
	organization: CloudOrganization;
	projects: CloudProject[];
	sessions: CloudSessionSummary[];
	harnesses: CloudHarnessConnection[];
}

export interface CreateCloudProjectInput {
	displayName: string;
	repositoryUrl: string;
	defaultBranch: string;
}

export interface CreateCloudSessionInput {
	orgId: string;
	projectId: string;
	kind: "worker" | "orchestrator";
	harness: CloudHarness;
	displayName: string;
	prompt: string;
}

export interface ConnectCloudHarnessResult {
	harness: CloudHarness;
	connected: boolean;
	source: "environment" | "claude-keychain" | "claude-credentials" | "codex-auth";
}
