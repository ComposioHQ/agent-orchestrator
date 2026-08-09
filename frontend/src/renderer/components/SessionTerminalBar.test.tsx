import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionTerminalBar } from "./SessionTerminalBar";
import { SessionTopbarHost, SessionTopbarProvider } from "./SessionTopbarPortal";

describe("SessionTerminalBar", () => {
	it("portals the terminal row below the main session header", () => {
		render(
			<SessionTopbarProvider>
				<SessionTopbarHost data-testid="terminal-bar-host" />
				<SessionTerminalBar>
					<span>Terminal tabs</span>
				</SessionTerminalBar>
			</SessionTopbarProvider>,
		);

		const row = screen.getByTestId("session-terminal-bar");
		expect(screen.getByTestId("terminal-bar-host")).toContainElement(row);
		expect(row).toHaveTextContent("Terminal tabs");
		expect(row).toHaveClass("h-inspector-tabs");
	});

	it("renders the same row inside the terminal pane during fullscreen", () => {
		render(
			<SessionTopbarProvider>
				<SessionTerminalBar fullscreen>
					<span>Fullscreen terminal tabs</span>
				</SessionTerminalBar>
			</SessionTopbarProvider>,
		);

		const row = screen.getByTestId("session-terminal-bar");
		expect(row).toHaveTextContent("Fullscreen terminal tabs");
		expect(row).toHaveAttribute("data-session-terminal-bar");
	});
});
