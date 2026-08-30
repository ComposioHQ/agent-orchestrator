import type { RemoteHealth } from "../../main/remote-request";
import { LOCAL_HOST, type HostId } from "./hosts";
import { captureRendererEvent } from "./telemetry";

// The remote path shipped with no telemetry at all: a host whose event stream
// died left the board quietly polling, with nothing anywhere able to answer
// "why isn't my remote updating?".
//
// No address, label or connection password ever leaves the machine. A host id
// IS its URL, so it is handed over as `host_id` and reaches PostHog only as a
// SHA-256 digest — sanitizeRendererProperties in telemetry.ts does the hashing
// and drops everything not on its allowlist.

type HostConnectSource = "add" | "edit" | "probe";
type HostStreamState = "connected" | "disconnected";

function hostFields(host: HostId) {
	return { host_id: host, host_kind: host === LOCAL_HOST ? "local" : "remote" };
}

/** Result and latency of a reachability probe: adding, editing, or re-checking a host. */
export function reportHostConnect(
	host: HostId,
	source: HostConnectSource,
	result: RemoteHealth,
	durationMs: number,
): void {
	void captureRendererEvent("ao.renderer.host_connect", {
		...hostFields(host),
		source,
		result,
		duration_ms: Math.round(durationMs),
	});
}

/** A host's live event stream opening or dropping, with how often it has dropped this session. */
export function reportHostStreamState(host: HostId, state: HostStreamState, reconnectCount: number): void {
	void captureRendererEvent("ao.renderer.host_stream_state", {
		...hostFields(host),
		state,
		reconnect_count: reconnectCount,
	});
}

// A host that stays down fails its refetch every 15 seconds forever, and
// captureRendererEvent's per-name daily ceiling is shared: one dead host would
// spend the whole budget and hide the next host to break. Collapse repeats of
// the same (host, status), the same guard api-client already runs over api_error.
const QUERY_FAILED_DEDUPE_MS = 5 * 60_000;
const lastQueryFailureAt = new Map<string, number>();

/** A host's projects/sessions fetch failing — invisible until now, since remote clients bypass api-client. */
export function reportHostQueryFailed(host: HostId, status?: number, now = Date.now()): void {
	const key = `${host}|${status ?? ""}`;
	const last = lastQueryFailureAt.get(key);
	if (last !== undefined && now - last < QUERY_FAILED_DEDUPE_MS) return;
	lastQueryFailureAt.set(key, now);
	void captureRendererEvent("ao.renderer.host_query_failed", { ...hostFields(host), status });
}
