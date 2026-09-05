import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceQueryKey } from "./useWorkspaceQuery";

const { patch } = vi.hoisted(() => ({ patch: vi.fn() }));
vi.mock("../lib/api-client", () => ({
	apiClient: { PATCH: patch },
	apiErrorMessage: (error: { message: string }) => error.message,
}));
import { useRememberProjectPermissions } from "./useRememberProjectPermissions";

function setup(sourceHarness?: string) {
	const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
	const invalidate = vi.spyOn(client, "invalidateQueries");
	const wrapper = ({ children }: { children: ReactNode }) =>
		<QueryClientProvider client={client}>{children}</QueryClientProvider>;
	return { ...renderHook(() => useRememberProjectPermissions("project-one", sourceHarness), { wrapper }), invalidate };
}

beforeEach(() => patch.mockReset());

describe("project permission persistence", () => {
	it("writes only the requested permission to the correct project and refreshes project data", async () => {
		patch.mockResolvedValue({ data: { project: {} } });
		const { result, invalidate } = setup();
		expect(patch).not.toHaveBeenCalled();
		await act(async () => { await result.current.remember("bypass-permissions"); });
		expect(patch).toHaveBeenCalledWith("/api/v1/projects/{id}/permissions", {
			params: { path: { id: "project-one" } }, body: { permissions: "bypass-permissions" },
		});
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["project", "project-one"] });
		expect(invalidate).toHaveBeenCalledWith({ queryKey: workspaceQueryKey });
		await waitFor(() => expect(result.current.saved).toBe(true));
	});

	it("reports errors without claiming success and allows an explicit retry", async () => {
		patch.mockResolvedValueOnce({ error: { message: "Project not found" } }).mockResolvedValueOnce({});
		const { result, invalidate } = setup();
		await act(async () => { await expect(result.current.remember("auto")).rejects.toEqual({ message: "Project not found" }); });
		await waitFor(() => expect(result.current.error).toBe("Project not found"));
		expect(result.current.saved).toBe(false);
		expect(invalidate).not.toHaveBeenCalled();
		await act(async () => { await result.current.remember("auto"); });
		await waitFor(() => expect(result.current.saved).toBe(true));
		expect(result.current.error).toBeUndefined();
	});
});


it("sends source harness context so the daemon can preserve Full access across providers", async () => {
	patch.mockResolvedValue({});
	const { result } = setup("codex");
	await act(async () => { await result.current.remember("default"); });
	expect(patch).toHaveBeenCalledWith("/api/v1/projects/{id}/permissions", {
		params: { path: { id: "project-one" } }, body: { permissions: "default", sourceHarness: "codex" },
	});
});
