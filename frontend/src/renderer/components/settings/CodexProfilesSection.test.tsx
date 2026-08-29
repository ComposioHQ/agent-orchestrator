import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { aoBridge } from "../../lib/bridge";
import { CodexProfilesSection } from "./CodexProfilesSection";

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }));
vi.mock("../../lib/api-client", () => ({
	apiClient: { GET: getMock, POST: postMock },
	apiErrorMessage: () => "request failed",
	getApiBaseUrl: () => "http://127.0.0.1:3001",
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
		capacity: { state: "unknown", freshness: "stale", reasonCode: "capacity_skipped_signed_out", reason: "Sign in to see capacity.", additionalBuckets: [] },
	}],
	capabilities: {
		accountRead: { state: "supported", reasonCode: "supported", reason: "available" },
		browserLogin: { state: "supported", reasonCode: "supported", reason: "available" },
		capacityRead: { state: "supported", reasonCode: "supported", reason: "available" },
	},
};

beforeEach(() => {
	getMock.mockReset().mockResolvedValue({ data: profileResponse });
	postMock.mockReset().mockImplementation((path: string) => {
		if (path.endsWith("/ensure")) return Promise.resolve({ data: profileResponse });
		if (path.endsWith("/login")) return Promise.resolve({ data: { operationId: "op-1", profileId: "existing", status: "pending", authUrl: "https://auth.example.test" } });
		return Promise.resolve({ data: {} });
	});
});

it("shows signed-out existing profile and opens structured browser login", async () => {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const openExternal = vi.spyOn(aoBridge.app, "openExternal").mockResolvedValue(undefined);
	render(<QueryClientProvider client={queryClient}><CodexProfilesSection /></QueryClientProvider>);
	await screen.findByText("Existing Codex profile");
	expect(screen.getByText("Signed out")).toBeInTheDocument();
	expect(screen.getByText("Available for Codex task launches")).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
	await waitFor(() => expect(openExternal).toHaveBeenCalledWith("https://auth.example.test"));
	expect(postMock).toHaveBeenCalledWith("/api/v1/agents/codex/profiles/{profileId}/login", { params: { path: { profileId: "existing" } } });
	openExternal.mockRestore();
});

it("renders the profile icon without a background wrapper", async () => {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(<QueryClientProvider client={queryClient}><CodexProfilesSection /></QueryClientProvider>);
	await screen.findByText("Existing Codex profile");
	const icon = screen.getByTestId("codex-profile-icon");
	expect(icon.tagName).toBe("svg");
	expect(icon).toHaveClass("size-5", "shrink-0", "text-muted-foreground");
	expect(icon).not.toHaveClass("rounded-md", "bg-muted", "p-2");
});

it("creates a managed profile, then explicitly starts its browser login", async () => {
	const managed = { ...profileResponse.profiles[0], id: "72d4db6e-da2c-414c-a6a9-fdbd09a006b6", label: "Work", source: "managed", usableByCurrentLaunches: true };
	postMock.mockImplementation((path: string) => {
		if (path.endsWith("/ensure")) return Promise.resolve({ data: profileResponse });
		if (path === "/api/v1/agents/codex/profiles") return Promise.resolve({ data: managed });
		if (path.endsWith("/login")) return Promise.resolve({ data: { operationId: "op-2", profileId: managed.id, status: "pending", authUrl: "https://auth.example.test/work" } });
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
	await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/v1/agents/codex/profiles/{profileId}/login", { params: { path: { profileId: managed.id } } }));
	expect(openExternal).toHaveBeenCalledWith("https://auth.example.test/work");
	expect((await screen.findAllByText("Available for Codex task launches"))).not.toHaveLength(0);
	openExternal.mockRestore();
});

it("disables profile creation when browser login capability is not confirmed", async () => {
	const unavailable = {
		...profileResponse,
		capabilities: {
			...profileResponse.capabilities,
			browserLogin: { state: "unknown", reasonCode: "unknown", reason: "Capability check unavailable." },
		},
	};
	getMock.mockResolvedValue({ data: unavailable });
	postMock.mockResolvedValue({ data: unavailable });
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(<QueryClientProvider client={queryClient}><CodexProfilesSection /></QueryClientProvider>);
	await screen.findByText("Capability check unavailable.");
	expect(screen.getByRole("button", { name: "Add profile" })).toBeDisabled();
});
