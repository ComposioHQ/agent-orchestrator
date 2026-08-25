import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock("../lib/api-client", () => ({
	apiClient: { GET: getMock },
	apiErrorMessage: () => "Request failed",
}));

import { useCloudGate } from "./useCloudGate";

function renderCloudGate() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return renderHook(() => useCloudGate(), {
		wrapper: ({ children }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		),
	});
}

beforeEach(() => {
	getMock.mockReset();
});

describe("useCloudGate", () => {
	it("fails closed for cloud and open for local while settings load", () => {
		getMock.mockReturnValue(new Promise(() => {}));
		const { result } = renderCloudGate();

		expect(result.current).toEqual({ cloudEnabled: false, localEnabled: true, client: "" });
	});

	it("reflects the daemon-reported gates once settings resolve", async () => {
		getMock.mockResolvedValue({
			data: {
				defaultSessionMode: "tui",
				chatHarnesses: [],
				client: "eleven_x",
				localEnabled: false,
				cloudEnabled: true,
				cloudControlPlaneUrl: "https://cp.example.com",
			},
			error: undefined,
		});
		const { result } = renderCloudGate();

		await waitFor(() => expect(result.current.cloudEnabled).toBe(true));
		expect(result.current.localEnabled).toBe(false);
		expect(result.current.client).toBe("eleven_x");
	});
});
