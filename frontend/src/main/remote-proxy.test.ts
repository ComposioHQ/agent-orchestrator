// @vitest-environment node
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	startRemoteProxy,
	type HttpsTransport,
	type RemoteProxyDeps,
	type RemoteProxyHandle,
	type WebSocketFactory,
} from "./remote-proxy";

const execFileAsync = promisify(execFile);

const PASSWORD = "test-remote-password";

type SeenRequest = {
	method: string | undefined;
	url: string | undefined;
	headers: http.IncomingHttpHeaders;
	body: string;
};

// The proxy must use default TLS validation in production, so tests reach the
// self-signed upstream through the documented test-only seams.
const insecureTransport: HttpsTransport = (options, callback) =>
	https.request({ ...options, rejectUnauthorized: false }, callback);

const insecureWebSocketFactory: WebSocketFactory = (url, options) =>
	new WebSocket(url, { ...options, rejectUnauthorized: false });

// Generate a self-signed cert at test time (no selfsigned/node-forge in the
// dependency tree). openssl is available on every dev/CI platform we run on.
async function generateSelfSignedCert(dir: string): Promise<{ cert: string; key: string }> {
	const keyPath = path.join(dir, "key.pem");
	const certPath = path.join(dir, "cert.pem");
	await execFileAsync("openssl", [
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-keyout",
		keyPath,
		"-out",
		certPath,
		"-days",
		"1",
		"-subj",
		"/CN=localhost",
		"-addext",
		"subjectAltName=DNS:localhost,IP:127.0.0.1",
	]);
	const [cert, key] = await Promise.all([readFile(certPath, "utf8"), readFile(keyPath, "utf8")]);
	return { cert, key };
}

function rawRequest(opts: {
	port: number;
	method?: string;
	path: string;
	headers?: Record<string, string>;
	body?: string;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				host: "127.0.0.1",
				port: opts.port,
				method: opts.method ?? "GET",
				path: opts.path,
				headers: opts.headers,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () =>
					resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
				);
			},
		);
		req.on("error", reject);
		if (opts.body !== undefined) req.write(opts.body);
		req.end();
	});
}

async function reserveClosedPort(): Promise<number> {
	const server = net.createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

describe("remote-proxy", () => {
	let tempDir: string;
	let upstream: https.Server;
	let upstreamWss: WebSocketServer;
	let upstreamPort: number;
	let proxy: RemoteProxyHandle;
	let extraProxies: RemoteProxyHandle[];
	let seen: SeenRequest[];
	let sseUpstreamEnded: boolean;
	let lastUpgradeHeaders: http.IncomingHttpHeaders | undefined;
	let lastUpstreamWs: WebSocket | undefined;

	async function startProxy(remoteUrl: string): Promise<RemoteProxyHandle> {
		const deps: RemoteProxyDeps = {
			remoteUrl,
			password: PASSWORD,
			transport: insecureTransport,
			webSocketFactory: insecureWebSocketFactory,
		};
		const handle = await startRemoteProxy(deps);
		extraProxies.push(handle);
		return handle;
	}

	beforeAll(async () => {
		tempDir = await mkdtemp(path.join(os.tmpdir(), "ao-remote-proxy-test-"));
		const { cert, key } = await generateSelfSignedCert(tempDir);
		extraProxies = [];
		seen = [];
		sseUpstreamEnded = false;

		upstream = https.createServer({ cert, key }, (req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk) => chunks.push(chunk));
			req.on("end", () => {
				const body = Buffer.concat(chunks).toString("utf8");
				seen.push({ method: req.method, url: req.url, headers: req.headers, body });
				const pathname = new URL(req.url ?? "/", "https://localhost").pathname;

				if (pathname === "/redirect") {
					res.writeHead(302, { location: "https://example.invalid/takeover" });
					res.end();
					return;
				}
				if (pathname === "/unauthorized") {
					res.writeHead(401, { "content-type": "application/json" });
					res.end('{"message":"unauthorized"}');
					return;
				}
				if (pathname === "/api/v1/events") {
					res.writeHead(200, { "content-type": "text/event-stream" });
					res.write("data: one\n\n");
					setTimeout(() => {
						res.write("data: two\n\n");
						res.end();
						sseUpstreamEnded = true;
					}, 150);
					return;
				}
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true, method: req.method, url: req.url, body }));
			});
		});

		upstreamWss = new WebSocketServer({ noServer: true });
		upstream.on("upgrade", (req, socket, head) => {
			lastUpgradeHeaders = req.headers;
			upstreamWss.handleUpgrade(req, socket, head, (ws) => {
				lastUpstreamWs = ws;
				ws.on("message", (data) => ws.send(data));
			});
		});

		upstreamPort = await new Promise<number>((resolve) => {
			upstream.listen(0, "127.0.0.1", () => {
				const address = upstream.address();
				resolve(typeof address === "object" && address ? address.port : 0);
			});
		});

		proxy = await startProxy(`https://127.0.0.1:${upstreamPort}`);
	});

	afterAll(async () => {
		await Promise.all(extraProxies.splice(0).map((handle) => handle.stop()));
		upstreamWss.close();
		upstream.closeAllConnections();
		await new Promise<void>((resolve) => upstream.close(() => resolve()));
		await rm(tempDir, { recursive: true, force: true });
	});

	it("forwards method, path+query, JSON body, and response status/body", async () => {
		const res = await rawRequest({
			port: proxy.port,
			method: "POST",
			path: "/api/v1/sessions?limit=2",
			headers: { "content-type": "application/json" },
			body: '{"name":"demo"}',
		});
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body)).toEqual({
			ok: true,
			method: "POST",
			url: "/api/v1/sessions?limit=2",
			body: '{"name":"demo"}',
		});
		const request = seen.at(-1)!;
		expect(request.method).toBe("POST");
		expect(request.url).toBe("/api/v1/sessions?limit=2");
		expect(request.body).toBe('{"name":"demo"}');
	});

	it("injects Authorization: Bearer and overwrites any caller-supplied value", async () => {
		await rawRequest({
			port: proxy.port,
			path: "/api/v1/sessions",
			headers: { authorization: "Bearer caller-supplied-token" },
		});
		expect(seen.at(-1)!.headers.authorization).toBe(`Bearer ${PASSWORD}`);
	});

	it("preserves the caller's Origin header verbatim", async () => {
		await rawRequest({
			port: proxy.port,
			path: "/api/v1/sessions",
			headers: { origin: "http://localhost:5173" },
		});
		expect(seen.at(-1)!.headers.origin).toBe("http://localhost:5173");
	});

	it("does not forward hop-by-hop headers", async () => {
		// Node's http.request refuses to send a bare `Trailer` header without a
		// chunked body ("Trailers are invalid with this transfer encoding"), so
		// that one member of the hop-by-hop set can't be exercised from here —
		// the proxy strips it by the same name list as the rest.
		await rawRequest({
			port: proxy.port,
			path: "/api/v1/sessions",
			headers: {
				connection: "x-caller-hop-token",
				"keep-alive": "timeout=5",
				"proxy-authenticate": "Basic realm=x",
				"proxy-authorization": "Basic abc",
				te: "trailers",
				upgrade: "websocket",
			},
		});
		const headers = seen.at(-1)!.headers;
		for (const name of [
			"keep-alive",
			"proxy-authenticate",
			"proxy-authorization",
			"te",
			"upgrade",
		]) {
			expect(headers[name]).toBeUndefined();
		}
		// connection may legitimately be re-added by node's upstream client
		// (keep-alive by default) — the caller's value must never pass through.
		expect(headers.connection).not.toBe("x-caller-hop-token");
	});

	it("streams SSE chunks as they arrive (no response buffering)", async () => {
		sseUpstreamEnded = false;
		const { firstChunkBeforeUpstreamEnd, body } = await new Promise<{
			firstChunkBeforeUpstreamEnd: boolean;
			body: string;
		}>((resolve, reject) => {
			const req = http.get({ host: "127.0.0.1", port: proxy.port, path: "/api/v1/events" }, (res) => {
				const chunks: Buffer[] = [];
				let firstChunkBeforeUpstreamEnd = false;
				res.on("data", (chunk) => {
					if (chunks.length === 0) firstChunkBeforeUpstreamEnd = !sseUpstreamEnded;
					chunks.push(chunk);
				});
				res.on("end", () =>
					resolve({ firstChunkBeforeUpstreamEnd, body: Buffer.concat(chunks).toString("utf8") }),
				);
			});
			req.on("error", reject);
		});
		expect(firstChunkBeforeUpstreamEnd).toBe(true);
		expect(body).toBe("data: one\n\ndata: two\n\n");
	});

	it("passes a 3xx redirect through untouched with Location intact", async () => {
		const res = await rawRequest({ port: proxy.port, path: "/redirect" });
		expect(res.status).toBe(302);
		expect(res.headers.location).toBe("https://example.invalid/takeover");
	});

	it("passes a 401 from the upstream through", async () => {
		const res = await rawRequest({ port: proxy.port, path: "/unauthorized" });
		expect(res.status).toBe(401);
		expect(JSON.parse(res.body)).toEqual({ message: "unauthorized" });
	});

	it("returns 502 JSON when the upstream is unreachable", async () => {
		const closedPort = await reserveClosedPort();
		const deadProxy = await startProxy(`https://127.0.0.1:${closedPort}`);
		const res = await rawRequest({ port: deadProxy.port, path: "/api/v1/sessions" });
		expect(res.status).toBe(502);
		expect(JSON.parse(res.body)).toEqual({ message: "remote daemon unreachable" });
	});

	it("bridges /mux websockets with auth + origin and closes both sides together", async () => {
		const origin = "http://localhost:5173";
		const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/mux`, { headers: { origin } });
		await once(ws, "open");

		ws.send("hello-mux");
		const [data] = await once(ws, "message");
		expect(String(data)).toBe("hello-mux");

		expect(lastUpgradeHeaders?.authorization).toBe(`Bearer ${PASSWORD}`);
		expect(lastUpgradeHeaders?.origin).toBe(origin);

		expect(lastUpstreamWs).toBeDefined();
		const upstreamClosed = once(lastUpstreamWs!, "close");
		ws.close();
		await upstreamClosed;
	});

	it("stop() is idempotent and after stop the listener refuses connections", async () => {
		const handle = await startProxy(`https://127.0.0.1:${upstreamPort}`);
		await handle.stop();
		await expect(handle.stop()).resolves.toBeUndefined();
		await expect(rawRequest({ port: handle.port, path: "/api/v1/sessions" })).rejects.toThrow();
	});
});
