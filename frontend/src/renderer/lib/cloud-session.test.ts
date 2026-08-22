import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCloudSession } from "./cloud-session";

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
});
