import { describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
	default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));
vi.mock("expo-secure-store", () => ({
	getItemAsync: vi.fn(), setItemAsync: vi.fn(), deleteItemAsync: vi.fn(),
}));

import { DEFAULT_CONFIG, type ServerConfig } from "./config";
import { sameServerConfig } from "./sameConfig";

const cfg = (over: Partial<ServerConfig> = {}): ServerConfig => ({
	...DEFAULT_CONFIG, host: "192.168.1.42", httpPort: "3011", secure: false, password: "pw", ...over,
});

describe("sameServerConfig", () => {
	// Resolution builds a fresh object every time. Effects across the app key
	// on the config's identity — the live conversation stream, the poll loop —
	// so handing them a new object for an unchanged endpoint tears the stream
	// down and rebuilds it, leaving the UI to update only on the 8s poll.
	it("treats an identical endpoint as unchanged", () => {
		expect(sameServerConfig(cfg(), cfg())).toBe(true);
	});

	it.each([
		["host", { host: "10.0.0.5" }],
		["port", { httpPort: "443" }],
		["tls", { secure: true }],
		["password", { password: "rotated" }],
	])("treats a changed %s as different", (_name, over) => {
		expect(sameServerConfig(cfg(), cfg(over))).toBe(false);
	});

	it("handles a missing previous config", () => {
		expect(sameServerConfig(null, cfg())).toBe(false);
	});
});
