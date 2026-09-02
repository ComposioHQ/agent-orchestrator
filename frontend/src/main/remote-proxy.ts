import { createServer, request as httpRequest, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, type AddressInfo, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { RemoteEntry } from "./remotes-store";

// Loopback proxy fronting one remote AO daemon. It exists because the renderer
// cannot authenticate to a remote daemon itself: EventSource and WebSocket
// cannot set an Authorization header, and app://renderer has no CORS standing
// there. The proxy holds the credential in main-process memory, injects it on
// every forwarded request, and answers CORS for the renderer origin locally.
//
// Loopback is ambient authority everywhere in AO, but this socket fronts a
// DIFFERENT machine — so every request must carry a 128-bit token in the URL
// path (the one place EventSource and WebSocket can both put it). The token is
// stripped before forwarding: the remote daemon and its logs never see it.
export type ActiveProxy = {
	base: string;
	url: string;
	close: () => Promise<void>;
};

const RENDERER_ORIGIN = "app://renderer";
// Hop-by-hop or wrong-machine headers that must not transit the proxy.
const STRIP_REQUEST_HEADERS = [
	"host",
	"origin",
	"connection",
	"keep-alive",
	"transfer-encoding",
	"upgrade",
	"proxy-authorization",
];

const CORS_HEADERS: Record<string, string> = {
	"access-control-allow-origin": RENDERER_ORIGIN,
	"access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
	vary: "origin",
};

// Nothing in this file may log a secret. Not the connection password, not the
// proxy token, and not `req.url` (its first segment IS the token) — only the
// post-strip path, and the upstream address, which is a machine on the user's
// own network named in their own console. That is the whole point: "the app
// can't reach my host" had no answer anywhere before this.
function log(message: string): void {
	console.log(`[remote-proxy] ${message}`);
}

function warn(message: string): void {
	console.warn(`[remote-proxy] ${message}`);
}

function equalsToken(candidate: string, token: string): boolean {
	// Constant-time: the token is the only thing standing between a local
	// process and another machine's daemon, so don't leak it a byte at a time.
	const a = Buffer.from(candidate);
	const b = Buffer.from(token);
	return a.length === b.length && timingSafeEqual(a, b);
}

export async function startRemoteProxy(entry: RemoteEntry): Promise<ActiveProxy> {
	const token = randomBytes(16).toString("hex");
	const upstream = new URL(entry.url);
	const secure = upstream.protocol === "https:";
	const upstreamPort = Number(upstream.port || (secure ? 443 : 80));
	// An https host must be spoken to over TLS. Forwarding it as cleartext puts
	// the connection password on the wire in the clear — and the address bar
	// already accepts https:// (AddRemoteHostDialog), so this is reachable by
	// typing a Tailscale Serve or reverse-proxy URL.
	const upstreamRequest = secure ? httpsRequest : httpRequest;
	const dialUpstream = (onReady: () => void): Socket =>
		secure
			? tlsConnect(upstreamPort, upstream.hostname, { servername: upstream.hostname }, onReady)
			: netConnect(upstreamPort, upstream.hostname, onReady);
	// A host may be a daemon behind a reverse proxy at a path ("http://box/ao").
	// The renderer's base is the proxy's own root, so the upstream prefix has to
	// be restored here — without it every forwarded request, credential and all,
	// lands on whatever else that vhost serves at /api/v1.
	const prefix = upstream.pathname.replace(/\/+$/, "");
	const server: Server = createServer();
	const tunnels = new Set<() => void>();
	// SSE connections outlive any fixed request timeout.
	server.requestTimeout = 0;

	const stripToken = (rawUrl: string | undefined): string | null => {
		if (!rawUrl || !rawUrl.startsWith("/")) return null;
		const slash = rawUrl.indexOf("/", 1);
		const first = slash === -1 ? rawUrl.slice(1) : rawUrl.slice(1, slash);
		if (!equalsToken(first, token)) return null;
		return prefix + (slash === -1 ? "/" : rawUrl.slice(slash));
	};

	const forwardHeaders = (incoming: NodeJS.Dict<string | string[]>): NodeJS.Dict<string | string[]> => {
		const out: NodeJS.Dict<string | string[]> = {};
		for (const [name, value] of Object.entries(incoming)) {
			if (!STRIP_REQUEST_HEADERS.includes(name.toLowerCase())) out[name] = value;
		}
		out.host = upstream.host;
		out.authorization = `Bearer ${entry.password}`;
		return out;
	};

	server.on("request", (req, res) => {
		if (req.method === "OPTIONS") {
			res.writeHead(204, {
				...CORS_HEADERS,
				"access-control-allow-headers": String(req.headers["access-control-request-headers"] ?? "content-type"),
				"access-control-max-age": "600",
			});
			res.end();
			return;
		}
		const path = stripToken(req.url);
		if (path === null) {
			res.writeHead(404, {
				"content-type": "application/json",
				...CORS_HEADERS,
			});
			res.end('{"error":"unknown path"}');
			return;
		}
		const proxied = upstreamRequest(
			{
				host: upstream.hostname,
				port: upstreamPort,
				method: req.method,
				path,
				headers: forwardHeaders(req.headers),
			},
			(upstreamRes) => {
				const headers: NodeJS.Dict<string | string[] | number> = {
					...upstreamRes.headers,
					...CORS_HEADERS,
				};
				delete headers.connection;
				delete headers["keep-alive"];
				res.writeHead(upstreamRes.statusCode ?? 502, headers);
				// Node holds the header block until the first body byte or an explicit
				// flush. An SSE upstream (GET /api/v1/events) can go arbitrarily long
				// before its first byte, so without this the client's EventSource sits
				// in CONNECTING forever — flush headers on their own, then pipe.
				res.flushHeaders();
				// pipe streams SSE chunk-by-chunk once headers are already on the wire.
				upstreamRes.pipe(res);
			},
		);
		proxied.setTimeout(0);
		proxied.on("error", (error: Error) => {
			warn(`upstream ${upstream.host} failed on ${req.method} ${path} (${error.message}); answering 502`);
			if (!res.headersSent)
				res.writeHead(502, {
					"content-type": "application/json",
					...CORS_HEADERS,
				});
			res.end('{"error":"remote daemon unreachable"}');
		});
		req.pipe(proxied);
	});

	server.on("upgrade", (req, socket: Socket, head: Buffer) => {
		const path = stripToken(req.url);
		if (path === null) {
			socket.destroy();
			return;
		}
		const upstreamSocket = dialUpstream(() => {
			const headers = forwardHeaders(req.headers);
			const lines = [`${req.method} ${path} HTTP/1.1`];
			// The WebSocket-specific headers were stripped as hop-by-hop; restore
			// the two the handshake requires, with the credential injected above.
			headers.connection = "Upgrade";
			headers.upgrade = String(req.headers.upgrade ?? "websocket");
			for (const [name, value] of Object.entries(headers)) {
				for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
			}
			upstreamSocket.write(lines.join("\r\n") + "\r\n\r\n");
			if (head.length > 0) upstreamSocket.write(head);
			socket.pipe(upstreamSocket);
			upstreamSocket.pipe(socket);
		});
		upstreamSocket.on("error", (error: Error) => {
			warn(`upstream ${upstream.host} tunnel failed on ${path} (${error.message})`);
		});
		const drop = () => {
			tunnels.delete(drop);
			socket.destroy();
			upstreamSocket.destroy();
		};
		tunnels.add(drop);
		// http.Server keeps upgraded sockets half-open (allowHalfOpen), so a peer
		// that only sends FIN never triggers "close" — tear the pair down on
		// "end" too or every closed terminal leaks a socket to the remote host.
		for (const event of ["error", "end", "close"] as const) {
			upstreamSocket.on(event, drop);
			socket.on(event, drop);
		}
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	log(`started on 127.0.0.1:${port} for ${upstream.host}`);
	return {
		base: `http://127.0.0.1:${port}/${token}`,
		url: entry.url,
		close: () =>
			new Promise((resolve) => {
				// close() alone waits on keep-alive and tunnelled sockets forever;
				// a deactivated proxy must actually stop serving.
				for (const drop of tunnels) drop();
				server.closeAllConnections();
				server.close(() => {
					log(`stopped on 127.0.0.1:${port} for ${upstream.host}`);
					resolve();
				});
			}),
	};
}
