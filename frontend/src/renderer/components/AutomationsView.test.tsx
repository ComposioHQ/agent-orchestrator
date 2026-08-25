import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationsView } from "./AutomationsView";

const mocks = vi.hoisted(() => ({
	automations: [] as Array<Record<string, unknown>>,
	update: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../hooks/useWorkspaceQuery", () => ({ useWorkspaceQuery: () => ({ data: [{ id: "demo", name: "Demo" }] }) }));
vi.mock("../hooks/useAutomations", () => ({
	useAutomations: () => ({ data: mocks.automations, isLoading: false, error: null }),
	useCreateAutomation: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
	useUpdateAutomation: () => ({ mutateAsync: mocks.update, isPending: false, error: null }),
	useDeleteAutomation: () => ({ mutate: vi.fn(), isPending: false, error: null }),
	useAutomationRuns: () => ({ data: [], isLoading: false }),
}));

describe("AutomationsView", () => {
	beforeEach(() => { mocks.automations = []; mocks.update.mockReset(); });

	it("shows a discoverable empty state and create action", () => {
		render(<AutomationsView />);
		expect(screen.getByRole("heading", { name: "Automations" })).toBeInTheDocument();
		expect(screen.getByText("No automations yet")).toBeInTheDocument();
		expect(screen.getAllByRole("button", { name: /create automation/i })).not.toHaveLength(0);
	});

	it("exposes accessible toggle, delete, and run-history controls", () => {
		mocks.automations = [{ id: "automation-1", projectId: "demo", displayName: "Morning triage", prompt: "Review", kind: "worker", rrule: "FREQ=DAILY", timezone: "UTC", enabled: true, nextRunAt: "2026-08-27T09:00:00Z", createdAt: "2026-08-26T09:00:00Z", updatedAt: "2026-08-26T09:00:00Z" }];
		render(<AutomationsView />);
		expect(screen.getByRole("switch", { name: "Disable Morning triage" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Delete Morning triage" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Show run history for Morning triage" })).toBeInTheDocument();
	});
});
