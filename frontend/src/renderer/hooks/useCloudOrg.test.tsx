import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const { cloudCpState, createOrganizationMock, meMock } = vi.hoisted(() => ({
	cloudCpState: { ready: true },
	createOrganizationMock: vi.fn(),
	meMock: vi.fn(),
}));

vi.mock("./useCloudCp", () => ({
	useCloudCp: () => ({
		client: { me: meMock, createOrganization: createOrganizationMock },
		ready: cloudCpState.ready,
		baseUrl: "https://cp.example.com",
	}),
}));

import { orgDisplayNameForAccount, useCloudOrg } from "./useCloudOrg";

function wrapper({ children }: { children: ReactNode }) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const user = { id: "user-1", email: "priya@acme.dev", displayName: "Priya Rao", authProvider: "workos" };

beforeEach(() => {
	cloudCpState.ready = true;
	meMock.mockReset();
	createOrganizationMock.mockReset();
});

describe("useCloudOrg", () => {
	it("uses the first organization from /me when one exists", async () => {
		const first = { id: "org-1", slug: "acme", displayName: "Acme", role: "admin" };
		meMock.mockResolvedValue({
			user,
			organizations: [first, { id: "org-2", slug: "other", displayName: "Other", role: "member" }],
		});

		const { result } = renderHook(() => useCloudOrg(), { wrapper });

		await waitFor(() => expect(result.current.org).toEqual(first));
		expect(createOrganizationMock).not.toHaveBeenCalled();
	});

	it("creates an organization named from the account when the user has none", async () => {
		const created = { id: "org-new", slug: "priya-rao", displayName: "Priya Rao", role: "admin" };
		meMock.mockResolvedValue({ user, organizations: [] });
		createOrganizationMock.mockResolvedValue({ organization: created });

		const { result } = renderHook(() => useCloudOrg(), { wrapper });

		await waitFor(() => expect(result.current.org).toEqual(created));
		expect(createOrganizationMock).toHaveBeenCalledWith({ displayName: "Priya Rao" });
	});

	it("does nothing while the cloud client is not ready", async () => {
		cloudCpState.ready = false;

		const { result } = renderHook(() => useCloudOrg(), { wrapper });

		// Give a disabled query a beat to (not) fire.
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(meMock).not.toHaveBeenCalled();
		expect(result.current.org).toBeUndefined();
		expect(result.current.ready).toBe(false);
	});
});

describe("orgDisplayNameForAccount", () => {
	it("prefers the display name, then the email local part, then a fallback", () => {
		expect(orgDisplayNameForAccount({ displayName: " Priya Rao ", email: "priya@acme.dev" })).toBe("Priya Rao");
		expect(orgDisplayNameForAccount({ displayName: "", email: "priya@acme.dev" })).toBe("priya");
		expect(orgDisplayNameForAccount({ displayName: " ", email: "@" })).toBe("Workspace");
	});

	it("stays within the control plane's 80-character cap", () => {
		expect(orgDisplayNameForAccount({ displayName: "x".repeat(200), email: "a@b.c" })).toHaveLength(80);
	});
});
