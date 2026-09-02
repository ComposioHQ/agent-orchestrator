import { beforeEach, describe, expect, it, vi } from "vitest";

const getMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/api-client", () => ({
	apiClient: { GET: (...args: unknown[]) => getMock(...args) },
}));

import { sessionUsageDetailQueryKey } from "./useSessionUsage";
// clientFor(LOCAL_HOST) is the client apiClient already was.
vi.mock("../lib/host-clients", () => ({
	clientFor: () => ({ GET: (...args: unknown[]) => getMock(...args) }),
}));

import {
	fetchSessionUsageSummaries,
	sessionUsageQueryRoot,
	sessionUsageQueryOptions,
} from "./useSessionUsageSummaries";

describe("session usage summaries", () => {
	beforeEach(() => {
		getMock.mockReset().mockResolvedValue({ data: { sessions: [] } });
	});

	it("fetches one project batch and relies on event invalidation", async () => {
		await fetchSessionUsageSummaries({ host: "local", id: "reverb" });

		expect(getMock).toHaveBeenCalledOnce();
		expect(getMock).toHaveBeenCalledWith("/api/v1/usage/sessions", {
			params: { query: { projectId: "reverb" } },
		});
		expect(sessionUsageQueryOptions({ host: "local", id: "reverb" })).not.toHaveProperty("refetchInterval");
	});

	// The detail query lives in useSessionUsage.ts and must stay beneath this
	// root, or a usage event invalidates the board summaries without touching
	// the inspector's open session.
	it("keeps the detail query beneath the shared usage query root", () => {
		expect(sessionUsageDetailQueryKey({ host: "local", id: "sess-1" })).toEqual([
			...sessionUsageQueryRoot,
			"detail",
			"local:sess-1",
		]);
	});
});
