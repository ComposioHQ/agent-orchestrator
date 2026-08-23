import { describe, expect, it, vi } from "vitest";
import type { CloudClient, Project, Session } from "@aoagents/cloud-client";
import { fetchCloudWorkspaces, toCloudWorkspaceSummary } from "./cloud-workspaces";

const project = (overrides: Partial<Project> = {}): Project => ({
	id: "proj_1",
	orgId: "org_1",
	displayName: "agent-orchestrator",
	repositoryUrl: "https://github.com/example/agent-orchestrator",
	defaultBranch: "main",
	config: {},
	createdAt: "2026-08-22T00:00:00.000Z",
	updatedAt: "2026-08-22T00:00:00.000Z",
	...overrides,
});

const session = (overrides: Partial<Session> = {}): Session => ({
	id: "sess_1",
	orgId: "org_1",
	projectId: "proj_1",
	kind: "worker",
	harness: "claude-code",
	displayName: "Fix the flaky test",
	branch: "ao/fix-flake",
	mode: "standard",
	deniedCommands: [],
	activityState: "active",
	status: "working",
	runtimeConnected: true,
	isTerminated: false,
	createdAt: "2026-08-22T00:00:00.000Z",
	updatedAt: "2026-08-22T01:00:00.000Z",
	...overrides,
});

describe("toCloudWorkspaceSummary", () => {
	it("produces the same view model shape the local daemon does, tagged as cloud", () => {
		const summary = toCloudWorkspaceSummary(project(), [session()]);

		expect(summary).toMatchObject({
			id: "proj_1",
			name: "agent-orchestrator",
			location: "cloud",
			orgId: "org_1",
			path: "https://github.com/example/agent-orchestrator",
		});
		expect(summary.sessions).toHaveLength(1);
		expect(summary.sessions[0]).toMatchObject({
			id: "sess_1",
			location: "cloud",
			orgId: "org_1",
			workspaceId: "proj_1",
			workspaceName: "agent-orchestrator",
			title: "Fix the flaky test",
			provider: "claude-code",
			kind: "worker",
			branch: "ao/fix-flake",
			// The shared status/activity vocabulary is identical on both sides, so
			// the board and sidebar derive a cloud session's state the same way.
			status: "working",
			activity: { state: "active" },
		});
	});

	it("keeps sessions from other projects out of a project's list", () => {
		const summary = toCloudWorkspaceSummary(project(), [session(), session({ id: "sess_2", projectId: "other" })]);
		expect(summary.sessions.map((item) => item.id)).toEqual(["sess_1"]);
	});

	it("derives terminated status from the durable fact, like local sessions", () => {
		const summary = toCloudWorkspaceSummary(project(), [
			session({ status: "terminated", isTerminated: true, activityState: "exited" }),
		]);
		expect(summary.sessions[0]?.status).toBe("terminated");
		expect(summary.sessions[0]?.isTerminated).toBe(true);
	});
});

function clientWith(overrides: Partial<CloudClient>): CloudClient {
	return overrides as CloudClient;
}

const page = <T,>(items: T[]) => ({ items, page: { hasMore: false } });

describe("fetchCloudWorkspaces", () => {
	it("collects projects across every organization the user belongs to", async () => {
		const client = clientWith({
			listProjects: vi.fn(async (orgId: string) =>
				page([project({ id: `proj_${orgId}`, orgId, displayName: orgId })]),
			),
			listSessions: vi.fn(async () => page([])),
		});

		const workspaces = await fetchCloudWorkspaces(client, [
			{ id: "org_1", slug: "one", displayName: "One", role: "owner" },
			{ id: "org_2", slug: "two", displayName: "Two", role: "member" },
		]);

		expect(workspaces.map((workspace) => workspace.orgId)).toEqual(["org_1", "org_2"]);
	});

	it("skips an organization that fails instead of losing the others", async () => {
		const client = clientWith({
			listProjects: vi.fn(async (orgId: string) => {
				if (orgId === "org_1") throw new Error("403 no longer a member");
				return page([project({ orgId })]);
			}),
			listSessions: vi.fn(async () => page([])),
		});

		const workspaces = await fetchCloudWorkspaces(client, [
			{ id: "org_1", slug: "one", displayName: "One", role: "owner" },
			{ id: "org_2", slug: "two", displayName: "Two", role: "member" },
		]);

		expect(workspaces.map((workspace) => workspace.orgId)).toEqual(["org_2"]);
	});
});
