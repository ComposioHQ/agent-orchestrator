import { render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	createFileRoute: () => (options: unknown) => ({
		options,
		useParams: () => ({ projectId: "p1" }),
	}),
}));

vi.mock("../components/ProjectControlCockpit", () => ({
	ProjectControlCockpit: ({ projectId }: { projectId: string }) => (
		<div data-project-id={projectId} data-testid="project-control-cockpit" />
	),
}));

vi.mock("../components/SessionsBoard", () => ({
	SessionsBoard: ({ projectId }: { projectId?: string }) => (
		<div data-project-id={projectId} data-testid="sessions-board" />
	),
}));

import { Route } from "../routes/_shell.projects.$projectId";

describe("project board route", () => {
	it("renders project control before the project-scoped board", () => {
		const Board = (Route as unknown as { options: { component: ComponentType } }).options.component;
		render(<Board />);

		const cockpit = screen.getByTestId("project-control-cockpit");
		const board = screen.getByTestId("sessions-board");
		expect(cockpit).toHaveAttribute("data-project-id", "p1");
		expect(board).toHaveAttribute("data-project-id", "p1");
		expect(cockpit.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});
});
