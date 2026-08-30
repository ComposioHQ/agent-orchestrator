import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import createClient from "openapi-fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { paths } from "../../api/schema";
import { fakeDaemon, type Behaviour } from "../test/fake-daemon";

const {
	captureRendererEventMock,
	cloudState,
	connectedHostsMock,
	getMock,
	hostListeners,
	isHostReadyMock,
	listProjectsMock,
	listSessionsMock,
} = vi.hoisted(() => ({
	captureRendererEventMock: vi.fn().mockResolvedValue(undefined),
	cloudState: { ready: false, org: undefined as { id: string } | undefined },
	connectedHostsMock: vi.fn((): string[] => []),
	getMock: vi.fn(),
	hostListeners: new Set<() => void>(),
	isHostReadyMock: vi.fn(() => true),
	listProjectsMock: vi.fn(),
	listSessionsMock: vi.fn(),
}));

vi.mock("../lib/api-client", () => ({
	apiErrorMessage: (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback),
}));

vi.mock("../lib/host-clients", () => ({
	clientFor: (host: string) => ({ GET: (url: string) => getMock(host, url) }),
	connectedHosts: connectedHostsMock,
	hostLabelFor: (host: string) => host === "http://192.0.2.1:3011" ? "workbox" : host,
	isHostReady: isHostReadyMock,
	subscribeConnectedHosts: (listener: () => void) => {
		hostListeners.add(listener);
		return () => hostListeners.delete(listener);
	},
}));

vi.mock("../lib/telemetry", () => ({ captureRendererEvent: captureRendererEventMock }));
vi.mock("./useCloudCp", () => ({
	useCloudCp: () => ({
		client: { listProjects: listProjectsMock, listSessions: listSessionsMock },
		ready: cloudState.ready,
		baseUrl: "https://cp.example.com",
	}),
}));
vi.mock("./useCloudOrg", () => ({
	useCloudOrg: () => ({ org: cloudState.org, isLoading: false, error: undefined, ready: cloudState.ready }),
}));

import { useWorkspaceQuery } from "./useWorkspaceQuery";
import { LOCAL_HOST, refKey, type HostId } from "../lib/hosts";

function wrapper({ children }: { children: ReactNode }) {
	// The hook pins its own retry policy; retryDelay 0 keeps the error tests fast.
	const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function renderWorkspaceQuery() {
	return renderHook(() => useWorkspaceQuery(), { wrapper });
}

function respondWith(payload: {
	projects?: { data?: unknown; error?: unknown };
	sessions?: { data?: unknown; error?: unknown };
}) {
	getMock.mockImplementation(async (_host: HostId, url: string) => {
		if (url === "/api/v1/projects") return payload.projects ?? { data: { projects: [] }, error: undefined };
		if (url === "/api/v1/sessions") return payload.sessions ?? { data: { sessions: [] }, error: undefined };
		throw new Error(`unexpected GET ${url}`);
	});
}

beforeEach(() => {
	captureRendererEventMock.mockClear();
	getMock.mockReset();
	connectedHostsMock.mockReset().mockReturnValue([]);
	hostListeners.clear();
	isHostReadyMock.mockReset().mockReturnValue(true);
	cloudState.ready = false;
	cloudState.org = undefined;
	listProjectsMock.mockReset();
	listSessionsMock.mockReset();
});

type HostFixture = {
	host: HostId;
	projects?: Array<{ id: string; name: string; path?: string }>;
	sessions?: Array<{ id: string; projectId: string }>;
	fail?: string;
	body?: unknown;
};

async function fetchAllForTest(fixtures: HostFixture[]) {
	connectedHostsMock.mockReturnValue(fixtures.map(({ host }) => host).filter((host) => host !== LOCAL_HOST));
	getMock.mockImplementation(async (host: HostId, url: string) => {
		const fixture = fixtures.find((candidate) => candidate.host === host);
		if (!fixture) throw new Error(`unexpected host ${host}`);
		if (fixture.fail) throw new Error(fixture.fail);
		if (fixture.body !== undefined) return { data: fixture.body, error: undefined };
		if (url === "/api/v1/projects") {
			return {
				data: {
					projects: (fixture.projects ?? []).map((project) => ({ path: `/${project.id}`, ...project })),
				},
				error: undefined,
			};
		}
		if (url === "/api/v1/sessions") {
			return {
				data: {
					sessions: (fixture.sessions ?? []).map((session) => ({
						isTerminated: false,
						updatedAt: "2026-08-11T00:00:00Z",
						...session,
					})),
				},
				error: undefined,
			};
		}
		throw new Error(`unexpected GET ${url}`);
	});

	const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });
	await waitFor(() => expect(result.current.isSuccess).toBe(true));
	return result.current.data ?? [];
}

describe("useWorkspaceQuery", () => {
	it.each<Behaviour>(["html-catchall", "wrong-shape"])(
		"reports %s workspace responses as malformed instead of throwing",
		async (behaviour) => {
			const client = createClient<paths>({ baseUrl: "http://x", fetch: fakeDaemon(behaviour) });
			getMock.mockImplementation((_host: HostId, url: "/api/v1/projects" | "/api/v1/sessions") =>
				client.GET(url),
			);

			let rendered: ReturnType<typeof renderWorkspaceQuery> | undefined;
			expect(() => {
				rendered = renderWorkspaceQuery();
			}).not.toThrow();
			if (!rendered) throw new Error("workspace query did not render");
			const { result } = rendered;

			await waitFor(() => expect(result.current.isSuccess).toBe(true));
			expect(result.current.data?.[0]).toMatchObject({
				status: "failed",
				failure: "Host returned malformed workspace data",
			});
		},
	);

	it("reports the local host as failed while the daemon client is not ready", async () => {
		isHostReadyMock.mockReturnValue(false);

		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data?.[0]).toMatchObject({
			host: LOCAL_HOST,
			status: "failed",
			workspaces: [],
		});
		expect(getMock).not.toHaveBeenCalled();
	});

	it("maps projects and their sessions, applying provider/status/title fallbacks", async () => {
		respondWith({
			projects: {
				data: {
					projects: [
						{
							id: "proj-1",
							name: "my-app",
							path: "/home/me/my-app",
							orchestratorAgent: "codex",
						},
					],
				},
				error: undefined,
			},
			sessions: {
				data: {
					sessions: [
						{
							id: "sess-1",
							projectId: "proj-1",
							terminalHandleId: "term-1",
							displayName: "fix-bug",
							issueId: "github:acme/project-one#42",
							harness: "claude-code",
							reviewerHarness: "qwen",
							branch: "qa/modal-worker",
							status: "mergeable",
							scmStatus: "review_pending",
							isTerminated: false,
							autoInjectReview: false,
							autoInjectCI: false,
							activity: { state: "idle", lastActivityAt: "2026-06-10T15:30:00Z" },
							activeAgentSwitch: {
								agentHandoffStatus: "received",
								errorCode: "delivery_unconfirmed",
								fromHarness: "claude-code",
								id: "switch-1",
								privateFutureField: "must-not-leak",
								requestedAt: "2026-06-10T15:31:00Z",
								semanticHandoffIncluded: true,
								sessionId: "sess-1",
								sourceTranscriptStatus: "available",
								state: "delivering_context",
								targetHarness: "codex",
								targetStartMode: "resumed",
								updatedAt: "2026-06-10T15:32:00Z",
							},
							lastUserMessageAt: "2026-06-10T16:10:00Z",
							updatedAt: "2026-06-10T16:15:04Z",
						},
						{
							// Unknown harness/status and no displayName/issueId: falls back
							// to codex / unknown / the session id.
							id: "sess-2",
							projectId: "proj-1",
							harness: "mystery-agent",
							reviewerHarness: "mystery-reviewer",
							status: "bogus",
							isTerminated: false,
							updatedAt: "2026-06-10T16:15:04Z",
						},
						// Belongs to another project; must not leak into proj-1.
						{ id: "sess-3", projectId: "proj-2", isTerminated: false, updatedAt: "2026-06-10T16:15:04Z" },
					],
				},
				error: undefined,
			},
		});

		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		const workspace = result.current.data?.[0].workspaces[0];
		expect(workspace).toBeDefined();
		if (!workspace) throw new Error("workspace missing");
		expect(workspace).toMatchObject({
			id: "proj-1",
			name: "my-app",
			path: "/home/me/my-app",
			orchestratorAgent: "codex",
		});
		expect(workspace.sessions).toHaveLength(2);
		expect(workspace.sessions[0]).toMatchObject({
			id: "sess-1",
			terminalHandleId: "term-1",
			title: "fix-bug",
			issueId: "github:acme/project-one#42",
			provider: "claude-code",
			reviewerHarness: "qwen",
			branch: "qa/modal-worker",
			status: "mergeable",
			scmStatus: "review_pending",
			activity: { state: "idle", lastActivityAt: "2026-06-10T15:30:00Z" },
			lastUserMessageAt: "2026-06-10T16:10:00Z",
			autoInjectReview: false,
			autoInjectCI: false,
		});
		expect(workspace.sessions[0].activeAgentSwitch).toEqual({
			agentHandoffStatus: "received",
			errorCode: "delivery_unconfirmed",
			fromHarness: "claude-code",
			id: "switch-1",
			state: "delivering_context",
			targetHarness: "codex",
		});
		expect(workspace.sessions[1]).toMatchObject({
			id: "sess-2",
			title: "sess-2",
			provider: "codex",
			reviewerHarness: undefined,
			status: "unknown",
			branch: undefined,
			autoInjectReview: true,
			autoInjectCI: true,
		});
		expect(captureRendererEventMock).toHaveBeenCalledWith("ao.renderer.session_state_unknown", {
			field: "status",
			reason: "unrecognized",
		});
		expect(captureRendererEventMock).toHaveBeenCalledWith("ao.renderer.session_state_unknown", {
			field: "activity",
			reason: "missing",
		});
	});

	it("preserves scratch projects and leaves branchless scratch sessions branchless", async () => {
		respondWith({
			projects: {
				data: {
					projects: [
						{
							id: "scratch",
							name: "Scratch",
							kind: "scratch",
							path: "/home/me/.ao/scratch/default",
						},
					],
				},
				error: undefined,
			},
			sessions: {
				data: {
					sessions: [
						{
							id: "scratch-worker-1",
							projectId: "scratch",
							harness: "codex",
							status: "working",
							isTerminated: false,
							updatedAt: "2026-06-10T16:15:04Z",
						},
					],
				},
				error: undefined,
			},
		});

		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(result.current.data?.[0].workspaces[0]).toMatchObject({
			id: "scratch",
			kind: "scratch",
		});
		expect(result.current.data?.[0].workspaces[0].sessions[0]).toMatchObject({
			id: "scratch-worker-1",
			branch: undefined,
		});
	});

	it("maps each session's prs straight from the session list", async () => {
		respondWith({
			projects: { data: { projects: [{ id: "proj-1", name: "my-app", path: "/p" }] }, error: undefined },
			sessions: {
				data: {
					sessions: [
						{
							id: "sess-1",
							projectId: "proj-1",
							status: "pr_open",
							isTerminated: false,
							updatedAt: "2026-06-10T16:15:04Z",
							prs: [
								{
									number: 278,
									state: "open",
									url: "u",
									ci: "passing",
									review: "approved",
									mergeability: "clean",
									reviewComments: false,
									updatedAt: "2026-06-10T16:15:04Z",
								},
							],
						},
						{
							id: "sess-2",
							projectId: "proj-1",
							status: "working",
							isTerminated: false,
							updatedAt: "2026-06-10T16:15:04Z",
						},
					],
				},
				error: undefined,
			},
		});

		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		const sessions = result.current.data?.[0].workspaces[0].sessions ?? [];
		expect(sessions[0].prs).toEqual([
			{
				number: 278,
				state: "open",
				url: "u",
				ci: "passing",
				review: "approved",
				mergeability: "clean",
				reviewComments: false,
				updatedAt: "2026-06-10T16:15:04Z",
			},
		]);
		// A session with no PRs maps to an empty stack, so the empty states render.
		expect(sessions[1].prs).toEqual([]);
	});

	it("preserves backend merged status for terminated merged sessions", async () => {
		respondWith({
			projects: { data: { projects: [{ id: "proj-1", name: "my-app", path: "/p" }] }, error: undefined },
			sessions: {
				data: {
					sessions: [
						{
							id: "sess-1",
							projectId: "proj-1",
							status: "merged",
							isTerminated: true,
							updatedAt: "2026-06-10T16:15:04Z",
						},
					],
				},
				error: undefined,
			},
		});

		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(result.current.data?.[0].workspaces[0].sessions[0].status).toBe("merged");
		expect(result.current.data?.[0].workspaces[0].sessions[0].isTerminated).toBe(true);
	});

	it("falls back to terminated for terminated sessions without a known backend status", async () => {
		respondWith({
			projects: { data: { projects: [{ id: "proj-1", name: "my-app", path: "/p" }] }, error: undefined },
			sessions: {
				data: {
					sessions: [
						{
							id: "sess-1",
							projectId: "proj-1",
							status: "bogus",
							isTerminated: true,
							updatedAt: "2026-06-10T16:15:04Z",
						},
					],
				},
				error: undefined,
			},
		});

		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(result.current.data?.[0].workspaces[0].sessions[0].status).toBe("terminated");
		expect(result.current.data?.[0].workspaces[0].sessions[0].isTerminated).toBe(true);
	});

	it("reports a projects fetch error on the local host", async () => {
		const failure = new TypeError("Failed to fetch");
		respondWith({ projects: { data: undefined, error: failure } });

		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data?.[0]).toMatchObject({ status: "failed", failure: "Failed to fetch" });
		expect(result.current.localFailure).toBe("Failed to fetch");
	});

	it("reports a sessions fetch error on the local host even when projects load", async () => {
		const failure = new Error("sessions backend down");
		respondWith({
			projects: { data: { projects: [{ id: "proj-1", name: "my-app", path: "/p" }] }, error: undefined },
			sessions: { data: undefined, error: failure },
		});

		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data?.[0]).toMatchObject({ status: "failed", failure: "sessions backend down" });
	});

	// Every client here is a plain openapi-fetch client, so none of these
	// failures reach api-client's ao.renderer.api_error. Before this the data
	// just stopped loading, with nothing anywhere saying so.
	it("reports a failed host fetch with the status that explains it", async () => {
		getMock.mockImplementation(async (_host: HostId, url: string) =>
			url === "/api/v1/projects"
				? { data: undefined, error: { message: "unauthorized" }, response: new Response(null, { status: 401 }) }
				: { data: { sessions: [] }, error: undefined, response: new Response(null, { status: 200 }) },
		);

		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(captureRendererEventMock).toHaveBeenCalledWith(
			"ao.renderer.host_query_failed",
			expect.objectContaining({ host_kind: "local", status: 401 }),
		);
	});

	it("adds control-plane projects after local projects in the local host section", async () => {
		cloudState.ready = true;
		cloudState.org = { id: "org-1" };
		listProjectsMock.mockResolvedValue({
			items: [{
				id: "cp-1",
				orgId: "org-1",
				displayName: "cloud-app",
				repositoryUrl: "https://github.com/acme/cloud-app",
				defaultBranch: "main",
				config: {},
				createdAt: "2026-08-01T00:00:00Z",
				updatedAt: "2026-08-01T00:00:00Z",
			}],
			page: { hasMore: false },
		});
		listSessionsMock.mockResolvedValue({ items: [], page: { hasMore: false } });
		respondWith({
			projects: { data: { projects: [{ id: "proj-1", name: "my-app", path: "/p" }] }, error: undefined },
		});

		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });
		await waitFor(() => expect(result.current.data?.[0]?.workspaces).toHaveLength(2));

		expect(result.current.data?.[0]?.workspaces.map((workspace) => workspace.id)).toEqual(["proj-1", "cp-1"]);
		expect(result.current.data?.[0]?.workspaces[1]).toMatchObject({ host: LOCAL_HOST, kind: "cloud" });
		expect(listProjectsMock).toHaveBeenCalledWith("org-1", { limit: 100 });
	});
});

describe("useWorkspaceQuery — multi-host", () => {
	const REMOTE = "http://192.0.2.1:3011";

	it("tags every workspace and session with its host", async () => {
		const sections = await fetchAllForTest([
			{
				host: LOCAL_HOST,
				projects: [{ id: "skyvern-cloud", name: "skyvern-cloud" }],
				sessions: [{ id: "s1", projectId: "skyvern-cloud" }],
			},
			{
				host: REMOTE,
				projects: [{ id: "skyvern-cloud", name: "skyvern-cloud" }],
				sessions: [{ id: "s1", projectId: "skyvern-cloud" }],
			},
		]);
		const hosts = sections.flatMap((section) => section.workspaces.map((workspace) => workspace.host));
		expect(hosts).toEqual([LOCAL_HOST, REMOTE]);
		expect(refKey({ host: LOCAL_HOST, id: "skyvern-cloud" })).not.toBe(
			refKey({ host: REMOTE, id: "skyvern-cloud" }),
		);
		expect(sections[0].workspaces[0].sessions[0].host).toBe(LOCAL_HOST);
		expect(sections[1].label).toBe("workbox");
	});

	it("one host failing does not discard another host's data", async () => {
		const sections = await fetchAllForTest([
			{ host: LOCAL_HOST, projects: [{ id: "p", name: "p" }], sessions: [] },
			{ host: REMOTE, fail: "connect ECONNREFUSED" },
		]);
		expect(sections.find((section) => section.host === LOCAL_HOST)?.status).toBe("ready");
		expect(sections.find((section) => section.host === LOCAL_HOST)?.workspaces).toHaveLength(1);
		const failed = sections.find((section) => section.host === REMOTE);
		expect(failed?.status).toBe("failed");
		expect(failed?.workspaces).toEqual([]);
		expect(failed?.failure).toMatch(/ECONNREFUSED/);
	});

	it("keeps the local board painted while a newly connected host is pending", async () => {
		getMock.mockImplementation(async (host: HostId, url: string) => {
			if (host === REMOTE) return new Promise(() => undefined);
			if (url === "/api/v1/projects") {
				return { data: { projects: [{ id: "local-project", name: "local-project", path: "/local" }] } };
			}
			if (url === "/api/v1/sessions") return { data: { sessions: [] } };
			throw new Error(`unexpected GET ${url}`);
		});
		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });
		await waitFor(() => expect(result.current.data?.[0]?.host).toBe(LOCAL_HOST));

		connectedHostsMock.mockReturnValue([REMOTE]);
		act(() => {
			for (const listener of hostListeners) listener();
		});

		expect(result.current.isSuccess).toBe(true);
		expect(result.current.isLoading).toBe(false);
		expect(result.current.data?.map((section) => section.host)).toEqual([LOCAL_HOST]);
	});

	it("refetches only the host targeted by a host-scoped invalidation", async () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
		const fetchCounts = new Map<HostId, number>();
		connectedHostsMock.mockReturnValue([REMOTE]);
		getMock.mockImplementation(async (host: HostId, url: string) => {
			if (url === "/api/v1/projects") {
				const count = (fetchCounts.get(host) ?? 0) + 1;
				fetchCounts.set(host, count);
				return { data: { projects: [{ id: host, name: `${host}-${count}`, path: `/${host}` }] } };
			}
			if (url === "/api/v1/sessions") return { data: { sessions: [] } };
			throw new Error(`unexpected GET ${url}`);
		});
		const queryWrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper: queryWrapper });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		await act(async () => {
			await queryClient.invalidateQueries({ queryKey: ["workspaces", REMOTE] });
		});

		await waitFor(() =>
			expect(result.current.data?.find((section) => section.host === REMOTE)?.workspaces[0].name).toBe(
				`${REMOTE}-2`,
			),
		);
		expect(fetchCounts.get(REMOTE)).toBe(2);
		expect(fetchCounts.get(LOCAL_HOST)).toBe(1);
	});

	it("retains last-good host data when an invalidated host refetch fails", async () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
		let remoteFails = false;
		connectedHostsMock.mockReturnValue([REMOTE]);
		getMock.mockImplementation(async (host: HostId, url: string) => {
			if (host === REMOTE && remoteFails) throw new Error("remote daemon dropped");
			if (url === "/api/v1/projects") {
				return { data: { projects: [{ id: host, name: host, path: `/${host}` }] } };
			}
			if (url === "/api/v1/sessions") return { data: { sessions: [] } };
			throw new Error(`unexpected GET ${url}`);
		});
		const queryWrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper: queryWrapper });
		await waitFor(() => expect(result.current.data).toHaveLength(2));

		remoteFails = true;
		await act(async () => {
			await queryClient.invalidateQueries({ queryKey: ["workspaces", REMOTE] });
		});
		await waitFor(() =>
			expect(result.current.data?.find((section) => section.host === REMOTE)?.status).toBe("failed"),
		);

		const remote = result.current.data?.find((section) => section.host === REMOTE);
		expect(remote).toMatchObject({ status: "failed", failure: "remote daemon dropped" });
		expect(remote?.workspaces.map((workspace) => workspace.id)).toEqual([REMOTE]);
		expect(result.current.data?.find((section) => section.host === LOCAL_HOST)?.workspaces).toHaveLength(1);
	});

	it("a host returning a malformed body fails that host, it does not throw", async () => {
		const sections = await fetchAllForTest([
			{ host: LOCAL_HOST, projects: [], sessions: [] },
			{ host: REMOTE, body: "<!doctype html><html></html>" },
		]);
		expect(sections.find((section) => section.host === REMOTE)?.status).toBe("failed");
		expect(sections.find((section) => section.host === LOCAL_HOST)?.status).toBe("ready");
	});

	it("joins sessions to projects within a host, never across hosts", async () => {
		const sections = await fetchAllForTest([
			{ host: LOCAL_HOST, projects: [{ id: "shared", name: "shared" }], sessions: [] },
			{
				host: REMOTE,
				projects: [{ id: "shared", name: "shared" }],
				sessions: [{ id: "r1", projectId: "shared" }],
			},
		]);
		expect(sections.find((section) => section.host === LOCAL_HOST)?.workspaces[0].sessions).toEqual([]);
		expect(sections.find((section) => section.host === REMOTE)?.workspaces[0].sessions).toHaveLength(1);
	});
});
