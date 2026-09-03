import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useImportAllSessions, type ImportableSession } from "./useImportableSessions";

const h = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock("../lib/api-client", () => ({
	apiClient: { GET: vi.fn(), POST: h.post },
	apiErrorMessage: (_e: unknown, fallback: string) => fallback,
}));

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function session(id: string, alreadyImported = false): ImportableSession {
	return {
		provider: "claude-code",
		nativeSessionId: id,
		title: id,
		cwd: "/repo",
		lastActivity: new Date().toISOString(),
		messageCount: 5,
		sizeBytes: 100,
		alreadyImported,
	};
}

beforeEach(() => {
	h.post.mockReset();
	h.post.mockResolvedValue({ data: { session: { id: "s" } }, error: undefined });
});

describe("useImportAllSessions", () => {
	// The point of the feature: one action, not one click per conversation.
	it("imports every pending conversation in one run", async () => {
		const { result } = renderHook(() => useImportAllSessions(), { wrapper });

		await act(async () => {
			await result.current.importAll([session("a"), session("b"), session("c")]);
		});

		expect(h.post).toHaveBeenCalledTimes(3);
		await waitFor(() => expect(result.current.progress?.imported).toBe(3));
		expect(result.current.progress?.failed).toBe(0);
	});

	// Re-running after a partial import must not redo finished work.
	it("skips conversations that are already imported", async () => {
		const { result } = renderHook(() => useImportAllSessions(), { wrapper });

		await act(async () => {
			await result.current.importAll([session("a", true), session("b"), session("c", true)]);
		});

		expect(h.post).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(result.current.progress?.total).toBe(1));
	});

	// One unreadable transcript must not strand the other ninety-nine.
	it("counts a failure and keeps going", async () => {
		h.post
			.mockResolvedValueOnce({ data: undefined, error: { message: "boom" } })
			.mockResolvedValue({ data: { session: { id: "s" } }, error: undefined });

		const { result } = renderHook(() => useImportAllSessions(), { wrapper });
		await act(async () => {
			await result.current.importAll([session("a"), session("b"), session("c")]);
		});

		expect(h.post).toHaveBeenCalledTimes(3);
		await waitFor(() => {
			expect(result.current.progress?.failed).toBe(1);
			expect(result.current.progress?.imported).toBe(2);
		});
	});

	it("does nothing when everything is already imported", async () => {
		const { result } = renderHook(() => useImportAllSessions(), { wrapper });
		await act(async () => {
			await result.current.importAll([session("a", true)]);
		});
		expect(h.post).not.toHaveBeenCalled();
		expect(result.current.progress).toBeNull();
	});
});
