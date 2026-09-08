import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationDTO } from "../lib/notifications";
import { getCachedNotifications } from "../lib/notifications";

const { deleteMock, getMock } = vi.hoisted(() => ({
	deleteMock: vi.fn(),
	getMock: vi.fn(),
}));

vi.mock("../lib/api-client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/api-client")>();
	return {
		...actual,
		apiClient: { ...actual.apiClient, DELETE: deleteMock, GET: getMock },
	};
});

import { useClearAllNotificationsMutation, useNotificationsQuery } from "./useNotificationsQuery";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function staleNotification(id: string): NotificationDTO {
	return {
		id,
		sessionId: "sess-1",
		projectId: "proj-1",
		prUrl: "",
		type: "needs_input",
		title: `stale ${id}`,
		body: "",
		status: "unread",
		createdAt: "2026-07-21T10:00:00Z",
		target: { kind: "session", sessionId: "sess-1" },
	};
}

function wrapper({ children }: { children: ReactNode }) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function useHarness() {
	const query = useNotificationsQuery("unread");
	const clearAll = useClearAllNotificationsMutation();
	return { clearAll, query };
}

beforeEach(() => {
	deleteMock.mockReset();
	getMock.mockReset();
});

describe("useClearAllNotificationsMutation", () => {
	it("does not let a fetch already in flight when clear-all is clicked repopulate the cache", async () => {
		const getDeferred = deferred<{ data: unknown; error: undefined }>();
		const deleteDeferred = deferred<{ data: unknown; error: undefined }>();
		getMock.mockReturnValue(getDeferred.promise);
		deleteMock.mockReturnValue(deleteDeferred.promise);

		const { result } = renderHook(() => useHarness(), { wrapper });
		await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1));

		const clearPromise = result.current.clearAll.mutateAsync();
		// The delete resolves first ...
		deleteDeferred.resolve({ data: { clearedCount: 1 }, error: undefined });
		await clearPromise;

		// ... then the stale GET that was already in flight finally resolves.
		getDeferred.resolve({
			data: { notifications: [staleNotification("ntf_1")], nextCursor: undefined, unreadCount: 1, unresolvedCount: 1 },
			error: undefined,
		});
		await waitFor(() => {
			const cache = getCachedNotifications(
				result.current.query.data as Parameters<typeof getCachedNotifications>[0],
			);
			expect(cache).toEqual([]);
		});
	});

	it("cancels a fetch that starts during the pending delete before resetting the cache", async () => {
		const firstGet = deferred<{ data: unknown; error: undefined }>();
		const secondGet = deferred<{ data: unknown; error: undefined }>();
		const deleteDeferred = deferred<{ data: unknown; error: undefined }>();
		getMock.mockReturnValueOnce(firstGet.promise).mockReturnValueOnce(secondGet.promise);
		deleteMock.mockReturnValue(deleteDeferred.promise);

		const { result } = renderHook(() => useHarness(), { wrapper });
		await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1));
		firstGet.resolve({ data: { notifications: [], nextCursor: undefined, unreadCount: 0, unresolvedCount: 0 }, error: undefined });
		await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

		const clearPromise = result.current.clearAll.mutateAsync();
		// Something else (SSE reconnect, base-URL change) refetches while the
		// delete is still pending.
		void result.current.query.refetch();
		await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));

		deleteDeferred.resolve({ data: { clearedCount: 0 }, error: undefined });
		await clearPromise;
		secondGet.resolve({
			data: { notifications: [staleNotification("ntf_2")], nextCursor: undefined, unreadCount: 1, unresolvedCount: 1 },
			error: undefined,
		});
		await waitFor(() => {
			const cache = getCachedNotifications(
				result.current.query.data as Parameters<typeof getCachedNotifications>[0],
			);
			expect(cache).toEqual([]);
		});
	});

	it("leaves the cache untouched when the delete fails", async () => {
		getMock.mockResolvedValue({
			data: { notifications: [staleNotification("ntf_3")], nextCursor: undefined, unreadCount: 1, unresolvedCount: 1 },
			error: undefined,
		});
		deleteMock.mockResolvedValue({ data: undefined, error: { message: "boom" } });

		const { result } = renderHook(() => useHarness(), { wrapper });
		await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

		await expect(result.current.clearAll.mutateAsync()).rejects.toThrow();

		const cache = getCachedNotifications(
			result.current.query.data as Parameters<typeof getCachedNotifications>[0],
		);
		expect(cache.map((item) => item.id)).toEqual(["ntf_3"]);
	});
});
