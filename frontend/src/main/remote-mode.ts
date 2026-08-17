// Remote-daemon probing for the desktop's remote mode. Pure and dependency-
// injected (fetch is a parameter) so the classification matrix is unit-testable
// without a network; main.ts owns the proxy lifecycle and status wiring.
//
// The probe talks to the remote daemon's authenticated LAN listener directly
// (Tailscale HTTPS), BEFORE the loopback proxy is considered usable: a remote
// that rejects the password or fails TLS must never surface as a working
// connection. Classification maps onto DaemonFailureCode so the renderer's
// existing failure banner can render each case.

import { DAEMON_SERVICE_NAME } from "../shared/daemon-attach";
import type { DaemonFailureCode } from "../shared/daemon-status";
import { SUPPORTED_DAEMON_API_VERSION } from "../shared/remote-url";

export type RemoteProbeOutcome = { ok: true } | { ok: false; code: DaemonFailureCode; message: string };

export type RemoteFetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
	status: number;
	json(): Promise<unknown>;
}>;

const REMOTE_PROBE_TIMEOUT_MS = 8_000;

function failure(code: DaemonFailureCode, message: string): RemoteProbeOutcome {
	return { ok: false, code, message };
}

// Node's fetch (undici) surfaces network/TLS failures as TypeError("fetch
// failed") with the underlying error on .cause carrying a .code. TLS codes are
// the family a user can act on differently (fix Tailscale certs) than a plain
// "host is down", so they get their own class.
function classifyFetchError(err: unknown): RemoteProbeOutcome {
	const cause = (err as { cause?: { code?: string } } | null)?.cause;
	const code = cause?.code ?? (err as { code?: string } | null)?.code ?? "";
	if (
		code.includes("CERT") ||
		code.startsWith("UNABLE_TO") ||
		code.startsWith("DEPTH_") ||
		code.startsWith("ERR_TLS") ||
		code.includes("SSL")
	) {
		return failure(
			"remote_tls",
			"The remote daemon's TLS certificate could not be verified. Check Tailscale HTTPS certificates on the remote host.",
		);
	}
	return failure(
		"remote_unreachable",
		"The remote daemon is unreachable. Check that the host is up and Tailscale is connected on both machines.",
	);
}

async function probeEndpoint(
	fetchImpl: RemoteFetch,
	baseUrl: string,
	password: string,
	endpoint: "healthz" | "readyz",
): Promise<{ outcome: RemoteProbeOutcome; body?: Record<string, unknown> }> {
	let res: { status: number; json(): Promise<unknown> };
	try {
		res = await fetchImpl(`${baseUrl}/${endpoint}`, {
			headers: { Authorization: `Bearer ${password}` },
			signal: AbortSignal.timeout(REMOTE_PROBE_TIMEOUT_MS),
		});
	} catch (err) {
		return { outcome: classifyFetchError(err) };
	}
	if (res.status === 401 || res.status === 403) {
		return { outcome: failure("remote_unauthorized", "The remote daemon rejected the connection password.") };
	}
	if (res.status === 502 || res.status === 503 || res.status === 504) {
		return {
			outcome: failure("not_ready", "The remote host is up, but the AO daemon behind it is not responding yet."),
		};
	}
	if (res.status < 200 || res.status >= 300) {
		return { outcome: failure("remote_unreachable", `The remote host answered with HTTP ${res.status}.`) };
	}
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		return { outcome: failure("remote_unreachable", "The remote host did not return a valid daemon response.") };
	}
	if (typeof body !== "object" || body === null) {
		return { outcome: failure("remote_unreachable", "The remote host did not return a valid daemon response.") };
	}
	return { outcome: { ok: true }, body: body as Record<string, unknown> };
}

/**
 * Verify that baseUrl is a healthy, compatible AO daemon accepting this
 * password. Checks /healthz (identity + API compatibility) and /readyz
 * (readiness). Never throws: every failure is a classified outcome.
 */
export async function probeRemoteDaemon(
	baseUrl: string,
	password: string,
	fetchImpl: RemoteFetch,
): Promise<RemoteProbeOutcome> {
	const health = await probeEndpoint(fetchImpl, baseUrl, password, "healthz");
	if (!health.outcome.ok) return health.outcome;
	if (health.body?.service !== DAEMON_SERVICE_NAME) {
		return failure("remote_unreachable", "The remote host is not an AO daemon.");
	}
	const apiVersion = health.body?.apiVersion;
	if (typeof apiVersion !== "number" || !Number.isInteger(apiVersion)) {
		return failure(
			"remote_incompatible_api",
			"The remote daemon is too old to report its API version. Upgrade AO on the remote host.",
		);
	}
	if (apiVersion > SUPPORTED_DAEMON_API_VERSION) {
		return failure(
			"remote_incompatible_api",
			"The remote daemon runs a newer AO than this app supports. Update this app, or run matching versions.",
		);
	}

	const ready = await probeEndpoint(fetchImpl, baseUrl, password, "readyz");
	if (!ready.outcome.ok) return ready.outcome;
	if (ready.body?.status !== "ready") {
		return failure("not_ready", "The remote daemon is not ready yet.");
	}
	return { ok: true };
}
