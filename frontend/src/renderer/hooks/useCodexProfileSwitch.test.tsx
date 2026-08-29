import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }));
vi.mock("../lib/api-client", () => ({
	apiClient: { GET: getMock, POST: postMock },
	apiErrorMessage: () => "request failed",
}));

import { codexProfileSwitchOptionsQueryKey, useCodexProfileSwitchOptions } from "./useCodexProfileSwitch";

const response = {
	sourceProfile: { id: "existing", label: "Existing Codex profile", source: "existing", availability: "available" },
	recommendedProfileId: "managed-1",
	candidates: [],
};

function wrapper(queryClient: QueryClient) {
	return ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
	getMock.mockReset().mockResolvedValue({ data: response });
	postMock.mockReset().mockResolvedValue({ data: response });
});

describe("Codex profile-switch options", () => {
	it("renders the cached snapshot and ensures only on meaningful UI triggers", async () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const { result } = renderHook(() => useCodexProfileSwitchOptions("demo-1", true), { wrapper: wrapper(queryClient) });

		await waitFor(() => expect(result.current.data).toEqual(response));
		expect(getMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/profile-switch-options", { params: { path: { sessionId: "demo-1" } } });
		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(postMock).toHaveBeenLastCalledWith("/api/v1/sessions/{sessionId}/profile-switch-options/ensure", { params: { path: { sessionId: "demo-1" } } });

		act(() => window.dispatchEvent(new Event("focus")));
		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
		expect(queryClient.getQueryData(codexProfileSwitchOptionsQueryKey("demo-1"))).toEqual(response);
	});

	it("does not read or ensure while the surface is closed", () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		renderHook(() => useCodexProfileSwitchOptions("demo-1", false), { wrapper: wrapper(queryClient) });
		expect(getMock).not.toHaveBeenCalled();
		expect(postMock).not.toHaveBeenCalled();
	});
});
