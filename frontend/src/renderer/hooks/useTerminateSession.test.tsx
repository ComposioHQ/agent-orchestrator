import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSession } from "../types/workspace";
import { settingsQueryKey } from "./useSettings";

const { createCloudClientMock, deleteSessionMock, postMock } = vi.hoisted(() => ({
	createCloudClientMock: vi.fn(),
	deleteSessionMock: vi.fn(),
	postMock: vi.fn(),
}));

vi.mock("../lib/api-client", () => ({
	apiClient: { POST: postMock },
	apiErrorMessage: (_error: unknown, fallback: string) => fallback,
}));

vi.mock("./useCloudCp", () => ({
	createRendererCloudCpClient: createCloudClientMock,
}));

vi.mock("../lib/telemetry", () => ({ captureRendererEvent: vi.fn() }));

import { useTerminateSession } from "./useTerminateSession";

const localSession: WorkspaceSession = {
	id: "session-1",
	workspaceId: "project-1",
	workspaceName: "Project",
	title: "Local worker",
	provider: "claude-code",
	status: "working",
	updatedAt: "2026-09-01T00:00:00Z",
	prs: [],
};

function wrapperFor(queryClient: QueryClient) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
	};
}

beforeEach(() => {
	createCloudClientMock.mockReset();
	deleteSessionMock.mockReset().mockResolvedValue({ session: { id: "session-1", desiredState: "deleted" } });
	createCloudClientMock.mockReturnValue({ deleteSession: deleteSessionMock });
	postMock.mockReset().mockResolvedValue({ data: { ok: true }, error: undefined });
});

describe("useTerminateSession", () => {
	it("routes local sessions to the local daemon", async () => {
		const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
		const { result } = renderHook(() => useTerminateSession(), { wrapper: wrapperFor(queryClient) });

		await act(async () => result.current.mutateAsync(localSession));

		expect(postMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/kill", {
			params: { path: { sessionId: "session-1" } },
		});
		expect(createCloudClientMock).not.toHaveBeenCalled();
	});

	it("routes cloud sessions to their control-plane organization", async () => {
		const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
		queryClient.setQueryData(settingsQueryKey, { cloudControlPlaneUrl: "https://cp.example.com" });
		const cloudSession: WorkspaceSession = { ...localSession, cloud: { orgId: "org-1" } };
		const { result } = renderHook(() => useTerminateSession(), { wrapper: wrapperFor(queryClient) });

		await act(async () => result.current.mutateAsync(cloudSession));

		expect(createCloudClientMock).toHaveBeenCalledWith("https://cp.example.com");
		expect(deleteSessionMock).toHaveBeenCalledWith("org-1", "session-1");
		expect(postMock).not.toHaveBeenCalled();
	});

	it("fails closed when a cloud session has no configured control plane", async () => {
		const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
		const cloudSession: WorkspaceSession = { ...localSession, cloud: { orgId: "org-1" } };
		const { result } = renderHook(() => useTerminateSession(), { wrapper: wrapperFor(queryClient) });

		await expect(act(async () => result.current.mutateAsync(cloudSession))).rejects.toThrow(
			"The cloud control plane is not configured.",
		);
		expect(deleteSessionMock).not.toHaveBeenCalled();
		expect(postMock).not.toHaveBeenCalled();
	});
});
