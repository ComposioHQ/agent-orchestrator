import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { aoBridge } from "../../lib/bridge";
import { useUiStore } from "../../stores/ui-store";
import { CodexProfilesSection } from "./CodexProfilesSection";

const { deleteMock, getMock, postMock, scrollIntoViewMock, terminalStateCallback } = vi.hoisted(() => ({
	deleteMock: vi.fn(),
	getMock: vi.fn(),
	postMock: vi.fn(),
	scrollIntoViewMock: vi.fn(),
	terminalStateCallback: { value: undefined as ((state: string) => void) | undefined },
}));
vi.mock("../../lib/api-client", () => ({
	apiClient: { DELETE: deleteMock, GET: getMock, POST: postMock },
	apiErrorCode: (error: { code?: string }) => error?.code,
	apiErrorMessage: () => "request failed",
	getApiBaseUrl: () => "http://127.0.0.1:3001",
	hasTrustedApiBaseUrl: () => true,
}));

vi.mock("../TerminalPane", () => ({
	TerminalPane: ({ onTerminalStateChange }: { onTerminalStateChange?: (state: string) => void }) => {
		terminalStateCallback.value = onTerminalStateChange;
		return <div data-testid="inline-terminal-body" />;
	},
}));

const profileResponse = {
	profiles: [{
		id: "existing",
		label: "Existing Codex profile",
		source: "existing",
		status: "valid",
		reasonCode: "profile_valid",
		reason: "available",
		authentication: { state: "unauthorized", freshness: "fresh", checkedAt: null, attemptedAt: null, reasonCode: "unauthorized", reason: "signed out" },
		authMethod: "unknown",
		usableByCurrentLaunches: true,
	}],
	capabilities: {
		accountRead: { state: "supported", reasonCode: "supported", reason: "available" },
		browserLogin: { state: "supported", reasonCode: "supported", reason: "available" },
	},
};

beforeEach(() => {
	Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
		configurable: true,
		value: scrollIntoViewMock,
	});
	scrollIntoViewMock.mockReset();
	useUiStore.setState({
		settingsModal: { scope: "global", section: "agents" },
		activeShellTerminalHandleId: null,
		codexProfileLoginTerminal: null,
	});
	getMock.mockReset().mockResolvedValue({ data: profileResponse });
	deleteMock.mockReset().mockResolvedValue({});
	terminalStateCallback.value = undefined;
	postMock.mockReset().mockImplementation((path: string) => {
		if (path.endsWith("/ensure")) return Promise.resolve({ data: profileResponse });
		if (path.endsWith("/login-terminal")) return Promise.resolve({ data: {
			profileId: "existing",
			shellTerminal: { handleId: "shellterm-login-1", workingDir: "/profiles/existing", title: "Codex login", createdAt: "2026-08-29T12:00:00Z" },
		} });
		return Promise.resolve({ data: {} });
	});
});

it("opens a profile-scoped login terminal inline without leaving settings", async () => {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const openExternal = vi.spyOn(aoBridge.app, "openExternal").mockResolvedValue(undefined);
	render(<QueryClientProvider client={queryClient}><CodexProfilesSection /></QueryClientProvider>);
	await screen.findByText("Existing Codex profile");
	expect(screen.getByText("Signed out")).toBeInTheDocument();
	expect(screen.getByText("Used by current Codex sessions")).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
	await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/v1/agents/codex/profiles/{profileId}/login-terminal", { params: { path: { profileId: "existing" } } }));
	expect(openExternal).not.toHaveBeenCalled();
	expect(useUiStore.getState().activeShellTerminalHandleId).toBeNull();
	expect(useUiStore.getState().codexProfileLoginTerminal).toMatchObject({
		profileId: "existing",
		phase: "running",
		terminal: { handleId: "shellterm-login-1" },
	});
	expect(useUiStore.getState().settingsModal).toEqual({ scope: "global", section: "agents" });
	expect(screen.getByTestId("codex-profile-login-terminal")).toBeInTheDocument();
	expect(screen.getByTestId("inline-terminal-body")).toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Add profile" })).toBeDisabled();
	expect(screen.getByRole("button", { name: "Codex 1 profile" })).toBeDisabled();
	openExternal.mockRestore();
});

it("renders profile icons in fixed circular bordered avatars", async () => {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(<QueryClientProvider client={queryClient}><CodexProfilesSection /></QueryClientProvider>);
	await screen.findByText("Existing Codex profile");
	const avatar = screen.getByTestId("codex-profile-avatar");
	expect(avatar).toHaveClass("size-9", "shrink-0", "self-center", "rounded-full", "border", "border-border");
	expect(avatar).not.toHaveClass("mt-0.5", "self-start", "rounded-md", "p-2");
});

it("groups compact profile rows under the Codex provider", async () => {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(<QueryClientProvider client={queryClient}><CodexProfilesSection /></QueryClientProvider>);
	await screen.findByText("Existing Codex profile");
	const provider = screen.getByRole("region", { name: "Codex" });
	expect(provider).toHaveAttribute("data-agent-provider", "codex");
	expect(provider).toHaveTextContent("1 profile");
	expect(provider.querySelector("[data-profile-id='existing']")).toBeInTheDocument();
});

it("collapses and expands the Codex provider group", async () => {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(<QueryClientProvider client={queryClient}><CodexProfilesSection /></QueryClientProvider>);
	await screen.findByText("Existing Codex profile");
	const toggle = screen.getByRole("button", { name: "Codex 1 profile" });
	expect(toggle).toHaveAttribute("aria-expanded", "true");

	fireEvent.click(toggle);
	expect(toggle).toHaveAttribute("aria-expanded", "false");
	expect(screen.queryByText("Existing Codex profile")).not.toBeInTheDocument();

	fireEvent.click(toggle);
	expect(toggle).toHaveAttribute("aria-expanded", "true");
	expect(screen.getByText("Existing Codex profile")).toBeInTheDocument();
});

it("expands only the affected profile and disables other sign-in actions", async () => {
	const managed = {
		...profileResponse.profiles[0],
		id: "72d4db6e-da2c-414c-a6a9-fdbd09a006b6",
		label: "Work",
		source: "managed",
		usableByCurrentLaunches: false,
	};
	const twoProfiles = { ...profileResponse, profiles: [...profileResponse.profiles, managed] };
	getMock.mockResolvedValue({ data: twoProfiles });
	postMock.mockImplementation((path: string) => {
		if (path.endsWith("/ensure")) return Promise.resolve({ data: twoProfiles });
		if (path.endsWith("/login-terminal")) return Promise.resolve({ data: {
			profileId: "existing",
			shellTerminal: { handleId: "shellterm-login-1", workingDir: "/profiles/existing", title: "Codex login", createdAt: "2026-08-29T12:00:00Z" },
		} });
		return Promise.resolve({ data: {} });
	});
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(<QueryClientProvider client={queryClient}><CodexProfilesSection /></QueryClientProvider>);
	await screen.findByText("Work");
	const signInButtons = screen.getAllByRole("button", { name: "Sign in" });
	fireEvent.click(signInButtons[0]);

	const panel = await screen.findByTestId("codex-profile-login-terminal");
	expect(panel.closest("[data-profile-id]")).toHaveAttribute("data-profile-id", "existing");
	expect(screen.getAllByRole("button", { name: "Sign in" })).toHaveLength(1);
	expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
});

it("creates a managed profile, then opens its login terminal", async () => {
	const managed = { ...profileResponse.profiles[0], id: "72d4db6e-da2c-414c-a6a9-fdbd09a006b6", label: "Work", source: "managed", usableByCurrentLaunches: false };
	postMock.mockImplementation((path: string) => {
		if (path.endsWith("/ensure")) return Promise.resolve({ data: profileResponse });
		if (path === "/api/v1/agents/codex/profiles") return Promise.resolve({ data: managed });
		if (path.endsWith("/login-terminal")) return Promise.resolve({ data: {
			profileId: managed.id,
			shellTerminal: { handleId: "shellterm-login-2", workingDir: "/profiles/work", title: "Codex login - Work", createdAt: "2026-08-29T12:00:00Z" },
		} });
		return Promise.resolve({ data: {} });
	});
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const openExternal = vi.spyOn(aoBridge.app, "openExternal").mockResolvedValue(undefined);
	render(<QueryClientProvider client={queryClient}><CodexProfilesSection /></QueryClientProvider>);
	await screen.findByText("Existing Codex profile");
	fireEvent.click(screen.getByRole("button", { name: "Add profile" }));
	fireEvent.change(screen.getByRole("textbox", { name: "Profile label" }), { target: { value: "Work" } });
	fireEvent.click(screen.getByRole("button", { name: "Create" }));
	await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/v1/agents/codex/profiles", { body: { label: "Work" } }));
	await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/v1/agents/codex/profiles/{profileId}/login-terminal", { params: { path: { profileId: managed.id } } }));
	expect(openExternal).not.toHaveBeenCalled();
	expect(useUiStore.getState().codexProfileLoginTerminal).toMatchObject({
		profileId: managed.id,
		terminal: { handleId: "shellterm-login-2" },
	});
	expect(screen.getByTestId("codex-profile-login-terminal")).toBeInTheDocument();
	expect(scrollIntoViewMock).toHaveBeenCalledOnce();
	expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: "smooth", block: "nearest" });
	expect(screen.getByText("AO-managed")).toBeInTheDocument();
	expect(await screen.findByText("Not available for task launch yet")).toBeInTheDocument();
	openExternal.mockRestore();
});

it("verifies once after terminal exit, cleans up, and leaves the signed-in card visible", async () => {
	const setIntervalSpy = vi.spyOn(window, "setInterval");
	const authorized = {
		...profileResponse,
		profiles: [{
			...profileResponse.profiles[0],
			authentication: {
				...profileResponse.profiles[0].authentication,
				state: "authorized",
				freshness: "fresh",
				reasonCode: "authorized",
				reason: "signed in",
			},
			authMethod: "chatgpt",
			accountEmail: "user@example.com",
		}],
	};
	postMock.mockImplementation((path: string, options?: { body?: { forceAuthenticationRefresh?: boolean } }) => {
		if (path.endsWith("/ensure")) {
			return Promise.resolve({ data: options?.body?.forceAuthenticationRefresh ? authorized : profileResponse });
		}
		if (path.endsWith("/login-terminal")) return Promise.resolve({ data: {
			profileId: "existing",
			shellTerminal: { handleId: "shellterm-login-1", workingDir: "/profiles/existing", title: "Codex login", createdAt: "2026-08-29T12:00:00Z" },
		} });
		return Promise.resolve({ data: {} });
	});
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(<QueryClientProvider client={queryClient}><CodexProfilesSection /></QueryClientProvider>);
	await screen.findByText("Existing Codex profile");
	fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
	await screen.findByTestId("inline-terminal-body");

	act(() => terminalStateCallback.value?.("exited"));

	await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/v1/agents/codex/profiles/ensure", {
		body: { profileIds: ["existing"], purpose: "display", forceAuthenticationRefresh: true },
	}));
	await waitFor(() => expect(useUiStore.getState().codexProfileLoginTerminal).toBeNull());
	expect(screen.queryByTestId("codex-profile-login-terminal")).not.toBeInTheDocument();
	expect(await screen.findByText(/Signed in · user@example.com · chatgpt/)).toBeInTheDocument();
	expect(deleteMock).toHaveBeenCalledTimes(1);
	const forcedEnsures = postMock.mock.calls.filter(([, options]) => options?.body?.forceAuthenticationRefresh);
	expect(forcedEnsures).toHaveLength(1);
	expect(setIntervalSpy.mock.calls.some(([, delay]) => delay === 2_000)).toBe(false);
	setIntervalSpy.mockRestore();
});

it("retains terminal output with Retry after Codex remains signed out", async () => {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(<QueryClientProvider client={queryClient}><CodexProfilesSection /></QueryClientProvider>);
	await screen.findByText("Existing Codex profile");
	fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
	await screen.findByTestId("inline-terminal-body");

	act(() => terminalStateCallback.value?.("exited"));

	await screen.findAllByText("Codex still reports this profile as signed out.");
	expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
	expect(screen.getAllByRole("button", { name: "Close sign-in" }).length).toBeGreaterThan(0);
	expect(screen.getByTestId("inline-terminal-body")).toBeInTheDocument();
});

it("retains an unverifiable terminal and checks again without starting a replacement login", async () => {
	const unknown = {
		...profileResponse,
		profiles: [{
			...profileResponse.profiles[0],
			authentication: {
				...profileResponse.profiles[0].authentication,
				state: "unknown",
				freshness: "fresh",
				reasonCode: "auth_check_inconclusive",
				reason: "unknown",
			},
		}],
	};
	postMock.mockImplementation((path: string, options?: { body?: { forceAuthenticationRefresh?: boolean } }) => {
		if (path.endsWith("/ensure")) return Promise.resolve({ data: options?.body?.forceAuthenticationRefresh ? unknown : profileResponse });
		if (path.endsWith("/login-terminal")) return Promise.resolve({ data: {
			profileId: "existing",
			shellTerminal: { handleId: "shellterm-login-1", workingDir: "/profiles/existing", title: "Codex login", createdAt: "2026-08-29T12:00:00Z" },
		} });
		return Promise.resolve({ data: {} });
	});
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(<QueryClientProvider client={queryClient}><CodexProfilesSection /></QueryClientProvider>);
	await screen.findByText("Existing Codex profile");
	fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
	await screen.findByTestId("inline-terminal-body");

	act(() => terminalStateCallback.value?.("error"));

	await screen.findAllByText("AO could not verify the current authentication state.");
	const loginStartsBefore = postMock.mock.calls.filter(([path]) => String(path).endsWith("/login-terminal")).length;
	fireEvent.click(screen.getByRole("button", { name: "Check again" }));
	await waitFor(() => {
		const forcedEnsures = postMock.mock.calls.filter(([, options]) => options?.body?.forceAuthenticationRefresh);
		expect(forcedEnsures).toHaveLength(2);
	});
	expect(postMock.mock.calls.filter(([path]) => String(path).endsWith("/login-terminal"))).toHaveLength(loginStartsBefore);
	expect(screen.getByTestId("inline-terminal-body")).toBeInTheDocument();
});

it("cleans up the old terminal before retrying one signed-out profile", async () => {
	let loginAttempt = 0;
	postMock.mockImplementation((path: string) => {
		if (path.endsWith("/ensure")) return Promise.resolve({ data: profileResponse });
		if (path.endsWith("/login-terminal")) {
			loginAttempt += 1;
			return Promise.resolve({ data: {
				profileId: "existing",
				shellTerminal: { handleId: `shellterm-login-${loginAttempt}`, workingDir: "/profiles/existing", title: "Codex login", createdAt: `2026-08-29T12:00:0${loginAttempt}Z` },
			} });
		}
		return Promise.resolve({ data: {} });
	});
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(<QueryClientProvider client={queryClient}><CodexProfilesSection /></QueryClientProvider>);
	await screen.findByText("Existing Codex profile");
	fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
	await screen.findByTestId("inline-terminal-body");
	act(() => terminalStateCallback.value?.("exited"));
	await screen.findByRole("button", { name: "Retry" });

	fireEvent.click(screen.getByRole("button", { name: "Retry" }));

	await waitFor(() => expect(useUiStore.getState().codexProfileLoginTerminal?.terminal.handleId).toBe("shellterm-login-2"));
	expect(deleteMock).toHaveBeenCalledWith("/api/v1/shell-terminals/{handleId}", {
		params: { path: { handleId: "shellterm-login-1" } },
	});
});

it("uses one upper-bound timeout and retains the profile card", async () => {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(<QueryClientProvider client={queryClient}><CodexProfilesSection /></QueryClientProvider>);
	await screen.findByText("Existing Codex profile");
	act(() => useUiStore.setState({
		codexProfileLoginTerminal: {
			profileId: "existing",
			terminal: { handleId: "shellterm-timeout", title: "Codex login", createdAt: "2026-08-29T12:00:00Z" },
			phase: "running",
			startedAt: Date.now() - (15 * 60_000),
		},
	}));

	await waitFor(() => expect(useUiStore.getState().codexProfileLoginTerminal?.phase).toBe("timed_out"));
	expect(screen.getAllByText("Sign-in timed out. Retry or close this terminal.")).toHaveLength(2);
	expect(screen.getByText("Existing Codex profile")).toBeInTheDocument();
	expect(deleteMock).toHaveBeenCalledWith("/api/v1/shell-terminals/{handleId}", {
		params: { path: { handleId: "shellterm-timeout" } },
	});
});

it("keeps terminal login available when structured authentication is unknown", async () => {
	const unavailable = {
		...profileResponse,
		profiles: [{
			...profileResponse.profiles[0],
			authentication: {
				...profileResponse.profiles[0].authentication,
				state: "unknown",
				reasonCode: "auth_check_unsupported",
				reason: "Structured authentication is not supported by this Codex version.",
			},
		}],
		capabilities: {
			...profileResponse.capabilities,
			accountRead: { state: "unsupported", reasonCode: "unsupported", reason: "Account discovery unavailable." },
			browserLogin: { state: "unknown", reasonCode: "unknown", reason: "Capability check unavailable." },
		},
	};
	getMock.mockResolvedValue({ data: unavailable });
	postMock.mockResolvedValue({ data: unavailable });
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(<QueryClientProvider client={queryClient}><CodexProfilesSection /></QueryClientProvider>);
	await screen.findByText("Existing Codex profile");
	expect(screen.getByText("Authentication unknown")).toBeInTheDocument();
	expect(screen.queryByText("Capability check unavailable.")).not.toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Add profile" })).toBeEnabled();
	expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
});
