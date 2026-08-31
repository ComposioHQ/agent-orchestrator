import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSummary } from "../types/workspace";

const routeMocks = vi.hoisted(() => ({
	navigate: vi.fn(),
	workspaces: [] as WorkspaceSummary[],
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useNavigate: () => routeMocks.navigate,
}));

vi.mock("../hooks/useWorkspaceQuery", () => ({
	useWorkspaceQuery: () => ({ data: routeMocks.workspaces, isSuccess: true }),
}));

vi.mock("../components/BoardEmptyStates", () => ({
	BoardWelcome: () => <div data-testid="board-welcome" />,
}));

import { HomePage } from "../components/HomePage";

beforeEach(() => {
	routeMocks.navigate.mockReset();
	routeMocks.workspaces = [];
});

describe("shell index route", () => {
	it("restores first-run onboarding when no projects exist", async () => {
		render(<HomePage />);

		expect(screen.getByTestId("board-welcome")).toBeInTheDocument();
		expect(screen.queryByText("Jump back right in")).not.toBeInTheDocument();
		expect(routeMocks.navigate).not.toHaveBeenCalled();
	});

	it("renders the home page instead of redirecting to a scratch board when projects exist", async () => {
		routeMocks.workspaces = [
			{
				id: "scratch",
				name: "Scratch",
				kind: "scratch",
				path: "/home/me/.ao/scratch/default",
				sessions: [],
			},
		];

		render(<HomePage />);

		expect(screen.getByText("Jump back right in")).toBeInTheDocument();
		expect(routeMocks.navigate).not.toHaveBeenCalled();
	});

	it("opens a project from the recent-project list", async () => {
		routeMocks.workspaces = [
			{ id: "scratch", name: "Scratch", kind: "scratch", path: "/scratch", sessions: [] },
			{ id: "proj-1", name: "Project One", kind: "single_repo", path: "/repo/project-one", sessions: [] },
		];

		render(<HomePage />);

		fireEvent.click(screen.getByRole("button", { name: /Project One/ }));
		expect(routeMocks.navigate).toHaveBeenCalledWith({
			to: "/projects/$projectId",
			params: { projectId: "proj-1" },
		});
	});
});
