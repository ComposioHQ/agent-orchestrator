import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api-client", () => ({
	apiClient: { GET: vi.fn(), POST: vi.fn() },
	apiErrorMessage: (error: unknown) => String(error),
}));

vi.mock("../lib/preview-mode", () => ({ usesPreviewWorkspaceData: () => false }));

import type { ShellTerminal } from "./useShellTerminals";
import { githubAuthTerminalQueryKey, useGitHubAuthTerminal } from "./useSystemRequirementsGate";

const loginTerminal: ShellTerminal = {
	createdAt: "2026-09-06T00:00:00Z",
	handleId: "ptyhost-v1:shellterm-github-auth",
	title: "Connect GitHub",
	workingDir: "/tmp/auth-workspace",
};

function wrapper(queryClient: QueryClient) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("useGitHubAuthTerminal", () => {
	// A `gh auth login` device flow routinely outlives React Query's five-minute
	// default gcTime: the user leaves AO, authenticates in a browser, then comes
	// back. The notice renders only on the home page and the empty board, so
	// opening a project unmounts the last observer of this query. If the handle
	// were collected the panel could not reattach, and the PTY would be orphaned
	// with no way to close it from the notice.
	it("retains the login terminal handle while no component observes it", () => {
		vi.useFakeTimers();
		const queryClient = new QueryClient();

		const { unmount } = renderHook(() => useGitHubAuthTerminal(), { wrapper: wrapper(queryClient) });
		queryClient.setQueryData<ShellTerminal | null>(githubAuthTerminalQueryKey, loginTerminal);
		expect(queryClient.getQueryData(githubAuthTerminalQueryKey)).toEqual(loginTerminal);

		unmount();
		vi.advanceTimersByTime(10 * 60 * 1000);

		expect(queryClient.getQueryData(githubAuthTerminalQueryKey)).toEqual(loginTerminal);
	});

	it("exposes an already-cached handle to a mounting notice", async () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData<ShellTerminal | null>(githubAuthTerminalQueryKey, loginTerminal);

		const { result } = renderHook(() => useGitHubAuthTerminal(), { wrapper: wrapper(queryClient) });

		await waitFor(() => expect(result.current.data).toEqual(loginTerminal));
	});

	it("clears the handle once the flow is done", async () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData<ShellTerminal | null>(githubAuthTerminalQueryKey, loginTerminal);

		const { result } = renderHook(() => useGitHubAuthTerminal(), { wrapper: wrapper(queryClient) });
		await waitFor(() => expect(result.current.data).toEqual(loginTerminal));

		result.current.clear();

		await waitFor(() => expect(result.current.data).toBeNull());
		expect(queryClient.getQueryData(githubAuthTerminalQueryKey)).toBeNull();
	});
});
