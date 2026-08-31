import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_CONFIG, type ServerConfig } from "../config";
import type { HostMetadata } from "../hosts";

/**
 * Where the event cursor is stored, and where a fresh client should start.
 *
 * Both exist because replaying the change log is expensive: measured against a
 * real daemon, a cursor of zero delivers 14,338 events and 3 MB, which takes
 * roughly twenty seconds to parse on device. During that time a reply the agent
 * produced in two seconds sits at the end of the queue, unrendered.
 */

/**
 * Asks the daemon for the current head.
 *
 * The stream clamps any cursor beyond head back to head and reports the
 * resolved value in X-AO-Event-After, so this is the supported way to say
 * "only live events" without a separate round trip.
 */
export const HEAD_CURSOR = Number.MAX_SAFE_INTEGER;

/**
 * Storage key for a machine's event cursor.
 *
 * Keyed on the machine's identity, not the address it happened to answer on.
 * The same daemon is reachable over LAN, Tailscale and the tunnel, and keying
 * by address gave each of those its own cursor — so every network change
 * started from zero and replayed the entire backlog.
 *
 * A pairing migrated from the single-server config has no identity until it
 * connects once, so it falls back to the address.
 */
export function eventCursorKey(cfg: ServerConfig): string {
	if (cfg.hostId) return `ao.chat.events.host.${cfg.hostId}`;
	return `ao.chat.events.${cfg.secure ? "https" : "http"}.${cfg.host}.${cfg.httpPort}`;
}

/** Remove every replay key a machine may have used. Identified hosts converge
 * on one host key; migrated hosts use one address key per stored endpoint. */
export async function clearEventCursorsForHost(host: HostMetadata): Promise<void> {
	const keys = new Set<string>();
	if (host.id) {
		keys.add(eventCursorKey({ ...DEFAULT_CONFIG, hostId: host.id }));
	}
	for (const endpoint of host.endpoints) {
		keys.add(
			eventCursorKey({
				...DEFAULT_CONFIG,
				host: endpoint.host,
				httpPort: String(endpoint.port),
				secure: endpoint.secure,
				...(host.id ? { hostId: host.id } : {}),
			}),
		);
	}
	await Promise.all([...keys].map((key) => AsyncStorage.removeItem(key)));
}

/**
 * The cursor to open the stream with, given whatever was stored.
 *
 * Anything missing or unusable starts at head rather than zero. A first
 * connection has no reason to replay history — chat content is fetched over
 * REST, and the stream exists for live updates — and zero is precisely the
 * value the old address-keyed cursor produced on every network change.
 */
export function initialCursorFor(stored: string | null): number {
	if (stored === null) return HEAD_CURSOR;
	const parsed = Number(stored);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) return HEAD_CURSOR;
	return parsed;
}
