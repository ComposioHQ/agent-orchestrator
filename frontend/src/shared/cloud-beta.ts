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
	config?: {
		worker?: { agent?: CloudHarness };
		orchestrator?: { agent?: CloudHarness };
	};
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
	activityState?: string;
	branch?: string;
	mode?: "chat" | "tui";
	isTerminated?: boolean;
	runtimeConnected: boolean;
	runtimeState?: string;
	runtimeError?: string;
	createdAt: string;
	updatedAt: string;
}

export interface CloudTerminalOpenInput {
	connectionId: string;
	orgId: string;
	sessionId: string;
	kind: "agent" | "workspace";
	cols: number;
	rows: number;
}

export type CloudTerminalEvent =
	| { connectionId: string; type: "opened" }
	| { connectionId: string; type: "data"; data: string }
	| { connectionId: string; type: "exited" }
	| { connectionId: string; type: "error"; message: string }
	| { connectionId: string; type: "connection"; state: "open" | "closed" };

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
	workerAgent?: CloudHarness;
	orchestratorAgent?: CloudHarness;
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
