import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sessionStatusMock, settingsMock } = vi.hoisted(() => ({
	sessionStatusMock: vi.fn(),
	settingsMock: vi.fn(),
}));

// Covers useCloudCp AND useCloudGate: both read the same settings hook.
vi.mock("./useSettings", () => ({
	useSettings: () => ({ settings: settingsMock(), isLoading: false, error: undefined }),
}));

vi.mock("../lib/cloud-session", () => ({
	useCloudSession: () => ({
		configured: true,
		session: null,
		status: sessionStatusMock(),
		signIn: () => undefined,
		signOut: async () => undefined,
	}),
}));

import { useCloudCp } from "./useCloudCp";

const meBody = JSON.stringify({
	user: { id: "user-1", email: "priya@acme.dev", displayName: "Priya", authProvider: "workos" },
	organizations: [],
});

// Deliberately untyped view of the bridge surfaces: the preload typings are
// owned by the parallel transport work, so these tests manipulate the globals
// structurally instead of through AoBridge.
type BridgeWindow = {
	aoBridge?: { cloudCp?: { request?: unknown } };
	ao?: { cloudCp?: unknown };
};

const bridgeWindow = window as unknown as BridgeWindow;
// The global test setup installs a window.ao.cloudCp stub; stash it so these
// tests control exactly which transport the shim can see.
const setupCloudCp = bridgeWindow.ao?.cloudCp;

beforeEach(() => {
	settingsMock.mockReset().mockReturnValue({ cloudEnabled: true, cloudControlPlaneUrl: "https://cp.example.com" });
	sessionStatusMock.mockReset().mockReturnValue("authenticated");
	delete bridgeWindow.aoBridge;
	if (bridgeWindow.ao) delete bridgeWindow.ao.cloudCp;
});

afterEach(() => {
	delete bridgeWindow.aoBridge;
	if (bridgeWindow.ao) bridgeWindow.ao.cloudCp = setupCloudCp;
	vi.unstubAllGlobals();
});

describe("useCloudCp", () => {
	it("routes control-plane calls through the preload cloudCp bridge when present", async () => {
		const request = vi.fn().mockResolvedValue({
			status: 200,
			headers: { "content-type": "application/json" },
			body: meBody,
		});
		bridgeWindow.aoBridge = { cloudCp: { request } };

		const { result } = renderHook(() => useCloudCp());
		const me = await result.current.client.me();

		expect(me.organizations).toEqual([]);
		expect(request).toHaveBeenCalledTimes(1);
		const init = request.mock.calls[0][0] as {
			baseUrl: string;
			path: string;
			method: string;
			headers: Record<string, string>;
			body?: string;
		};
		expect(init).toMatchObject({
			baseUrl: "https://cp.example.com",
			path: "/api/cloud/v1/me",
			method: "GET",
		});
		// The renderer sends a placeholder bearer; main replaces it with the real token.
		expect(init.headers.authorization).toMatch(/^Bearer /);
		expect(init.body).toBeUndefined();
	});

	it("falls back to window.fetch when no bridge is exposed", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(meBody, { status: 200, headers: { "content-type": "application/json" } }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const { result } = renderHook(() => useCloudCp());
		const me = await result.current.client.me();

		expect(me.user.id).toBe("user-1");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0][0])).toBe("https://cp.example.com/api/cloud/v1/me");
	});

	it("surfaces a bridge 401 as a CloudCpAuthError", async () => {
		bridgeWindow.aoBridge = {
			cloudCp: {
				request: vi.fn().mockResolvedValue({
					status: 401,
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ error: "unauthorized", code: "no_token", message: "Sign in and try again." }),
				}),
			},
		};

		const { result } = renderHook(() => useCloudCp());

		await expect(result.current.client.me()).rejects.toMatchObject({
			name: "CloudCpAuthError",
			status: 401,
			code: "no_token",
		});
	});

	it("is ready only when the gate is on, the session is authenticated, and the base URL is set", () => {
		expect(renderHook(() => useCloudCp()).result.current).toMatchObject({
			ready: true,
			baseUrl: "https://cp.example.com",
		});

		sessionStatusMock.mockReturnValue("unauthenticated");
		expect(renderHook(() => useCloudCp()).result.current.ready).toBe(false);

		sessionStatusMock.mockReturnValue("authenticated");
		settingsMock.mockReturnValue({ cloudEnabled: false, cloudControlPlaneUrl: "https://cp.example.com" });
		expect(renderHook(() => useCloudCp()).result.current.ready).toBe(false);

		settingsMock.mockReturnValue({ cloudEnabled: true, cloudControlPlaneUrl: "" });
		expect(renderHook(() => useCloudCp()).result.current.ready).toBe(false);

		// Settings still loading: fail closed.
		settingsMock.mockReturnValue(undefined);
		expect(renderHook(() => useCloudCp()).result.current.ready).toBe(false);
	});
});
