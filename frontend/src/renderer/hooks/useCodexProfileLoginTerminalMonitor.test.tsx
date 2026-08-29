import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { useUiStore } from "../stores/ui-store";
import type { ShellTerminal } from "./useShellTerminals";
import { codexProfilesQueryKey } from "./codex-profile-cache";
import { useCodexProfileLoginTerminalMonitor } from "./useCodexProfileLoginTerminalMonitor";

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));
vi.mock("../lib/api-client", () => ({
	apiClient: { POST: postMock },
	apiErrorMessage: () => "request failed",
}));

const terminal: ShellTerminal = {
	handleId: "shellterm-login-1",
	workingDir: "/profiles/existing",
	title: "Codex login",
	createdAt: "2026-08-29T12:00:00Z",
};

function wrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
	postMock.mockReset();
	useUiStore.setState({ codexProfileLoginTerminal: null, activeShellTerminalHandleId: null });
});

it("navigates to the login terminal and stops after Codex reports authorization", async () => {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const navigateToTerminals = vi.fn();
	queryClient.setQueryData(codexProfilesQueryKey, {
		profiles: [
			{
				id: "existing", label: "Existing Codex profile", source: "existing", status: "valid", reasonCode: "profile_valid", reason: "available",
				authentication: { state: "unauthorized", freshness: "fresh", reasonCode: "unauthorized", reason: "signed out" },
				authMethod: "unknown", usableByCurrentLaunches: true,
			},
			{
				id: "managed-1", label: "Work", source: "managed", status: "valid", reasonCode: "profile_valid", reason: "available",
				authentication: { state: "unauthorized", freshness: "fresh", reasonCode: "unauthorized", reason: "signed out" },
				authMethod: "unknown", usableByCurrentLaunches: false,
			},
		],
		capabilities: { accountRead: { state: "supported", reasonCode: "supported", reason: "available" }, browserLogin: { state: "supported", reasonCode: "supported", reason: "available" } },
	});
	postMock.mockResolvedValue({ data: {
		profiles: [{
			id: "existing", label: "Existing Codex profile", source: "existing", status: "valid", reasonCode: "profile_valid", reason: "available",
			authentication: { state: "authorized", freshness: "fresh", reasonCode: "authorized", reason: "signed in" },
			authMethod: "chatgpt", usableByCurrentLaunches: true,
		}],
		capabilities: { accountRead: { state: "supported", reasonCode: "supported", reason: "available" }, browserLogin: { state: "supported", reasonCode: "supported", reason: "available" } },
	} });
	useUiStore.getState().monitorCodexProfileLoginTerminal("existing", terminal.handleId);

	renderHook(() => useCodexProfileLoginTerminalMonitor([terminal], navigateToTerminals), { wrapper: wrapper(queryClient) });

	await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/v1/agents/codex/profiles/ensure", {
		body: { profileIds: ["existing"], purpose: "display", forceAuthenticationRefresh: true },
	}));
	await waitFor(() => expect(useUiStore.getState().codexProfileLoginTerminal).toBeNull());
	expect(navigateToTerminals).toHaveBeenCalledTimes(1);
	expect(queryClient.getQueryData(codexProfilesQueryKey)).toMatchObject({ profiles: [
		{ id: "existing", authentication: { state: "authorized" } },
		{ id: "managed-1", authentication: { state: "unauthorized" } },
	] });
});

it("stops monitoring after a previously visible login terminal disappears", async () => {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const unauthorized = {
		profiles: [{
			id: "existing", label: "Existing Codex profile", source: "existing", status: "valid", reasonCode: "profile_valid", reason: "available",
			authentication: { state: "unauthorized", freshness: "fresh", reasonCode: "unauthorized", reason: "signed out" },
			authMethod: "unknown", usableByCurrentLaunches: true,
		}],
		capabilities: { accountRead: { state: "supported", reasonCode: "supported", reason: "available" }, browserLogin: { state: "supported", reasonCode: "supported", reason: "available" } },
	};
	postMock.mockResolvedValue({ data: unauthorized });
	useUiStore.getState().monitorCodexProfileLoginTerminal("existing", terminal.handleId);

	const { rerender } = renderHook(
		({ terminals }) => useCodexProfileLoginTerminalMonitor(terminals, vi.fn()),
		{ initialProps: { terminals: [terminal] }, wrapper: wrapper(queryClient) },
	);
	await waitFor(() => expect(postMock).toHaveBeenCalled());
	rerender({ terminals: [] });
	await waitFor(() => expect(useUiStore.getState().codexProfileLoginTerminal).toBeNull());
});
