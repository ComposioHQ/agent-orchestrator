import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiBaseUrl } from "../lib/api-client";
import { forgetHost, registerHostBase } from "../lib/host-clients";
import { LOCAL_HOST } from "../lib/hosts";
import { renameSession } from "../lib/rename-session";
import { usePinSession, useUnpinSession } from "./usePinSession";
import { useRestoreSession } from "./useRestoreSession";
import { useTerminateSession } from "./useTerminateSession";

// Two hosts, one project name, one session id. This is the default case, not an
// edge case: a project id is filepath.Base(path) on every machine, so two
// machines that both cloned agent-orchestrator both call it "agent-orchestrator"
// and number their sessions from one. Routing by bare id would act on whichever
// daemon happened to answer.
const LOCAL_BASE = "http://127.0.0.1:3001";
const REMOTE_HOST = "http://192.0.2.7:3011";
const REMOTE_BASE = "http://127.0.0.1:49711/proxy-token";
const SHARED_SESSION_ID = "agent-orchestrator-1";

const localSession = { host: LOCAL_HOST, id: SHARED_SESSION_ID };
const remoteSession = { host: REMOTE_HOST, id: SHARED_SESSION_ID };

let requested: string[] = [];

function wrapper({ children }: { children: ReactNode }) {
	const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function urlsFor(base: string): string[] {
	return requested.filter((url) => url.startsWith(base));
}

beforeEach(() => {
	requested = [];
	setApiBaseUrl(LOCAL_BASE);
	registerHostBase(REMOTE_HOST, REMOTE_BASE, "workbox");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			requested.push(input instanceof Request ? input.url : String(input));
			return new Response(JSON.stringify({ status: "ok" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}),
	);
});

afterEach(() => {
	forgetHost(REMOTE_HOST);
	setApiBaseUrl(null);
	vi.unstubAllGlobals();
});

describe("session writes are routed by ref, not by id", () => {
	it("renames the remote session without touching the local daemon", async () => {
		await renameSession(remoteSession, "polish login");

		expect(urlsFor(LOCAL_BASE)).toEqual([]);
		expect(urlsFor(REMOTE_BASE)).toEqual([
			`${REMOTE_BASE}/api/v1/sessions/${SHARED_SESSION_ID}`,
		]);
	});

	it("renames the local session without touching the remote proxy", async () => {
		await renameSession(localSession, "polish login");

		expect(urlsFor(REMOTE_BASE)).toEqual([]);
		expect(urlsFor(LOCAL_BASE)).toEqual([`${LOCAL_BASE}/api/v1/sessions/${SHARED_SESSION_ID}`]);
	});

	it("terminates the remote session without touching the local daemon", async () => {
		const { result } = renderHook(() => useTerminateSession(), { wrapper });

		result.current.mutate(remoteSession);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(urlsFor(LOCAL_BASE)).toEqual([]);
		expect(urlsFor(REMOTE_BASE)).toEqual([`${REMOTE_BASE}/api/v1/sessions/${SHARED_SESSION_ID}/kill`]);
	});

	it("pins and unpins the remote session without touching the local daemon", async () => {
		const pin = renderHook(() => usePinSession(), { wrapper });
		pin.result.current.mutate(remoteSession);
		await waitFor(() => expect(pin.result.current.isSuccess).toBe(true));

		const unpin = renderHook(() => useUnpinSession(), { wrapper });
		unpin.result.current.mutate(remoteSession);
		await waitFor(() => expect(unpin.result.current.isSuccess).toBe(true));

		expect(urlsFor(LOCAL_BASE)).toEqual([]);
		expect(urlsFor(REMOTE_BASE)).toEqual([
			`${REMOTE_BASE}/api/v1/sessions/${SHARED_SESSION_ID}/pin`,
			`${REMOTE_BASE}/api/v1/sessions/${SHARED_SESSION_ID}/pin`,
		]);
	});

	it("restores the remote session without touching the local daemon", async () => {
		const { result } = renderHook(() => useRestoreSession(), { wrapper });

		await result.current(remoteSession);

		expect(urlsFor(LOCAL_BASE)).toEqual([]);
		expect(urlsFor(REMOTE_BASE)).toEqual([`${REMOTE_BASE}/api/v1/sessions/${SHARED_SESSION_ID}/restore`]);
	});
});
