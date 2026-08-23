import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
	getAvailability: vi.fn(),
	getSession: vi.fn(),
	signIn: vi.fn(),
	signOut: vi.fn(),
	onSessionChanged: vi.fn(() => () => undefined),
	setUiSettings: vi.fn(),
}));

vi.mock("./bridge", () => ({
	aoBridge: {
		cloud: {
			getAvailability: bridge.getAvailability,
			getSession: bridge.getSession,
			signIn: bridge.signIn,
			signOut: bridge.signOut,
			onSessionChanged: bridge.onSessionChanged,
		},
		uiSettings: { set: bridge.setUiSettings },
	},
}));

import { useCloudSession } from "./cloud-session";
import { useCloudStore } from "../stores/cloud-store";

const ACCOUNT = {
	authProvider: "google" as const,
	user: { id: "user_1", email: "dev@example.com", displayName: "Dev" },
	organizations: [{ id: "org_1", slug: "dev", displayName: "Dev", role: "owner" }],
	storedAt: "2026-08-22T00:00:00.000Z",
};

function resetStore(): void {
	useCloudStore.setState({
		availability: { available: false, enabled: false, apiBaseUrl: "" },
		account: null,
		loaded: false,
		accountLoaded: false,
		saving: false,
		saveError: false,
	});
}

describe("useCloudSession", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetStore();
		bridge.onSessionChanged.mockReturnValue(() => undefined);
	});

	afterEach(() => {
		resetStore();
	});

	it("reports nothing and never asks for an account while early access is off", async () => {
		bridge.getAvailability.mockResolvedValue({ available: true, enabled: false, apiBaseUrl: "" });

		const { result } = renderHook(() => useCloudSession());

		await waitFor(() => expect(result.current.available).toBe(true));
		expect(result.current.enabled).toBe(false);
		expect(result.current.apiBaseUrl).toBe("");
		expect(bridge.getSession).not.toHaveBeenCalled();
	});

	it("loads the signed-in account once early access is on", async () => {
		bridge.getAvailability.mockResolvedValue({
			available: true,
			enabled: true,
			apiBaseUrl: "https://cloud.example",
		});
		bridge.getSession.mockResolvedValue(ACCOUNT);

		const { result } = renderHook(() => useCloudSession());

		await waitFor(() => expect(result.current.status).toBe("authenticated"));
		expect(result.current.session?.user.email).toBe("dev@example.com");
		expect(result.current.apiBaseUrl).toBe("https://cloud.example");
	});

	it("treats a failed account read as signed out rather than surfacing an error", async () => {
		bridge.getAvailability.mockResolvedValue({
			available: true,
			enabled: true,
			apiBaseUrl: "https://cloud.example",
		});
		bridge.getSession.mockRejectedValue(new Error("offline"));

		const { result } = renderHook(() => useCloudSession());

		await waitFor(() => expect(result.current.status).toBe("unauthenticated"));
		expect(result.current.session).toBeNull();
	});

	it("adopts the account main returns from sign-in", async () => {
		bridge.getAvailability.mockResolvedValue({
			available: true,
			enabled: true,
			apiBaseUrl: "https://cloud.example",
		});
		bridge.getSession.mockResolvedValue(null);
		bridge.signIn.mockResolvedValue(ACCOUNT);

		const { result } = renderHook(() => useCloudSession());
		await waitFor(() => expect(result.current.status).toBe("unauthenticated"));

		await act(async () => {
			result.current.signIn();
		});

		await waitFor(() => expect(result.current.status).toBe("authenticated"));
	});

	it("stays signed out when main reports a cancelled sign-in", async () => {
		bridge.getAvailability.mockResolvedValue({
			available: true,
			enabled: true,
			apiBaseUrl: "https://cloud.example",
		});
		bridge.getSession.mockResolvedValue(null);
		bridge.signIn.mockResolvedValue(null);

		const { result } = renderHook(() => useCloudSession());
		await waitFor(() => expect(result.current.status).toBe("unauthenticated"));

		await act(async () => {
			result.current.signIn();
		});

		expect(result.current.status).toBe("unauthenticated");
	});

	it("clears the account on sign-out", async () => {
		bridge.getAvailability.mockResolvedValue({
			available: true,
			enabled: true,
			apiBaseUrl: "https://cloud.example",
		});
		bridge.getSession.mockResolvedValue(ACCOUNT);
		bridge.signOut.mockResolvedValue(undefined);

		const { result } = renderHook(() => useCloudSession());
		await waitFor(() => expect(result.current.status).toBe("authenticated"));

		await act(async () => {
			await result.current.signOut();
		});

		expect(result.current.session).toBeNull();
		expect(result.current.status).toBe("unauthenticated");
	});
});

describe("cloud settings store", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetStore();
	});

	it("re-reads availability from main instead of trusting the toggle", async () => {
		bridge.setUiSettings.mockResolvedValue({ locale: "en", cloudEnabled: true });
		// Main refuses to enable a build with no control plane configured.
		bridge.getAvailability.mockResolvedValue({ available: false, enabled: false, apiBaseUrl: "" });

		await useCloudStore.getState().setEnabled(true);

		expect(bridge.setUiSettings).toHaveBeenCalledWith({ cloudEnabled: true });
		expect(useCloudStore.getState().availability.enabled).toBe(false);
	});

	it("surfaces a save failure without flipping the gate", async () => {
		bridge.setUiSettings.mockRejectedValue(new Error("no run file"));

		await useCloudStore.getState().setEnabled(true);

		const state = useCloudStore.getState();
		expect(state.saveError).toBe(true);
		expect(state.availability.enabled).toBe(false);
	});

	it("loads availability once for concurrent readers", async () => {
		bridge.getAvailability.mockResolvedValue({
			available: true,
			enabled: true,
			apiBaseUrl: "https://cloud.example",
		});

		await Promise.all([
			useCloudStore.getState().load(),
			useCloudStore.getState().load(),
			useCloudStore.getState().load(),
		]);

		expect(bridge.getAvailability).toHaveBeenCalledTimes(1);
		expect(useCloudStore.getState().availability.apiBaseUrl).toBe("https://cloud.example");
	});
});
