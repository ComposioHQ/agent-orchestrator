import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import type { Endpoint } from "./endpoints";

/**
 * A paired machine.
 *
 * Endpoints are a list because the phone races them, and they are refreshed on
 * every successful connect — that is what lets a rotated tunnel hostname or a
 * new LAN address heal itself without the user re-pairing.
 */
export type Host = {
	/** Stable, daemon-issued. Every probe answer is checked against this before
	 * the endpoint is trusted or the token is presented. */
	id: string;
	/** Hostname by default; the user can rename it. */
	name: string;
	platform: string;
	endpoints: Endpoint[];
	/** Connection token. Lives in the device keystore, never in AsyncStorage. */
	token: string;
	lastConnected: number;
};

/** Enough for a developer's machines without letting stale pairings pile up. */
export const MAX_HOSTS = 10;

const HOSTS_KEY = "ao.hosts";
const tokenKey = (id: string) => `ao.hostToken.${id}`;

/** What is written to AsyncStorage: everything except the token. */
type StoredHost = Omit<Host, "token">;

function isStoredHost(v: unknown): v is StoredHost {
	if (typeof v !== "object" || v === null) return false;
	const h = v as Record<string, unknown>;
	// An empty id is valid: a machine migrated from the single-server config has
	// not been issued one yet and adopts it on first connect.
	return typeof h.id === "string" && Array.isArray(h.endpoints);
}

async function readStored(): Promise<StoredHost[]> {
	try {
		const raw = await AsyncStorage.getItem(HOSTS_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isStoredHost);
	} catch {
		// Corrupted storage must not brick the app; the user re-pairs instead.
		return [];
	}
}

function sortAndCap(hosts: StoredHost[]): StoredHost[] {
	return [...hosts].sort((a, b) => b.lastConnected - a.lastConnected).slice(0, MAX_HOSTS);
}

async function writeStored(hosts: StoredHost[]): Promise<void> {
	await AsyncStorage.setItem(HOSTS_KEY, JSON.stringify(sortAndCap(hosts)));
}

/** Every paired machine, most recently connected first. */
export async function loadHosts(): Promise<Host[]> {
	const stored = sortAndCap(await readStored());
	return Promise.all(
		stored.map(async (h) => ({
			...h,
			token: (await SecureStore.getItemAsync(tokenKey(h.id))) ?? "",
		})),
	);
}

/** One machine by id, or null. */
export async function findHost(id: string): Promise<Host | null> {
	return (await loadHosts()).find((h) => h.id === id) ?? null;
}

/** Adds or replaces a machine. Re-pairing the same machine updates it in place
 * rather than adding a second entry for it. */
export async function saveHost(host: Host): Promise<void> {
	const { token, ...rest } = host;
	const others = (await readStored()).filter((h) => h.id !== host.id);
	await writeStored([rest, ...others]);
	if (token) {
		await SecureStore.setItemAsync(tokenKey(host.id), token);
	} else {
		await SecureStore.deleteItemAsync(tokenKey(host.id));
	}
}

/**
 * Replaces a machine's endpoint list, leaving its token alone.
 *
 * Called after every successful connect with whatever the daemon now
 * advertises, so a rotated tunnel hostname or a changed LAN address is picked
 * up without the user doing anything.
 */
export async function updateHostEndpoints(id: string, endpoints: Endpoint[]): Promise<void> {
	const stored = await readStored();
	const next = stored.map((h) => (h.id === id ? { ...h, endpoints } : h));
	await writeStored(next);
}

/** Records a successful connection, so the list orders by recency. */
export async function touchHost(id: string, at: number = Date.now()): Promise<void> {
	const stored = await readStored();
	await writeStored(stored.map((h) => (h.id === id ? { ...h, lastConnected: at } : h)));
}

/**
 * Forgets a machine.
 *
 * Both tiers are cleared: wiping only the AsyncStorage entry would leave the
 * token in the keystore, and a later re-pair of the same machine would silently
 * resurrect it.
 */
export async function removeHost(id: string): Promise<void> {
	const stored = await readStored();
	await writeStored(stored.filter((h) => h.id !== id));
	await SecureStore.deleteItemAsync(tokenKey(id));
}

const LEGACY_CONFIG_KEY = "ao.serverConfig";
const LEGACY_PASSWORD_KEY = "ao.serverPassword";

/**
 * Brings a pre-existing pairing forward into the host list.
 *
 * Every current user has exactly one machine stored the old way — a single
 * address, port, TLS flag and password. Skipping this would silently unpair all
 * of them on upgrade.
 *
 * The old config carries no host id, because the daemon only started issuing
 * them alongside the endpoint race. A migrated machine therefore starts with an
 * empty id and adopts one on its first successful connect. Until then its
 * identity cannot be verified — which is exactly how the app behaved before
 * this change, so nothing regresses, and it self-corrects after one connect.
 *
 * Idempotent, and it never runs over an existing list.
 */
export async function migrateLegacyConfig(): Promise<void> {
	if ((await readStored()).length > 0) return;

	let legacy: Record<string, unknown>;
	try {
		const raw = await AsyncStorage.getItem(LEGACY_CONFIG_KEY);
		if (!raw) return;
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return;
		legacy = parsed as Record<string, unknown>;
	} catch {
		return;
	}

	const host = typeof legacy.host === "string" ? legacy.host.trim() : "";
	if (!host) return;

	const port = Number(legacy.httpPort) || 3011;
	const isSecure = legacy.secure === true;
	// A Tailscale pairing is the only way the old flow produced a TLS endpoint,
	// so secure implies the tailnet path; everything else was plain LAN.
	const kind = isSecure ? "tailscale" : "lan";

	await saveHost({
		id: "",
		name: host,
		platform: "",
		endpoints: [{ kind, host, port, secure: isSecure }],
		token: (await SecureStore.getItemAsync(LEGACY_PASSWORD_KEY)) ?? "",
		lastConnected: Date.now(),
	});
}
