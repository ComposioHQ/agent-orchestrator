import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { deleteMock, postMock } = vi.hoisted(() => ({ deleteMock: vi.fn(), postMock: vi.fn() }));

vi.mock("../lib/api-client", () => ({
	apiClient: { DELETE: deleteMock, POST: postMock },
	apiErrorCode: (error: unknown) =>
		typeof error === "object" && error !== null && "code" in error ? (error as { code?: string }).code : undefined,
	hasTrustedApiBaseUrl: () => true,
}));

import {
	type ShellTerminal,
	shellTerminalsQueryKey,
	useCloseShellTerminal,
	useOpenShellTerminal,
} from "./useShellTerminals";

const shells: ShellTerminal[] = [
	{
		createdAt: "2026-08-27T00:00:00Z",
		handleId: "ptyhost-v1:shellterm-one",
		title: "one",
		workingDir: "/tmp",
	},
	{
		createdAt: "2026-08-27T00:01:00Z",
		handleId: "ptyhost-v1:shellterm-two",
		title: "two",
		workingDir: "/tmp",
	},
];

function wrapper(queryClient: QueryClient) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
	};
}

function queryClientWithShells() {
	const queryClient = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	});
	queryClient.setQueryData(shellTerminalsQueryKey, shells);
	return queryClient;
}

beforeEach(() => {
	deleteMock.mockReset();
	postMock.mockReset();
});

describe("useOpenShellTerminal", () => {
	it("publishes the returned shell immediately without waiting for a list refetch", async () => {
		const shell = shells[0];
		postMock.mockResolvedValue({
			data: {
				shellTerminal: {
					createdAt: shell.createdAt,
					handleId: shell.handleId,
					title: shell.title,
					workingDir: shell.workingDir,
				},
			},
		});
		const queryClient = new QueryClient({
			defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
		});
		queryClient.setQueryData(shellTerminalsQueryKey, []);
		const { result } = renderHook(() => useOpenShellTerminal(), { wrapper: wrapper(queryClient) });

		await act(async () => result.current.mutateAsync({}));

		expect(queryClient.getQueryData(shellTerminalsQueryKey)).toEqual([shell]);
	});
});

describe("useCloseShellTerminal", () => {
	it("removes the terminal tab before an in-flight list request finishes cancelling", async () => {
		let finishCancel!: () => void;
		let finishDelete!: (result: { error?: unknown }) => void;
		deleteMock.mockReturnValue(new Promise((resolve) => (finishDelete = resolve)));
		const queryClient = queryClientWithShells();
		vi.spyOn(queryClient, "cancelQueries").mockReturnValue(
			new Promise<void>((resolve) => {
				finishCancel = resolve;
			}),
		);
		const { result } = renderHook(() => useCloseShellTerminal(), { wrapper: wrapper(queryClient) });

		act(() => result.current.mutate(shells[0].handleId));

		await waitFor(() => expect(queryClient.getQueryData(shellTerminalsQueryKey)).toEqual([shells[1]]));
		expect(deleteMock).not.toHaveBeenCalled();
		expect(result.current.isPending).toBe(true);

		act(() => finishCancel());
		await waitFor(() => expect(deleteMock).toHaveBeenCalled());
		act(() => finishDelete({}));
		await waitFor(() => expect(result.current.isPending).toBe(false));
	});

	it("restores an optimistically removed tab when a live PTY fails to close", async () => {
		let finishDelete!: (result: { error: unknown }) => void;
		deleteMock.mockReturnValue(new Promise((resolve) => (finishDelete = resolve)));
		const queryClient = queryClientWithShells();
		const { result } = renderHook(() => useCloseShellTerminal(), { wrapper: wrapper(queryClient) });

		act(() => result.current.mutate(shells[0].handleId));
		await waitFor(() => expect(queryClient.getQueryData(shellTerminalsQueryKey)).toEqual([shells[1]]));

		act(() => finishDelete({ error: { code: "SHELL_TERMINAL_CLOSE_FAILED" } }));
		await waitFor(() => expect(queryClient.getQueryData(shellTerminalsQueryKey)).toEqual(shells));
	});

	it("does not restore a stale tab when the daemon reports that its PTY is already gone", async () => {
		deleteMock.mockResolvedValue({ error: { code: "SHELL_TERMINAL_NOT_FOUND" } });
		const queryClient = queryClientWithShells();
		const { result } = renderHook(() => useCloseShellTerminal(), { wrapper: wrapper(queryClient) });

		await expect(result.current.mutateAsync(shells[0].handleId)).rejects.toEqual({
			code: "SHELL_TERMINAL_NOT_FOUND",
		});
		expect(queryClient.getQueryData(shellTerminalsQueryKey)).toEqual([shells[1]]);
	});
});
