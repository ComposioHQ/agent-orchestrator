import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }));
vi.mock("../lib/api-client", () => ({
	apiClient: { GET: getMock, POST: postMock },
	apiErrorMessage: () => "request failed",
	getApiBaseUrl: () => "http://127.0.0.1:3001",
}));

import { codexProfilesQueryKey, useCodexProfilesQuery, useEnsureCodexProfiles } from "./useCodexProfilesQuery";

const response = {
	profiles: [],
	capabilities: {
		accountRead: { state: "supported", reasonCode: "supported", reason: "available" },
		browserLogin: { state: "supported", reasonCode: "supported", reason: "available" },
	},
};

function wrapper(queryClient: QueryClient) {
	return ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
	getMock.mockReset().mockResolvedValue({ data: response });
	postMock.mockReset().mockResolvedValue({ data: response });
});

describe("Codex profile query", () => {
	it("reads the cached endpoint without treating React Query as the freshness authority", async () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const { result } = renderHook(() => useCodexProfilesQuery(), { wrapper: wrapper(queryClient) });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(getMock).toHaveBeenCalledWith("/api/v1/agents/codex/profiles");
		expect(postMock).not.toHaveBeenCalled();
	});

	it("ensures on surface open and window focus without polling", async () => {
		const queryClient = new QueryClient();
		renderHook(() => useEnsureCodexProfiles(), { wrapper: wrapper(queryClient) });
		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(postMock).toHaveBeenLastCalledWith("/api/v1/agents/codex/profiles/ensure", { body: { profileIds: [], purpose: "display" } });
		act(() => window.dispatchEvent(new Event("focus")));
		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
		expect(queryClient.getQueryData(codexProfilesQueryKey)).toEqual(response);
	});
});
