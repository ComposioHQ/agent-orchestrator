import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	decryptString: vi.fn((value: Buffer) => value.toString("utf8")),
	encryptString: vi.fn((value: string) => Buffer.from(value, "utf8")),
	encryptionAvailable: true,
	isPackaged: true,
	selectedStorageBackend: "gnome_libsecret",
	openExternal: vi.fn(),
	showMessageBox: vi.fn(),
	handle: vi.fn(),
}));

vi.mock("electron", () => ({
	app: {
		get isPackaged() {
			return mocks.isPackaged;
		},
	},
	dialog: { showMessageBox: mocks.showMessageBox },
	ipcMain: { handle: mocks.handle },
	safeStorage: {
		decryptString: mocks.decryptString,
		encryptString: mocks.encryptString,
		getSelectedStorageBackend: () => mocks.selectedStorageBackend,
		isEncryptionAvailable: () => mocks.encryptionAvailable,
	},
	shell: { openExternal: mocks.openExternal },
}));

import {
	beginCloudSignIn,
	cloudAvailability,
	getCloudAccessToken,
	getCloudSession,
	setCloudPreferenceEnabled,
	showCloudSignInFailure,
	signOutCloud,
} from "./cloud-auth";

const STORE_FILE = "cloud-auth.bin";
const realFetch = globalThis.fetch;

function aoSession(overrides: Record<string, unknown> = {}) {
	return {
		accessToken: "ao_access_1",
		refreshToken: "ao_refresh_1",
		expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
		user: { id: "user_1", email: "dev@example.com", displayName: "Dev", authProvider: "google" },
		organizations: [{ id: "org_1", slug: "dev", displayName: "Dev", role: "owner" }],
		...overrides,
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Routes Google/control-plane calls to the stub and lets loopback calls through. */
type RouteHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;
let routes: Map<string, RouteHandler>;

function stubFetch(): void {
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url.startsWith("http://127.0.0.1:")) return realFetch(input as RequestInfo, init);
		for (const [prefix, handler] of routes) {
			if (url.startsWith(prefix)) return handler(url, init);
		}
		throw new Error(`unexpected fetch: ${url}`);
	}) as typeof globalThis.fetch;
}

/** Drive the browser half of the loopback PKCE flow from the authorize URL. */
function completeGoogleRedirect(options: { state?: string; error?: string; omitCode?: boolean } = {}): void {
	mocks.openExternal.mockImplementation(async (authorizeUrl: string) => {
		const authorize = new URL(authorizeUrl);
		const redirect = new URL(authorize.searchParams.get("redirect_uri") ?? "");
		if (options.error) redirect.searchParams.set("error", options.error);
		else {
			redirect.searchParams.set("state", options.state ?? (authorize.searchParams.get("state") as string));
			if (!options.omitCode) redirect.searchParams.set("code", "google_code_1");
		}
		await realFetch(redirect.toString());
	});
}

async function readStoredSession(dataDir: string): Promise<Record<string, unknown>> {
	const raw = await readFile(path.join(dataDir, STORE_FILE), "utf8");
	return (JSON.parse(raw) as { session: Record<string, unknown> }).session;
}

describe("AO Cloud desktop credential custody", () => {
	let dataDir: string;

	beforeEach(async () => {
		vi.clearAllMocks();
		mocks.encryptionAvailable = true;
		mocks.isPackaged = true;
		mocks.selectedStorageBackend = "gnome_libsecret";
		mocks.decryptString.mockImplementation((value: Buffer) => value.toString("utf8"));
		mocks.encryptString.mockImplementation((value: string) => Buffer.from(value, "utf8"));
		setCloudPreferenceEnabled(true);
		dataDir = await mkdtemp(path.join(os.tmpdir(), "ao-cloud-auth-"));
		routes = new Map<string, RouteHandler>([
			["https://oauth2.googleapis.com/token", () => jsonResponse({ id_token: "google_id_token" })],
			["https://cloud.example/api/cloud/v1/auth/google", () => jsonResponse(aoSession())],
		]);
		stubFetch();
		completeGoogleRedirect();
	});

	afterEach(async () => {
		globalThis.fetch = realFetch;
		setCloudPreferenceEnabled(false);
		await rm(dataDir, { recursive: true, force: true });
	});

	it("gates every cloud surface behind the developer early-access opt-in", async () => {
		setCloudPreferenceEnabled(false);
		expect(cloudAvailability()).toEqual({ available: true, enabled: false });
		await expect(getCloudSession(dataDir)).resolves.toBeNull();
		await expect(beginCloudSignIn(dataDir)).rejects.toThrow("not configured");

		setCloudPreferenceEnabled(true);
		expect(cloudAvailability()).toEqual({ available: true, enabled: true });
	});

	it("completes Google PKCE against the loopback redirect and stores the AO session", async () => {
		const account = await beginCloudSignIn(dataDir);

		expect(account).toMatchObject({
			authProvider: "google",
			user: { id: "user_1", email: "dev@example.com", displayName: "Dev" },
			organizations: [{ id: "org_1", slug: "dev", displayName: "Dev", role: "owner" }],
		});
		// Tokens must never reach the renderer-visible account shape.
		expect(account).not.toHaveProperty("accessToken");
		expect(account).not.toHaveProperty("refreshToken");

		const authorize = new URL(mocks.openExternal.mock.calls[0]?.[0] as string);
		expect(authorize.origin + authorize.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
		expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authorize.searchParams.get("code_challenge")).toBeTruthy();
		expect(authorize.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

		await expect(getCloudAccessToken(dataDir)).resolves.toBe("ao_access_1");
	});

	it("writes the encrypted store under the AO data dir with owner-only permissions", async () => {
		await beginCloudSignIn(dataDir);

		const stored = await readStoredSession(dataDir);
		expect(stored.refreshToken).toBe("ao_refresh_1");
		expect(mocks.encryptString).toHaveBeenCalled();
		const { mode } = await import("node:fs/promises").then((fs) => fs.stat(path.join(dataDir, STORE_FILE)));
		expect(mode & 0o777).toBe(0o600);
	});

	it("keeps the session process-local when the OS offers no protected storage", async () => {
		mocks.encryptionAvailable = false;

		await beginCloudSignIn(dataDir);

		await expect(readFile(path.join(dataDir, STORE_FILE))).rejects.toThrow();
		await expect(getCloudAccessToken(dataDir)).resolves.toBe("ao_access_1");
	});

	it("refuses Linux's unprotected basic_text backend", async () => {
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		mocks.selectedStorageBackend = "basic_text";
		try {
			await beginCloudSignIn(dataDir);
			await expect(readFile(path.join(dataDir, STORE_FILE))).rejects.toThrow();
		} finally {
			Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		}
	});

	it("rejects a callback whose state does not match the authorization request", async () => {
		completeGoogleRedirect({ state: "attacker_state" });
		await expect(beginCloudSignIn(dataDir)).rejects.toThrow("state did not match");
	});

	it("surfaces a Google-reported error instead of exchanging a code", async () => {
		completeGoogleRedirect({ error: "access_denied" });
		await expect(beginCloudSignIn(dataDir)).rejects.toThrow("access_denied");
	});

	it("rotates the refresh token when the access token is near expiry", async () => {
		routes.set("https://cloud.example/api/cloud/v1/auth/google", () =>
			jsonResponse(aoSession({ expiresAt: new Date(Date.now() + 1_000).toISOString() })),
		);
		await beginCloudSignIn(dataDir);

		const refresh = vi.fn(() =>
			jsonResponse(aoSession({ accessToken: "ao_access_2", refreshToken: "ao_refresh_2" })),
		);
		routes.set("https://cloud.example/api/cloud/v1/auth/refresh", refresh);

		await expect(getCloudAccessToken(dataDir)).resolves.toBe("ao_access_2");
		expect(await readStoredSession(dataDir)).toMatchObject({ refreshToken: "ao_refresh_2" });
	});

	it("refreshes once for concurrent readers", async () => {
		routes.set("https://cloud.example/api/cloud/v1/auth/google", () =>
			jsonResponse(aoSession({ expiresAt: new Date(Date.now() + 1_000).toISOString() })),
		);
		await beginCloudSignIn(dataDir);

		const refresh = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			return jsonResponse(aoSession({ accessToken: "ao_access_2", refreshToken: "ao_refresh_2" }));
		});
		routes.set("https://cloud.example/api/cloud/v1/auth/refresh", refresh);

		const [a, b, c] = await Promise.all([
			getCloudSession(dataDir),
			getCloudSession(dataDir),
			getCloudSession(dataDir),
		]);

		expect(refresh).toHaveBeenCalledTimes(1);
		expect([a, b, c].every((account) => account?.user.id === "user_1")).toBe(true);
	});

	it("keeps the session through a transient refresh failure but refuses to hand out a stale token", async () => {
		routes.set("https://cloud.example/api/cloud/v1/auth/google", () =>
			jsonResponse(aoSession({ expiresAt: new Date(Date.now() + 1_000).toISOString() })),
		);
		await beginCloudSignIn(dataDir);
		routes.set("https://cloud.example/api/cloud/v1/auth/refresh", () => {
			throw new TypeError("fetch failed");
		});

		await expect(getCloudSession(dataDir)).resolves.toMatchObject({ user: { id: "user_1" } });
		await expect(getCloudAccessToken(dataDir)).rejects.toThrow("could not be refreshed");
		expect(await readStoredSession(dataDir)).toMatchObject({ refreshToken: "ao_refresh_1" });
	});

	it("drops custody when the control plane rejects the refresh token", async () => {
		routes.set("https://cloud.example/api/cloud/v1/auth/google", () =>
			jsonResponse(aoSession({ expiresAt: new Date(Date.now() + 1_000).toISOString() })),
		);
		await beginCloudSignIn(dataDir);
		routes.set("https://cloud.example/api/cloud/v1/auth/refresh", () =>
			jsonResponse({ code: "INVALID_REFRESH_TOKEN", message: "consumed", requestId: "r1" }, 401),
		);

		await expect(getCloudSession(dataDir)).resolves.toBeNull();
		await expect(readFile(path.join(dataDir, STORE_FILE))).rejects.toThrow();
	});

	it("revokes the refresh token on sign-out and clears local custody", async () => {
		await beginCloudSignIn(dataDir);
		let logoutBody: string | undefined;
		routes.set("https://cloud.example/api/cloud/v1/auth/logout", (_url, init) => {
			logoutBody = String(init?.body);
			return jsonResponse({ ok: true });
		});

		await signOutCloud(dataDir);

		expect(JSON.parse(logoutBody ?? "null")).toEqual({ refreshToken: "ao_refresh_1" });
		await expect(readFile(path.join(dataDir, STORE_FILE))).rejects.toThrow();
		await expect(getCloudSession(dataDir)).resolves.toBeNull();
	});

	it("clears local custody even when the revoke call cannot reach the control plane", async () => {
		await beginCloudSignIn(dataDir);
		routes.set("https://cloud.example/api/cloud/v1/auth/logout", () => {
			throw new TypeError("fetch failed");
		});

		await signOutCloud(dataDir);

		await expect(readFile(path.join(dataDir, STORE_FILE))).rejects.toThrow();
	});

	it("does not resurrect a signed-out session from an in-flight refresh", async () => {
		routes.set("https://cloud.example/api/cloud/v1/auth/google", () =>
			jsonResponse(aoSession({ expiresAt: new Date(Date.now() + 1_000).toISOString() })),
		);
		await beginCloudSignIn(dataDir);
		routes.set("https://cloud.example/api/cloud/v1/auth/logout", () => jsonResponse({ ok: true }));
		routes.set("https://cloud.example/api/cloud/v1/auth/refresh", async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return jsonResponse(aoSession({ accessToken: "ao_access_2", refreshToken: "ao_refresh_2" }));
		});

		const pending = getCloudSession(dataDir);
		await signOutCloud(dataDir);
		await pending;

		await expect(readFile(path.join(dataDir, STORE_FILE))).rejects.toThrow();
		await expect(getCloudSession(dataDir)).resolves.toBeNull();
	});

	it("discards an unreadable store instead of failing every later read", async () => {
		await beginCloudSignIn(dataDir);
		await writeFile(path.join(dataDir, STORE_FILE), "not-encrypted-json");
		mocks.decryptString.mockImplementation(() => {
			throw new Error("bad ciphertext");
		});

		await expect(getCloudSession(dataDir)).resolves.toBeNull();
		await expect(readFile(path.join(dataDir, STORE_FILE))).rejects.toThrow();
	});

	it("explains sign-in failures in product language", async () => {
		await showCloudSignInFailure(new Error("The Google sign-in request expired."));
		expect(mocks.showMessageBox).toHaveBeenCalledWith(
			expect.objectContaining({ detail: expect.stringContaining("expired") }),
		);
	});
});
