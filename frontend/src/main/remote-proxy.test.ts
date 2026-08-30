import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { startRemoteProxy, type ActiveProxy } from "./remote-proxy";

type Seen = {
	url: string;
	auth: string | undefined;
	origin: string | undefined;
	body: string;
};

let upstream: Server | undefined;
let proxy: ActiveProxy | undefined;
// Lifecycle logging is the point of these spies, not a side effect to silence:
// every assertion below reads them, and swallowing the output keeps the suite
// readable while the proxy narrates itself.
let logged: string[];
let warned: string[];

beforeEach(() => {
	logged = [];
	warned = [];
	vi.spyOn(console, "log").mockImplementation((message: unknown) => {
		logged.push(String(message));
	});
	vi.spyOn(console, "warn").mockImplementation((message: unknown) => {
		warned.push(String(message));
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	await proxy?.close();
	await new Promise<void>((resolve) => (upstream ? upstream.close(() => resolve()) : resolve()));
	upstream = undefined;
	proxy = undefined;
});

async function startUpstream(
	handler: (req: IncomingMessage, seen: Seen[]) => { status: number; body: string },
): Promise<{ port: number; seen: Seen[] }> {
	const seen: Seen[] = [];
	upstream = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			seen.push({
				url: req.url ?? "",
				auth: req.headers.authorization,
				origin: req.headers.origin,
				body,
			});
			const out = handler(req, seen);
			res.writeHead(out.status, { "content-type": "application/json" });
			res.end(out.body);
		});
	});
	await new Promise<void>((resolve) => upstream?.listen(0, "127.0.0.1", resolve));
	return { port: (upstream.address() as AddressInfo).port, seen };
}

describe("startRemoteProxy", () => {
	it("forwards with the token stripped and the credential injected", async () => {
		const { port, seen } = await startUpstream(() => ({
			status: 200,
			body: '{"ok":true}',
		}));
		proxy = await startRemoteProxy({
			label: "workbox",
			url: `http://127.0.0.1:${port}`,
			password: "pw",
		});

		const res = await fetch(`${proxy.base}/api/v1/projects`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: "app://renderer" },
			body: '{"path":"/srv/repo"}',
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(seen).toHaveLength(1);
		expect(seen[0].url).toBe("/api/v1/projects"); // token gone
		expect(seen[0].auth).toBe("Bearer pw");
		expect(seen[0].origin).toBeUndefined(); // app://renderer never reaches the daemon
		expect(seen[0].body).toBe('{"path":"/srv/repo"}');
	});

	// The add-host dialog accepts https://, so this is what a Tailscale Serve or
	// reverse-proxy address does today: the upstream is a TLS endpoint and the
	// proxy must not put the connection password on the wire in the clear.
	it("never sends the credential in the clear to an https host", async () => {
		const { port, seen } = await startUpstream(() => ({ status: 200, body: "{}" }));
		proxy = await startRemoteProxy({
			label: "workbox",
			url: `https://127.0.0.1:${port}`,
			password: "pw",
		});

		// A cleartext listener cannot complete a TLS handshake, so the honest
		// outcome is a failed request — never a plaintext one that succeeds.
		const res = await fetch(`${proxy.base}/api/v1/projects`);
		expect(res.status).toBe(502);
		expect(seen).toHaveLength(0);
	});

	// A daemon can live behind a reverse proxy at a path. The renderer's base is
	// the loopback proxy's own root, so the upstream prefix is restored here or
	// every credentialled request lands on whatever else that vhost serves.
	it("restores the host's path prefix upstream", async () => {
		const { port, seen } = await startUpstream(() => ({ status: 200, body: "{}" }));
		proxy = await startRemoteProxy({
			label: "workbox",
			url: `http://127.0.0.1:${port}/ao`,
			password: "pw",
		});

		await fetch(`${proxy.base}/api/v1/projects`);
		expect(seen[0].url).toBe("/ao/api/v1/projects");
	});

	it("refuses a request without the token and sends nothing upstream", async () => {
		const { port, seen } = await startUpstream(() => ({
			status: 200,
			body: "{}",
		}));
		proxy = await startRemoteProxy({
			label: "workbox",
			url: `http://127.0.0.1:${port}`,
			password: "pw",
		});

		const bare = new URL(proxy.base);
		const res = await fetch(`${bare.origin}/api/v1/projects`);
		expect(res.status).toBe(404);
		expect(seen).toHaveLength(0);
	});

	it("refuses a near-miss token prefix", async () => {
		const { port, seen } = await startUpstream(() => ({
			status: 200,
			body: "{}",
		}));
		proxy = await startRemoteProxy({
			label: "workbox",
			url: `http://127.0.0.1:${port}`,
			password: "pw",
		});

		// A path that merely starts with the token's characters is not the token:
		// /<token>x/... must not authorize, or the token stops being a boundary.
		const bare = new URL(proxy.base);
		const res = await fetch(`${bare.origin}${bare.pathname}x/api/v1/projects`);
		expect(res.status).toBe(404);
		expect(seen).toHaveLength(0);
	});

	it("answers CORS preflight itself for the renderer origin", async () => {
		const { port, seen } = await startUpstream(() => ({
			status: 200,
			body: "{}",
		}));
		proxy = await startRemoteProxy({
			label: "workbox",
			url: `http://127.0.0.1:${port}`,
			password: "pw",
		});

		const res = await fetch(`${proxy.base}/api/v1/projects`, {
			method: "OPTIONS",
			headers: {
				origin: "app://renderer",
				"access-control-request-method": "POST",
				"access-control-request-headers": "content-type",
			},
		});
		expect(res.status).toBe(204);
		expect(res.headers.get("access-control-allow-origin")).toBe("app://renderer");
		expect(res.headers.get("access-control-allow-headers")).toMatch(/content-type/i);
		expect(seen).toHaveLength(0); // preflight never leaves the machine
	});

	it("adds the renderer origin to real responses so cross-origin fetch succeeds", async () => {
		const { port } = await startUpstream(() => ({
			status: 400,
			body: '{"error":"bad"}',
		}));
		proxy = await startRemoteProxy({
			label: "workbox",
			url: `http://127.0.0.1:${port}`,
			password: "pw",
		});

		const res = await fetch(`${proxy.base}/api/v1/projects`, {
			headers: { origin: "app://renderer" },
		});
		expect(res.status).toBe(400); // errors pass through untouched…
		expect(res.headers.get("access-control-allow-origin")).toBe("app://renderer"); // …but stay readable
	});

	it("returns 502 when the upstream is unreachable", async () => {
		proxy = await startRemoteProxy({
			label: "dead",
			url: "http://127.0.0.1:1",
			password: "pw",
		});
		const res = await fetch(`${proxy.base}/api/v1/projects`);
		expect(res.status).toBe(502);
	});

	// "The app can't reach my host" had no answer anywhere before this, and the
	// only thing that could make these lines unshippable is a secret in one.
	it("logs its own lifecycle without the token or the password", async () => {
		const { port } = await startUpstream(() => ({ status: 200, body: "{}" }));
		proxy = await startRemoteProxy({ label: "workbox", url: `http://127.0.0.1:${port}`, password: "hunter2secret" });
		const token = new URL(proxy.base).pathname.slice(1);

		expect(logged.some((line) => line.includes("[remote-proxy] started on 127.0.0.1:"))).toBe(true);
		await proxy.close();
		proxy = undefined;
		expect(logged.some((line) => line.includes("[remote-proxy] stopped on 127.0.0.1:"))).toBe(true);

		const everything = [...logged, ...warned].join("\n");
		expect(everything).not.toContain("hunter2secret");
		expect(everything).not.toContain(token);
	});

	it("warns which upstream failed when it answers 502, naming no secret", async () => {
		const { port } = await startUpstream(() => ({ status: 200, body: "{}" }));
		await new Promise<void>((resolve) => (upstream ? upstream.close(() => resolve()) : resolve()));
		upstream = undefined;
		proxy = await startRemoteProxy({ label: "workbox", url: `http://127.0.0.1:${port}`, password: "hunter2secret" });
		const token = new URL(proxy.base).pathname.slice(1);

		const res = await fetch(`${proxy.base}/api/v1/projects`);
		expect(res.status).toBe(502);
		const warning = warned.find((line) => line.includes("answering 502"));
		expect(warning).toContain(`127.0.0.1:${port}`);
		// The post-strip path, which is the useful half; req.url starts with the token.
		expect(warning).toContain("/api/v1/projects");
		expect(warning).not.toContain("hunter2secret");
		expect(warning).not.toContain(token);
	});

	it("listens on loopback only", async () => {
		const { port } = await startUpstream(() => ({ status: 200, body: "{}" }));
		proxy = await startRemoteProxy({
			label: "workbox",
			url: `http://127.0.0.1:${port}`,
			password: "pw",
		});
		expect(new URL(proxy.base).hostname).toBe("127.0.0.1");
	});
});

describe("startRemoteProxy streams", () => {
	it("closes while an upgraded socket is still open", async () => {
		upstream = createServer();
		const upgraded = new Promise<void>((resolve) => {
			upstream?.on("upgrade", (_req, socket) => {
				socket.on("error", () => undefined);
				socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
				socket.on("end", () => socket.destroy());
				resolve();
			});
		});
		await new Promise<void>((resolve) => upstream?.listen(0, "127.0.0.1", resolve));
		const port = (upstream.address() as AddressInfo).port;
		proxy = await startRemoteProxy({
			label: "workbox",
			url: `http://127.0.0.1:${port}`,
			password: "pw",
		});

		const proxyUrl = new URL(proxy.base);
		const socket = netConnect(Number(proxyUrl.port), "127.0.0.1");
		socket.on("error", () => undefined);
		socket.write(
			`GET ${proxyUrl.pathname}/mux HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
		);
		await upgraded;

		const closing = proxy.close();
		const result = await Promise.race([
			closing.then(() => "closed"),
			new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 500)),
		]);
		socket.destroy();
		await closing;
		proxy = undefined;

		expect(result).toBe("closed");
	});

	// Regression for the connection-status hang: the previous test's upstream
	// writes its first chunk synchronously, so headers and that chunk reach the
	// client together even without an explicit flush — it never exercised the
	// gap. A real SSE upstream (GET /api/v1/events) can hold its first byte
	// indefinitely; a client's EventSource must still see the response headers
	// right away; otherwise it reports CONNECTING forever, which is exactly what
	// "not receiving live updates" looked like before this was found.
	it("flushes response headers before the first SSE byte arrives", async () => {
		upstream = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			// The real daemon flushes its own headers immediately (confirmed by a
			// direct curl against it) — this upstream must too, or the test would
			// measure the fake upstream's header delay instead of the proxy's.
			res.flushHeaders();
			// The body is what's withheld for 500ms, like a daemon with nothing to
			// say yet.
			setTimeout(() => {
				res.write("data: first\n\n");
				res.end();
			}, 500);
		});
		await new Promise<void>((resolve) => upstream?.listen(0, "127.0.0.1", resolve));
		const port = (upstream.address() as AddressInfo).port;
		proxy = await startRemoteProxy({
			label: "workbox",
			url: `http://127.0.0.1:${port}`,
			password: "pw",
		});

		const proxyUrl = new URL(proxy.base);
		const started = Date.now();
		const head = await new Promise<string>((resolve) => {
			const socket = netConnect(Number(proxyUrl.port), "127.0.0.1", () => {
				socket.write(`GET ${proxyUrl.pathname}/api/v1/events HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
			});
			socket.on("error", () => undefined);
			let buf = "";
			socket.on("data", (chunk: Buffer) => {
				buf += chunk.toString();
				if (buf.includes("\r\n\r\n")) {
					socket.destroy();
					resolve(buf);
				}
			});
		});
		const headersArrivedAfterMs = Date.now() - started;

		expect(head).toContain("200");
		expect(head.toLowerCase()).toContain("content-type: text/event-stream");
		// The upstream withholds its first byte for 500ms; seeing the header
		// block well before that proves the proxy flushes headers on their own
		// rather than only when they can piggyback on the first body write.
		expect(headersArrivedAfterMs).toBeLessThan(300);
	});

	it("delivers SSE chunks as they are written, not on close", async () => {
		upstream = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write("data: first\n\n");
			setTimeout(() => {
				res.write("data: second\n\n");
				res.end();
			}, 500);
		});
		await new Promise<void>((resolve) => upstream?.listen(0, "127.0.0.1", resolve));
		const port = (upstream.address() as AddressInfo).port;
		proxy = await startRemoteProxy({
			label: "workbox",
			url: `http://127.0.0.1:${port}`,
			password: "pw",
		});

		const res = await fetch(`${proxy.base}/api/v1/events`);
		const reader = res.body!.getReader();
		const started = Date.now();
		const first = new TextDecoder().decode((await reader.read()).value);
		const firstArrivedAfterMs = Date.now() - started;

		expect(first).toContain("data: first");
		// The second chunk is written 500ms later; receiving the first well before
		// that proves streaming rather than buffer-until-close.
		expect(firstArrivedAfterMs).toBeLessThan(300);
		let rest = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			rest += new TextDecoder().decode(value);
		}
		expect(rest).toContain("data: second");
	});

	it("tunnels a WebSocket upgrade with the credential injected", async () => {
		const sawAuth: Array<string | undefined> = [];
		upstream = createServer();
		upstream.on("upgrade", (req, socket) => {
			sawAuth.push(req.headers.authorization);
			socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
			socket.on("data", (d) => socket.write(d)); // echo frames back verbatim
			// Upgraded sockets are half-open by default and would hold close() open.
			socket.on("end", () => socket.destroy());
		});
		await new Promise<void>((resolve) => upstream?.listen(0, "127.0.0.1", resolve));
		const port = (upstream.address() as AddressInfo).port;
		proxy = await startRemoteProxy({
			label: "workbox",
			url: `http://127.0.0.1:${port}`,
			password: "pw",
		});

		const proxyUrl = new URL(proxy.base);
		const received: Buffer[] = [];
		const socket = netConnect(Number(proxyUrl.port), "127.0.0.1");
		await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
		socket.on("data", (d) => received.push(d));
		socket.write(
			`GET ${proxyUrl.pathname}/mux HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
		);
		await new Promise((resolve) => setTimeout(resolve, 200));
		socket.write("payload-bytes");
		await new Promise((resolve) => setTimeout(resolve, 200));
		socket.destroy();

		const all = Buffer.concat(received).toString();
		expect(all).toContain("101 Switching Protocols");
		expect(all).toContain("payload-bytes"); // echoed through both pipes
		expect(sawAuth).toEqual(["Bearer pw"]);
	});

	it("destroys an upgrade that carries no token", async () => {
		const sawUpgrade: string[] = [];
		upstream = createServer();
		upstream.on("upgrade", (upgraded) => sawUpgrade.push(upgraded.url ?? ""));
		await new Promise<void>((resolve) => upstream?.listen(0, "127.0.0.1", resolve));
		const port = (upstream.address() as AddressInfo).port;
		proxy = await startRemoteProxy({
			label: "workbox",
			url: `http://127.0.0.1:${port}`,
			password: "pw",
		});

		const proxyUrl = new URL(proxy.base);
		const socket = netConnect(Number(proxyUrl.port), "127.0.0.1");
		await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
		const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
		socket.on("error", () => undefined);
		socket.write(
			"GET /mux HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n",
		);
		await closed;
		expect(sawUpgrade).toEqual([]);
	});
});
