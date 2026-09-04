import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { CursorSubscriptionUsageSection } from "./CursorSubscriptionUsageSection";

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }));

vi.mock("../../lib/api-client", () => ({
	apiClient: { GET: getMock, POST: postMock },
	apiErrorMessage: () => "request failed",
}));

const cursorReadiness = {
	agents: [{
		id: "cursor", label: "Cursor", usageCount: 2, effectiveReadiness: "ready",
		installation: { state: "installed", freshness: "fresh", checkedAt: null, attemptedAt: null, reasonCode: "installed", reason: "Installed." },
		authentication: { state: "authorized", freshness: "fresh", checkedAt: null, attemptedAt: null, reasonCode: "authorized", reason: "Signed in." },
		subscriptionUsage: {
			state: "available", freshness: "fresh", plan: "Pro+", usedPercent: 5, remainingPercent: 95,
			observedAt: "2026-09-04T08:00:00Z", checkedAt: "2026-09-04T08:00:00Z", attemptedAt: "2026-09-04T08:00:00Z",
			reasonCode: "subscription_usage_available", reason: "Cursor subscription capacity is available.",
			limits: [
				{ id: "included", name: "Included", state: "active", usedPercent: 5, remainingPercent: 95, resetsAt: "2026-09-25T00:00:00Z" },
				{ id: "on_demand", name: "On-Demand", state: "active", usedValue: 0, totalValue: 1, remainingValue: 1, usedPercent: 0, remainingPercent: 100, unit: "USD" },
			],
		},
	}],
};

beforeEach(() => {
	getMock.mockReset().mockResolvedValue({ data: cursorReadiness });
	postMock.mockReset().mockResolvedValue({ data: cursorReadiness });
});

it("shows Cursor capacity in the same settings vocabulary as Codex", async () => {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(<QueryClientProvider client={queryClient}><CursorSubscriptionUsageSection /></QueryClientProvider>);

	expect(await screen.findByText("Pro+")).toBeInTheDocument();
	expect(screen.getAllByText(/95% remaining/).length).toBeGreaterThan(0);
	expect(screen.getByText("Included")).toBeInTheDocument();
	expect(screen.getByText("On-Demand")).toBeInTheDocument();
	expect(screen.getByText("$0.00 / $1.00")).toBeInTheDocument();
	await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/v1/agents/readiness/ensure", { body: { agentIds: ["cursor"], purpose: "display" } }));
});
