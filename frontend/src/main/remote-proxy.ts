import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type ClientOptions, type RawData } from "ws";

// Loopback forwarding proxy for remote daemon mode. The renderer talks to this
// plaintext HTTP server on 127.0.0.1; every request is forwarded to a remote AO
// daemon over HTTPS (Tailscale) with the bearer password injected here, so the
// password never reaches the renderer and never crosses an origin boundary.
//
// Security invariants:
// - TLS uses Node's DEFAULT certificate validation. No rejectUnauthorized hacks
//   anywhere in production code (the test-only seams below exist precisely so
//   tests can trust a self-signed upstream without touching production TLS).
// - Redirects are never followed; a 3xx passes through untouched, which
//   structurally prevents credentials from leaking to another origin.
// - The password is never logged, and URLs never carry credentials.
// - The listener binds 127.0.0.1 only.

const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

const UNREACHABLE_BODY = '{"message":"remote daemon unreachable"}';

export type RemoteProxyLogger = {
	info(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
};

/**
 * TEST-ONLY SEAM: production always uses node:https with default TLS
 * validation. Tests inject a wrapper that adds `rejectUnauthorized: false` so
 * the in-process self-signed upstream is trusted.
 */
export type HttpsTransport = (
	options: https.RequestOptions,
	callback: (res: http.IncomingMessage) => void,
) => http.ClientRequest;

/**
 * TEST-ONLY SEAM: production always constructs the upstream WebSocket with
 * default TLS validation. Tests inject a wrapper that adds
 * `rejectUnauthorized: false` for the self-signed upstream.
 */
export type WebSocketFactory = (url: string, options: ClientOptions) => WebSocket;

export type RemoteProxyDeps = {
	/** Validated https origin of the remote daemon, no trailing slash. */
	remoteUrl: string;
	password: string;
	logger?: RemoteProxyLogger;
	/** Test-only; defaults to https.request with default TLS validation. */
	transport?: HttpsTransport;
	/** Test-only; defaults to `new WebSocket(url, options)` from ws. */
	webSocketFactory?: WebSocketFactory;
};

export type RemoteProxyHandle = {
	readonly port: number;
	stop(): Promise<void>;
};

const NOOP_LOGGER: RemoteProxyLogger = {
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};

const defaultTransport: HttpsTransport = (options, callback) => https.request(options, callback);

const defaultWebSocketFactory: WebSocketFactory = (url, options) => new WebSocket(url, options);

function forwardableHeaders(headers: http.IncomingHttpHeaders): Record<string, string | string[]> {
	const out: Record<string, string | string[]> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		const lower = name.toLowerCase();
		// host is rebuilt by node for the upstream origin; forwarding the
		// caller's (loopback) Host would break the remote daemon.
		if (HOP_BY_HOP_HEADERS.has(lower) || lower === "host") continue;
		out[name] = value;
	}
	return out;
}

export async function startRemoteProxy(deps: RemoteProxyDeps): Promise<RemoteProxyHandle> {
	const log = deps.logger ?? NOOP_LOGGER;
	const transport = deps.transport ?? defaultTransport;
	const wsFactory = deps.webSocketFactory ?? defaultWebSocketFactory;
	const remote = new URL(deps.remoteUrl);

	// Live connection tracking so stop() can tear everything down. HTTP
	// keep-alive sockets are tracked from "connection"; WS endpoints (both the
	// caller-facing server side and the upstream client side) are tracked while
	// open.
	const liveSockets = new Set<Duplex>();
	const liveWebSockets = new Set<WebSocket>();

	function trackSocket(socket: Duplex): void {
		liveSockets.add(socket);
		socket.once("close", () => liveSockets.delete(socket));
	}

	function trackWebSocket(ws: WebSocket): void {
		liveWebSockets.add(ws);
		ws.once("close", () => liveWebSockets.delete(ws));
	}

	function handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		const headers = forwardableHeaders(req.headers);
		// The password is authoritative here; a caller-supplied Authorization is
		// always overwritten. Origin is not hop-by-hop, so it passes through
		// verbatim via forwardableHeaders.
		headers["authorization"] = `Bearer ${deps.password}`;

		const upstreamReq = transport(
			{
				protocol: remote.protocol,
				hostname: remote.hostname,
				port: remote.port ? Number(remote.port) : 443,
				method: req.method,
				path: req.url ?? "/",
				headers,
			},
			(upstreamRes) => {
				// Never follow redirects: a 3xx (and any other status) streams back
				// untouched. Hop-by-hop response headers are stripped; node re-frames
				// the body as it pipes.
				res.writeHead(upstreamRes.statusCode ?? 502, forwardableHeaders(upstreamRes.headers));
				upstreamRes.on("error", () => res.destroy());
				upstreamRes.pipe(res);
			},
		);

		upstreamReq.on("error", (err) => {
			log.warn(`remote-proxy: upstream request failed: ${err.message}`);
			if (res.destroyed || res.headersSent) {
				// Mid-stream failure (or the caller is gone): no clean status to
				// send, drop the connection.
				res.destroy();
				return;
			}
			res.writeHead(502, { "content-type": "application/json" });
			res.end(UNREACHABLE_BODY);
		});

		req.on("aborted", () => upstreamReq.destroy());
		req.pipe(upstreamReq);
	}

	const server = http.createServer(handleHttpRequest);
	const wss = new WebSocketServer({ noServer: true });

	function bridgeWebSockets(serverSide: WebSocket, upstream: WebSocket): void {
		trackWebSocket(serverSide);
		serverSide.on("message", (data: RawData, isBinary: boolean) => {
			if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
		});
		upstream.on("message", (data: RawData, isBinary: boolean) => {
			if (serverSide.readyState === WebSocket.OPEN) serverSide.send(data, { binary: isBinary });
		});
		// When either side closes or errors, close the other.
		serverSide.on("close", () => upstream.close());
		upstream.on("close", () => serverSide.close());
		serverSide.on("error", () => upstream.close());
		upstream.on("error", () => serverSide.close());
	}

	server.on("connection", trackSocket);

	server.on("upgrade", (req, socket, head) => {
		trackSocket(socket);
		let pathname: string;
		try {
			pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
		} catch {
			socket.destroy();
			return;
		}
		if (pathname !== "/mux") {
			socket.destroy();
			return;
		}

		const wsUrl = new URL(req.url ?? "/", remote);
		wsUrl.protocol = remote.protocol === "https:" ? "wss:" : "ws:";

		const headers: Record<string, string> = { authorization: `Bearer ${deps.password}` };
		if (typeof req.headers.origin === "string") headers.origin = req.headers.origin;

		const upstream = wsFactory(wsUrl.toString(), { headers });
		trackWebSocket(upstream);

		upstream.once("open", () => {
			// Complete the caller-facing upgrade only once the upstream socket is
			// open, so no caller message can arrive before forwarding is wired.
			wss.handleUpgrade(req, socket, head, (serverSide) => {
				bridgeWebSockets(serverSide, upstream);
			});
		});
		upstream.once("error", (err) => {
			log.warn(`remote-proxy: upstream websocket failed: ${err.message}`);
			// If the upstream socket errors before open there is no bridged
			// WebSocket yet; destroy the raw caller socket.
			socket.destroy();
		});
		upstream.once("unexpected-response", () => {
			socket.destroy();
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Unable to determine remote proxy address");
	}
	const port = address.port;
	log.info(`remote-proxy: forwarding 127.0.0.1:${port} to remote daemon`);

	let stopPromise: Promise<void> | null = null;
	function stop(): Promise<void> {
		if (stopPromise) return stopPromise;
		stopPromise = (async () => {
			for (const ws of liveWebSockets) ws.terminate();
			for (const socket of liveSockets) socket.destroy();
			await new Promise<void>((resolve) => wss.close(() => resolve()));
			await new Promise<void>((resolve) => server.close(() => resolve()));
		})();
		return stopPromise;
	}

	return { port, stop };
}
