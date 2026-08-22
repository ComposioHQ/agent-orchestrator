import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCloudSettingsStore } from "../stores/cloud-settings-store";
import { useCloudSession } from "./cloud-session";

beforeEach(() => {
	useCloudSettingsStore.setState({ enabled: false, loaded: false, saving: false, saveError: false });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("useCloudSession", () => {
	it("keeps Cloud hidden when the feature flag is disabled", async () => {
		vi.spyOn(window.ao!.cloud, "isEnabled").mockReturnValue(false);
		const getSession = vi.spyOn(window.ao!.cloud, "getSession");
		const { result } = renderHook(() => useCloudSession());

		await waitFor(() => expect(result.current.status).toBe("unauthenticated"));
		expect(result.current.configured).toBe(false);
		expect(getSession).not.toHaveBeenCalled();
	});

	it("loads the Cloud account only when the feature flag is enabled", async () => {
		vi.spyOn(window.ao!.cloud, "isEnabled").mockReturnValue(true);
		vi.spyOn(window.ao!.cloud, "getSession").mockResolvedValue(null);
		const { result } = renderHook(() => useCloudSession());

		await waitFor(() => expect(result.current.status).toBe("unauthenticated"));
		expect(result.current.configured).toBe(true);
	});

	it("loads the Cloud account when the persisted early-access preference is enabled", async () => {
		vi.spyOn(window.ao!.cloud, "isEnabled").mockReturnValue(false);
		vi.spyOn(window.ao!.uiSettings, "get").mockResolvedValue({ locale: "en", cloudEnabled: true });
		const getSession = vi.spyOn(window.ao!.cloud, "getSession").mockResolvedValue(null);
		const { result } = renderHook(() => useCloudSession());

		await waitFor(() => expect(result.current.configured).toBe(true));
		await waitFor(() => expect(result.current.status).toBe("unauthenticated"));
		expect(getSession).toHaveBeenCalledOnce();
	});
});
