import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KimiSubscriptionGroup } from "./KimiSubscriptionGroup";

const refresh = vi.fn();
let queryData: Record<string, unknown> | undefined;
let refreshError: Error | null;

vi.mock("../../hooks/useKimiSubscription", () => ({
	useKimiSubscriptionQuery: () => ({ data: queryData }),
	useRefreshKimiSubscription: () => ({ mutate: refresh, isPending: false, error: refreshError }),
}));

describe("KimiSubscriptionGroup", () => {
	beforeEach(() => {
		refresh.mockReset();
		refreshError = null;
		queryData = undefined;
	});

	it("stays hidden when Kimi is missing, signed out, or custom configured", () => {
		queryData = { available: false };
		const { container } = render(<KimiSubscriptionGroup />);
		expect(container).toBeEmptyDOMElement();
	});

	it("renders hosted Kimi usage in the Codex subscription style", () => {
		queryData = {
			available: true,
			capacity: {
				state: "available", freshness: "fresh", plan: "Ultra", authMethod: "oauth",
				usedPercent: 24, remainingPercent: 76, reasonCode: "kimi_subscription_available", reason: "available",
				limits: [{ name: "Weekly limit", usedPercent: 24, remainingPercent: 76, windowDurationMinutes: 10080, resetsAt: "2026-09-07T10:00:00Z" }],
			},
		};
		render(<KimiSubscriptionGroup />);
		expect(screen.getByText("Kimi")).toBeInTheDocument();
		expect(screen.getByText(/Ultra · OAuth · 76%/)).toBeInTheDocument();
		expect(screen.getByText("Ultra plan")).toBeInTheDocument();
		expect(screen.getByText("Weekly limit")).toBeInTheDocument();
		expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "76");
	});

	it("shows stale fallback state and supports a forced refresh", () => {
		queryData = {
			available: true,
			capacity: {
				state: "unknown", freshness: "stale", authMethod: "oauth",
				reasonCode: "kimi_subscription_check_failed", reason: "failed", limits: [],
			},
		};
		render(<KimiSubscriptionGroup />);
		expect(screen.getByText(/could not be refreshed/i)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Refresh Kimi subscription usage" }));
		expect(refresh).toHaveBeenCalledTimes(1);
	});
});
