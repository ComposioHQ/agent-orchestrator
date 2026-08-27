import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MockAgentCatalog = {
	authorized: { id: string; label: string; authStatus: string }[];
	installed: { id: string; label: string; authStatus: string }[];
	supported: { id: string; label: string }[];
};

type MockAgentsQuery = {
	data: MockAgentCatalog | undefined;
	isFetching: boolean;
	isLoading: boolean;
};

const routeMocks = vi.hoisted(() => ({
	navigate: vi.fn(),
	agentsQuery: {} as MockAgentsQuery,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	createFileRoute: () => (options: unknown) => ({ options }),
	useNavigate: () => routeMocks.navigate,
}));

vi.mock("../hooks/useAgentsQuery", () => ({
	refreshAgentsIfStale: vi.fn().mockResolvedValue(undefined),
	useAgentsQuery: () => routeMocks.agentsQuery,
}));

import { OnboardingPage } from "../components/OnboardingPage";

async function renderOnboarding() {
	await act(async () => {
		render(<OnboardingPage />);
	});
}

beforeEach(() => {
	routeMocks.navigate.mockReset();
	routeMocks.agentsQuery = {
		data: {
			authorized: [
				{ id: "claude-code", label: "Claude Code", authStatus: "authorized" },
				{ id: "codex", label: "Codex", authStatus: "authorized" },
			],
			installed: [
				{ id: "claude-code", label: "Claude Code", authStatus: "authorized" },
				{ id: "codex", label: "Codex", authStatus: "authorized" },
				{ id: "kiro", label: "Kiro", authStatus: "unknown" },
			],
			supported: [
				{ id: "claude-code", label: "Claude Code" },
				{ id: "codex", label: "Codex" },
				{ id: "kiro", label: "Kiro" },
				{ id: "cursor", label: "Cursor" },
			],
		},
		isFetching: false,
		isLoading: false,
	};
});

describe("onboarding route", () => {
	it("does not leave the agent list in a permanent checking state", async () => {
		vi.useFakeTimers();
		try {
			routeMocks.agentsQuery = { data: undefined, isFetching: true, isLoading: true };
			await renderOnboarding();
			await act(async () => {
				screen.getByRole("button", { name: "Continue" }).click();
			});
			await act(async () => {
				screen.getByRole("button", { name: "Choose agents" }).click();
			});

			expect(screen.getAllByLabelText("Checking availability")).not.toHaveLength(0);
			await act(async () => {
				vi.advanceTimersByTime(2_500);
			});
			expect(screen.queryByLabelText("Checking availability")).not.toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Claude Code" })).toBeEnabled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("walks through the preview steps and requires separate agent role selections", async () => {
		const user = userEvent.setup();
		await renderOnboarding();

		expect(screen.getByRole("heading", { name: "Stop babysitting agents." })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
		expect(screen.getByText("Board")).toBeInTheDocument();
		expect(screen.getByText("Idle / Working")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Continue" }));
		expect(await screen.findByRole("heading", { name: "Keep the loop moving." })).toBeInTheDocument();
		expect(screen.getAllByText("Reviews")).not.toHaveLength(0);

		await user.click(screen.getByRole("button", { name: "Choose agents" }));
		expect(await screen.findByRole("heading", { name: "Pick your orchestrator agent." })).toBeInTheDocument();

		const nextButton = screen.getByRole("button", { name: "Choose workers" });
		expect(nextButton).toBeDisabled();
		const agentPicker = screen.getByRole("region", { name: "Pick your orchestrator agent." });
		const orchestratorPicker = within(agentPicker).getByRole("region", { name: "Orchestrator agent" });
		expect(orchestratorPicker).toHaveTextContent("Claude Code");
		expect(within(orchestratorPicker).getByRole("button", { name: "Install Cursor" })).toBeEnabled();
		expect(within(orchestratorPicker).getByRole("button", { name: "Kiro" })).toBeEnabled();
		await user.click(within(orchestratorPicker).getByRole("button", { name: "Claude Code" }));
		expect(nextButton).toBeEnabled();
		await user.click(nextButton);

		expect(await screen.findByRole("heading", { name: "Pick your worker agents." })).toBeInTheDocument();
		const workerPicker = screen.getByRole("region", { name: "Worker agents" });
		const projectButton = screen.getByRole("button", { name: "Add a project" });
		expect(projectButton).toBeDisabled();
		expect(within(workerPicker).getByRole("button", { name: "Install Cursor" })).toBeEnabled();
		await user.click(within(workerPicker).getByRole("button", { name: "Codex" }));
		expect(projectButton).toBeEnabled();

		await user.click(projectButton);
		expect(await screen.findByRole("heading", { name: "Add your first project." })).toBeInTheDocument();
	});

	it("supports back navigation and opens the dashboard from the final step", async () => {
		const user = userEvent.setup();
		await renderOnboarding();

		await user.click(screen.getByRole("button", { name: "Continue" }));
		expect(await screen.findByRole("heading", { name: "Keep the loop moving." })).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Back" }));
		expect(await screen.findByRole("heading", { name: "Stop babysitting agents." })).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Continue" }));
		await user.click(await screen.findByRole("button", { name: "Choose agents" }));
		const agentPicker = await screen.findByRole("region", { name: "Pick your orchestrator agent." });
		await user.click(within(within(agentPicker).getByRole("region", { name: "Orchestrator agent" })).getByRole("button", { name: "Codex" }));
		await user.click(screen.getByRole("button", { name: "Choose workers" }));
		const workerPicker = await screen.findByRole("region", { name: "Worker agents" });
		await user.click(within(workerPicker).getByRole("button", { name: "Claude Code" }));
		await user.click(screen.getByRole("button", { name: "Add a project" }));
		await user.click(screen.getByRole("button", { name: "Open AO" }));
		await waitFor(() => expect(routeMocks.navigate).toHaveBeenCalledWith({ to: "/" }));
	});
});
