import { describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
	default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));
vi.mock("expo-secure-store", () => ({
	getItemAsync: vi.fn(), setItemAsync: vi.fn(), deleteItemAsync: vi.fn(),
}));

import { DEFAULT_CONFIG, type ServerConfig } from "./config";
import type { Endpoint } from "./endpoints";
import type { Host } from "./hosts";
import { resolveActiveConfig } from "./resolveConfig";

const lan: Endpoint = { kind: "lan", host: "192.168.1.42", port: 3011, secure: false };
const tunnel: Endpoint = { kind: "tunnel", host: "abc.trycloudflare.com", port: 443, secure: true };

const host = (over: Partial<Host> = {}): Host => ({
	id: "h_a", name: "mbp", platform: "darwin",
	endpoints: [lan, tunnel], token: "pw", lastConnected: 2, ...over,
});

const legacy: ServerConfig = { ...DEFAULT_CONFIG, host: "10.0.0.9", httpPort: "3011", password: "old" };

const deps = (over: Record<string, unknown> = {}) => ({
	migrate: vi.fn(async () => {}),
	loadHosts: vi.fn(async () => [host()]),
	connect: vi.fn(async (id: string) => ({
		ok: true as const,
		config: { ...DEFAULT_CONFIG, host: "192.168.1.42", httpPort: "3011", password: "pw" },
		endpoint: lan,
		hostId: id,
	})),
	loadLegacyConfig: vi.fn(async () => legacy),
	...over,
});

describe("resolveActiveConfig", () => {
	it("connects to the most recently used machine", async () => {
		const d = deps({ loadHosts: vi.fn(async () => [host({ id: "h_new", lastConnected: 9 }), host({ id: "h_old", lastConnected: 1 })]) });
		const got = await resolveActiveConfig(d);

		expect(d.connect).toHaveBeenCalledWith("h_new");
		expect(got?.host).toBe("192.168.1.42");
	});

	// Migration runs first, so a user upgrading from the single-server config
	// has their machine in the list before we look for one.
	it("migrates an old pairing before looking for machines", async () => {
		const order: string[] = [];
		const d = deps({
			migrate: vi.fn(async () => void order.push("migrate")),
			loadHosts: vi.fn(async () => {
				order.push("load");
				return [host()];
			}),
		});
		await resolveActiveConfig(d);

		expect(order).toEqual(["migrate", "load"]);
	});

	// The safety net. If the race cannot reach the machine we must still hand
	// back the last known config: the rest of the app is built around always
	// having one, and returning nothing would look like being unpaired.
	it("falls back to the stored config when nothing answers", async () => {
		const d = deps({ connect: vi.fn(async () => ({ ok: false as const, reason: "none-reachable" as const })) });
		const got = await resolveActiveConfig(d);

		expect(got?.host).toBe("10.0.0.9");
	});

	it("falls back to the stored config when no machine is paired", async () => {
		const d = deps({ loadHosts: vi.fn(async () => []) });
		const got = await resolveActiveConfig(d);

		expect(d.connect).not.toHaveBeenCalled();
		expect(got?.host).toBe("10.0.0.9");
	});

	// A crash here would leave the app with no connection at all, so a thrown
	// error degrades to the stored config rather than propagating.
	it("degrades to the stored config if resolution throws", async () => {
		const d = deps({
			connect: vi.fn(async () => {
				throw new Error("boom");
			}),
		});
		const got = await resolveActiveConfig(d);

		expect(got?.host).toBe("10.0.0.9");
	});
});
