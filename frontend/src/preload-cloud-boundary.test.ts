// The cloud credential boundary, asserted from the renderer's side of preload.
//
// The architecture rule these tests defend: no access token, refresh token, or
// generic authenticated fetch may cross contextBridge. Every cloud HTTP request
// is made by Electron main and reaches the renderer only as a narrow,
// purpose-specific IPC verb. A regression here is a silent privilege leak — the
// renderer runs web content, so anything it can reach, injected script can too.
//
// Both halves matter: the structural walk catches a token smuggled under an
// innocuous name, and the source scan catches a channel that main still handles
// even if the bridge stopped naming it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AoBridge } from "./preload";

const electronMocks = vi.hoisted(() => ({
	exposeInMainWorld: vi.fn(),
	invoke: vi.fn(),
	off: vi.fn(),
	on: vi.fn(),
	send: vi.fn(),
}));

vi.mock("electron", () => ({
	contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
	ipcRenderer: {
		invoke: electronMocks.invoke,
		off: electronMocks.off,
		on: electronMocks.on,
		send: electronMocks.send,
	},
}));

await import("./preload");

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(path.join(here, relative), "utf8");

function exposedBridge(): AoBridge {
	const call = electronMocks.exposeInMainWorld.mock.calls.find(([key]) => key === "ao");
	if (!call) throw new Error("preload bridge was not exposed");
	return call[1] as AoBridge;
}

/** Every dotted key path in the exposed bridge, e.g. "cloud.signIn". */
function bridgeKeyPaths(value: unknown, prefix = ""): string[] {
	if (typeof value !== "object" || value === null) return [];
	return Object.entries(value).flatMap(([key, child]) => {
		const keyPath = prefix ? `${prefix}.${key}` : key;
		return [keyPath, ...bridgeKeyPaths(child, keyPath)];
	});
}

// Deliberately broad. A future "cloud.authorizedFetch" or "cloud.getCredential"
// must fail this test and force a conversation, not slip through review.
const FORBIDDEN_KEY = /(access|refresh|bearer|id)?_?token|credential|secret|authorization|apikey|api_key/i;

describe("preload cloud credential boundary", () => {
	it("exposes no bridge member whose name suggests a credential", () => {
		const offenders = bridgeKeyPaths(exposedBridge()).filter((keyPath) => {
			const leaf = keyPath.split(".").at(-1) ?? "";
			return FORBIDDEN_KEY.test(leaf);
		});
		expect(offenders).toEqual([]);
	});

	it("exposes no generic fetch/request escape hatch on the cloud bridge", () => {
		const cloudKeys = bridgeKeyPaths(exposedBridge().cloud);
		expect(cloudKeys).not.toContain("fetch");
		expect(cloudKeys).not.toContain("request");
		expect(cloudKeys).not.toContain("call");
	});

	it("keeps the cloud bridge to purpose-specific verbs only", () => {
		// Locked list. Adding a verb is fine; adding one that carries a token is
		// not, and updating this list is the moment to notice the difference.
		expect(Object.keys(exposedBridge().cloud).sort()).toEqual([
			"getAvailability",
			"getSession",
			"onSessionChanged",
			"signIn",
			"signOut",
		]);
	});

	it("names no token-bearing IPC channel in the preload source", () => {
		const source = read("preload.ts");
		expect(source).not.toMatch(/cloud:getAccessToken/);
		expect(source).not.toMatch(/getAccessToken/);
	});

	it("registers no token-bearing IPC handler in the main process", () => {
		// The renderer half is only safe while main declines to answer. Assert on
		// the handler registrations rather than the helper, which main still uses
		// internally to authorize its own requests.
		const source = read("main/cloud-auth.ts");
		const handlers = [...source.matchAll(/ipcMain\.handle\(\s*"([^"]+)"/g)].map((match) => match[1]);
		expect(handlers).not.toContain("cloud:getAccessToken");
		for (const channel of handlers) expect(channel).not.toMatch(FORBIDDEN_KEY);
	});
});
