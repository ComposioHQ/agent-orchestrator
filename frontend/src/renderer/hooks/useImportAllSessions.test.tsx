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

function session(id: string, alreadyImported = false, cwd = "/repo"): ImportableSession {
	return {
		provider: "claude-code",
		nativeSessionId: id,
		title: id,
		cwd,
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

	// Two imports racing inside one repository would contend for git's
	// repository-wide lock, so a folder is imported in order even though
	// separate folders proceed at the same time.
	it("keeps one folder in order while running folders concurrently", async () => {
		const started: string[] = [];
		const finished: string[] = [];
		h.post.mockImplementation(async (_path: string, init: { body: { nativeSessionId: string } }) => {
			const { body } = init;
			started.push(body.nativeSessionId);
			await new Promise((r) => setTimeout(r, 5));
			finished.push(body.nativeSessionId);
			return { data: { session: { id: "s" } }, error: undefined };
		});

		const { result } = renderHook(() => useImportAllSessions(), { wrapper });
		await act(async () => {
			await result.current.importAll([
				session("a1", false, "/repo-a"),
				session("a2", false, "/repo-a"),
				session("b1", false, "/repo-b"),
			]);
		});

		// Within /repo-a, a1 must have finished before a2 started.
		expect(finished.indexOf("a1")).toBeLessThan(started.indexOf("a2"));
		// The other repository did not wait for /repo-a to finish.
		expect(started.indexOf("b1")).toBeLessThan(finished.indexOf("a2"));
		await waitFor(() => expect(result.current.progress?.imported).toBe(3));
	});

	// Stopping must actually end the run. Deriving "running" from the counts
	// left a stopped run permanently short of its total, so the spinner kept
	// turning and the result never appeared.
	it("stops on request and reports what it managed", async () => {
		let started = 0;
		h.post.mockImplementation(async () => {
			started += 1;
			await new Promise((r) => setTimeout(r, 5));
			return { data: { session: { id: "s" } }, error: undefined };
		});

		const { result } = renderHook(() => useImportAllSessions(), { wrapper });
		const batch = Array.from({ length: 30 }, (_, i) => session(`s${i}`, false, `/repo-${i}`));

		await act(async () => {
			const run = result.current.importAll(batch);
			await new Promise((r) => setTimeout(r, 8));
			result.current.stop();
			await run;
		});

		expect(result.current.running).toBe(false);
		expect(result.current.progress).not.toBeNull();
		expect(result.current.progress!.done).toBeLessThan(30);
		expect(started).toBeLessThan(30);
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
