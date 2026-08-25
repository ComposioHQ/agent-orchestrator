import { describe, expect, it } from "vitest";
import { createCloudCpClient } from "./client";
import { CloudCpAuthError, CloudCpError } from "./errors";
import type { CloudCpClientEvent } from "./types";

interface RecordedCall {
	url: string;
	init: RequestInit | undefined;
}

function createFetchMock(responses: Array<Response | Error>): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		calls.push({ url: String(input), init });
		const next = responses.shift();
		if (next === undefined) throw new Error("unexpected fetch call");
		if (next instanceof Error) throw next;
		return next;
	};
	return { fetchImpl, calls };
}

function makeClient(responses: Array<Response | Error>, token: string | null = "workos-token-1") {
	const { fetchImpl, calls } = createFetchMock(responses);
	const client = createCloudCpClient({
		// Trailing slash on purpose: the client must not emit "//api/cloud/v1".
		baseUrl: "https://cp.example.test/",
		getToken: async () => token,
		fetchImpl,
	});
	return { client, calls };
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function headersOf(call: RecordedCall): Headers {
	return new Headers(call.init?.headers);
}

function sseResponse(chunks: string[], options: { failAfterChunks?: boolean } = {}): Response {
	const encoder = new TextEncoder();
	let delivered = 0;
	// Pull-based so an injected failure only fires after every chunk has been
	// read: erroring the controller up front would discard queued chunks.
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (delivered < chunks.length) {
				controller.enqueue(encoder.encode(chunks[delivered]));
				delivered += 1;
				return;
			}
			if (options.failAfterChunks === true) {
				controller.error(new TypeError("network lost"));
			} else {
				controller.close();
			}
		},
	});
	return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const ORG = "0b6f2b1e-8a53-4a5e-9f3a-9a4d1c2e3f40";
const PROJECT = "1c7f3c2f-9b64-4b6f-8e4b-8b5e2d3f4a51";
const SESSION = "2d8a4d30-ac75-4c70-9f5c-7c6f3e4a5b62";
const TURN = "3e9b5e41-bd86-4d81-8a6d-6d7a4f5b6c73";

describe("createCloudCpClient", () => {
	it("attaches the bearer token and hits the versioned path", async () => {
		const { client, calls } = makeClient([
			jsonResponse(200, { user: { id: "u1", email: "a@b.c", displayName: "A", authProvider: "workos" }, organizations: [] }),
		]);
		const me = await client.me();
		expect(me.user.id).toBe("u1");
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://cp.example.test/api/cloud/v1/me");
		expect(calls[0].init?.method).toBe("GET");
		expect(headersOf(calls[0]).get("authorization")).toBe("Bearer workos-token-1");
	});

	it("throws CloudCpAuthError without touching the network when no token is available", async () => {
		const { client, calls } = makeClient([], null);
		const error = await client.me().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(CloudCpAuthError);
		expect((error as CloudCpAuthError).status).toBe(401);
		expect((error as CloudCpAuthError).code).toBe("no_token");
		expect(calls).toHaveLength(0);
	});

	it("surfaces a 401 as CloudCpAuthError carrying the envelope fields", async () => {
		const { client } = makeClient([
			jsonResponse(401, {
				error: "Unauthorized",
				code: "invalid_token",
				message: "The access token is invalid.",
				requestId: "req-401",
			}),
		]);
		const error = await client.listMyInvitations().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(CloudCpAuthError);
		const authError = error as CloudCpAuthError;
		expect(authError.status).toBe(401);
		expect(authError.code).toBe("invalid_token");
		expect(authError.requestId).toBe("req-401");
		expect(authError.message).toBe("The access token is invalid.");
	});

	it("surfaces other non-2xx statuses as CloudCpError with status and parsed message", async () => {
		const { client } = makeClient([
			jsonResponse(422, {
				error: "Unprocessable Entity",
				code: "validation_error",
				message: "Workspace name must be between 1 and 80 characters.",
				requestId: "req-422",
			}),
		]);
		const error = await client.createOrganization({ displayName: "" }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(CloudCpError);
		expect(error).not.toBeInstanceOf(CloudCpAuthError);
		const cpError = error as CloudCpError;
		expect(cpError.status).toBe(422);
		expect(cpError.code).toBe("validation_error");
		expect(cpError.message).toBe("Workspace name must be between 1 and 80 characters.");
	});

	it("falls back to a status message when the error body is not JSON", async () => {
		const { client } = makeClient([new Response("bad gateway", { status: 502 })]);
		const error = await client.me().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(CloudCpError);
		expect((error as CloudCpError).status).toBe(502);
		expect((error as CloudCpError).message).toContain("502");
	});

	it("creates organizations with a JSON body", async () => {
		const { client, calls } = makeClient([
			jsonResponse(201, { organization: { id: "o1", slug: "acme", displayName: "Acme", role: "owner" } }),
		]);
		const created = await client.createOrganization({ displayName: "Acme" });
		expect(created.organization.slug).toBe("acme");
		expect(calls[0].url).toBe("https://cp.example.test/api/cloud/v1/orgs");
		expect(calls[0].init?.method).toBe("POST");
		expect(headersOf(calls[0]).get("content-type")).toBe("application/json");
		expect(JSON.parse(calls[0].init?.body as string)).toEqual({ displayName: "Acme" });
	});

	it("covers the project CRUD group with idempotent create", async () => {
		const project = {
			id: PROJECT,
			orgId: ORG,
			displayName: "Web",
			repositoryUrl: "https://github.com/acme/web",
			defaultBranch: "main",
			config: {},
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
		};
		const { client, calls } = makeClient([
			jsonResponse(201, { project }),
			jsonResponse(200, { items: [project], page: { hasMore: true, nextCursor: "c1" } }),
			jsonResponse(200, { project }),
			jsonResponse(202, { project: { id: PROJECT, deleted: true } }),
		]);

		const created = await client.createProject(
			ORG,
			{ displayName: "Web", repositoryUrl: "https://github.com/acme/web", defaultBranch: "main" },
			{ idempotencyKey: "idem-1" },
		);
		expect(created.project.id).toBe(PROJECT);
		expect(calls[0].url).toBe(`https://cp.example.test/api/cloud/v1/orgs/${ORG}/projects`);
		expect(headersOf(calls[0]).get("idempotency-key")).toBe("idem-1");

		const listed = await client.listProjects(ORG, { limit: 10, cursor: "abc" });
		expect(listed.page.nextCursor).toBe("c1");
		expect(calls[1].url).toBe(`https://cp.example.test/api/cloud/v1/orgs/${ORG}/projects?limit=10&cursor=abc`);

		await client.updateProject(ORG, PROJECT, { displayName: "Web", defaultBranch: "dev" });
		expect(calls[2].init?.method).toBe("PATCH");
		expect(calls[2].url).toBe(`https://cp.example.test/api/cloud/v1/orgs/${ORG}/projects/${PROJECT}`);

		const deleted = await client.deleteProject(ORG, PROJECT);
		expect(calls[3].init?.method).toBe("DELETE");
		expect(deleted.project.deleted).toBe(true);
	});

	it("covers the session group, generating an Idempotency-Key when none is pinned", async () => {
		const session = {
			id: SESSION,
			orgId: ORG,
			projectId: PROJECT,
			kind: "worker",
			harness: "claude-code",
			displayName: "Fix bug",
			branch: "ao/fix-bug",
			mode: "trusted",
			deniedCommands: [],
			activityState: "idle",
			status: "running",
			runtimeConnected: true,
			isTerminated: false,
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
		};
		const { client, calls } = makeClient([
			jsonResponse(201, { session }),
			jsonResponse(200, { items: [session], page: { hasMore: false } }),
			jsonResponse(200, { session }),
			jsonResponse(202, { session: { id: SESSION, desiredState: "deleted" } }),
			jsonResponse(202, { woken: 2 }),
		]);

		const created = await client.createSession(ORG, {
			projectId: PROJECT,
			kind: "worker",
			harness: "claude-code",
			displayName: "Fix bug",
			prompt: "Fix the bug",
		});
		expect(created.session.id).toBe(SESSION);
		const generatedKey = headersOf(calls[0]).get("idempotency-key");
		expect(generatedKey).toBeTruthy();
		expect(generatedKey).toMatch(/^[0-9a-f-]{36}$/);

		await client.listSessions(ORG, { projectId: PROJECT, limit: 5 });
		expect(calls[1].url).toBe(
			`https://cp.example.test/api/cloud/v1/orgs/${ORG}/sessions?projectId=${PROJECT}&limit=5`,
		);

		await client.getSession(ORG, SESSION);
		expect(calls[2].url).toBe(`https://cp.example.test/api/cloud/v1/orgs/${ORG}/sessions/${SESSION}`);

		const deleted = await client.deleteSession(ORG, SESSION);
		expect(deleted.session.desiredState).toBe("deleted");

		const woken = await client.wakePausedSessions(ORG);
		expect(woken.woken).toBe(2);
		expect(calls[4].url).toBe(`https://cp.example.test/api/cloud/v1/orgs/${ORG}/sessions/wake`);
		expect(calls[4].init?.method).toBe("POST");
	});

	it("covers messages, turn cancellation, and chat-event replay", async () => {
		const event = { sessionId: SESSION, sequence: 4, type: "chat", payload: { role: "user" }, createdAt: "2026-01-01T00:00:00Z" };
		const { client, calls } = makeClient([
			jsonResponse(202, { event }),
			jsonResponse(202, { ok: true }),
			jsonResponse(200, { events: [event], hasMore: false, nextAfter: 4 }),
		]);

		const sent = await client.sendSessionMessage(ORG, SESSION, { text: "hello" }, { idempotencyKey: "msg-1" });
		expect(sent.event.sequence).toBe(4);
		expect(calls[0].url).toBe(`https://cp.example.test/api/cloud/v1/orgs/${ORG}/sessions/${SESSION}/messages`);
		expect(headersOf(calls[0]).get("idempotency-key")).toBe("msg-1");

		const cancelled = await client.cancelTurn(ORG, SESSION, TURN);
		expect(cancelled.ok).toBe(true);
		expect(calls[1].url).toBe(
			`https://cp.example.test/api/cloud/v1/orgs/${ORG}/sessions/${SESSION}/turns/${TURN}/cancel`,
		);

		const replayed = await client.listChatEvents(ORG, SESSION, { after: 3, limit: 50 });
		expect(replayed.nextAfter).toBe(4);
		expect(calls[2].url).toBe(
			`https://cp.example.test/api/cloud/v1/orgs/${ORG}/sessions/${SESSION}/chat-events?after=3&limit=50`,
		);
	});

	it("creates terminal tickets", async () => {
		const { client, calls } = makeClient([
			jsonResponse(201, { ticket: "t-1", expiresIn: 300, scopes: ["workspace"] }),
		]);
		const ticket = await client.createTerminalTicket(ORG, SESSION, { kind: "workspace" });
		expect(ticket.ticket).toBe("t-1");
		expect(ticket.expiresIn).toBe(300);
		expect(calls[0].url).toBe(
			`https://cp.example.test/api/cloud/v1/orgs/${ORG}/sessions/${SESSION}/terminal-ticket`,
		);
		expect(JSON.parse(calls[0].init?.body as string)).toEqual({ kind: "workspace" });
	});

	it("covers the provider-connection group including a bodyless 204 delete", async () => {
		const connection = {
			id: "pc-1",
			provider: "claude-code",
			label: "default",
			config: { credentialType: "api_key" },
			validationState: "valid",
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
		};
		const { client, calls } = makeClient([
			jsonResponse(200, { providerConnections: [connection] }),
			jsonResponse(200, { providerConnection: connection }),
			new Response(null, { status: 204 }),
		]);

		const listed = await client.listProviderConnections(ORG);
		expect(listed.providerConnections).toHaveLength(1);
		expect(calls[0].url).toBe(`https://cp.example.test/api/cloud/v1/orgs/${ORG}/provider-connections`);

		const put = await client.putAgentConnection(ORG, "claude-code", { credentialType: "api_key", secret: "sk-x" });
		expect(put.providerConnection.validationState).toBe("valid");
		expect(calls[1].init?.method).toBe("PUT");
		expect(calls[1].url).toBe(
			`https://cp.example.test/api/cloud/v1/orgs/${ORG}/provider-connections/agents/claude-code`,
		);

		await expect(client.deleteAgentConnection(ORG, "claude-code")).resolves.toBeUndefined();
		expect(calls[2].init?.method).toBe("DELETE");
	});
});

describe("subscribeSessionEvents", () => {
	const frame = (sequence: number): string => {
		const payload: CloudCpClientEvent = {
			sessionId: SESSION,
			sequence,
			type: "chat",
			payload: { n: sequence },
			createdAt: "2026-01-01T00:00:00Z",
		};
		return `id: ${sequence}\nevent: chat\ndata: ${JSON.stringify(payload)}\n\n`;
	};

	it("parses a multi-event stream, spanning chunk boundaries, and resolves at end", async () => {
		const whole = `retry: 2000\n\n${frame(1)}: keepalive\n\n${frame(2)}${frame(3)}`;
		// Split mid-frame to prove buffering across reads.
		const chunks = [whole.slice(0, 40), whole.slice(40, 90), whole.slice(90)];
		const { client, calls } = makeClient([sseResponse(chunks)]);
		const events: CloudCpClientEvent[] = [];
		const errors: CloudCpError[] = [];

		await client.subscribeSessionEvents(ORG, SESSION, {
			onEvent: (event) => events.push(event),
			onError: (error) => errors.push(error),
			after: 0,
		});

		expect(errors).toEqual([]);
		expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
		expect(events[0].payload).toEqual({ n: 1 });
		expect(calls[0].url).toBe(
			`https://cp.example.test/api/cloud/v1/orgs/${ORG}/sessions/${SESSION}/events?after=0`,
		);
		expect(headersOf(calls[0]).get("authorization")).toBe("Bearer workos-token-1");
		expect(headersOf(calls[0]).get("accept")).toBe("text/event-stream");
	});

	it("reports a non-2xx subscription as a typed error through onError and resolves", async () => {
		const { client } = makeClient([
			jsonResponse(401, { error: "Unauthorized", code: "invalid_token", message: "Expired.", requestId: "r1" }),
		]);
		const events: CloudCpClientEvent[] = [];
		const errors: CloudCpError[] = [];

		await client.subscribeSessionEvents(ORG, SESSION, {
			onEvent: (event) => events.push(event),
			onError: (error) => errors.push(error),
		});

		expect(events).toEqual([]);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toBeInstanceOf(CloudCpAuthError);
		expect(errors[0].status).toBe(401);
	});

	it("delivers events read before a mid-stream failure, then reports the failure", async () => {
		const { client } = makeClient([sseResponse([frame(1)], { failAfterChunks: true })]);
		const events: CloudCpClientEvent[] = [];
		const errors: CloudCpError[] = [];

		await client.subscribeSessionEvents(ORG, SESSION, {
			onEvent: (event) => events.push(event),
			onError: (error) => errors.push(error),
		});

		expect(events.map((event) => event.sequence)).toEqual([1]);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toBeInstanceOf(CloudCpError);
		expect(errors[0].status).toBe(0);
		expect(errors[0].message).toContain("network lost");
	});

	it("reports a malformed JSON frame but keeps delivering later events", async () => {
		const { client } = makeClient([sseResponse(["data: {not json}\n\n", frame(2)])]);
		const events: CloudCpClientEvent[] = [];
		const errors: CloudCpError[] = [];

		await client.subscribeSessionEvents(ORG, SESSION, {
			onEvent: (event) => events.push(event),
			onError: (error) => errors.push(error),
		});

		expect(errors).toHaveLength(1);
		expect(errors[0].message).toContain("malformed JSON");
		expect(events.map((event) => event.sequence)).toEqual([2]);
	});

	it("stays silent when the subscription is aborted via the signal", async () => {
		const controller = new AbortController();
		controller.abort();
		const { client } = makeClient([new DOMException("The operation was aborted.", "AbortError")]);
		const errors: CloudCpError[] = [];

		await client.subscribeSessionEvents(ORG, SESSION, {
			onEvent: () => {},
			onError: (error) => errors.push(error),
			signal: controller.signal,
		});

		expect(errors).toEqual([]);
	});
});
