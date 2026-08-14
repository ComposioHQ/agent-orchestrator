import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionWorkspaceTopbarView, StartupLoaderView } from "./WorkspaceChromeView";

describe("workspace chrome views", () => {
	it("composes terminal tabs, controls, and actions in one shared toolbar", () => {
		render(
			<SessionWorkspaceTopbarView
				actions={<button type="button">Share</button>}
				terminalControls={<button type="button">Zoom</button>}
				terminalTabs={<button type="button">Agent</button>}
			/>,
		);

		expect(screen.getByTestId("session-workspace-topbar")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Agent" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Zoom" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
	});

	it("cycles startup phrases while preserving a client test id", () => {
		vi.useFakeTimers();
		render(
			<StartupLoaderView
				ariaLabel="Loading AO"
				brand="Agent Orchestrator"
				logo={<span>AO</span>}
				phraseIntervalMs={100}
				phrases={["Starting", "Ready"]}
				testId="client-loader"
			/>,
		);

		expect(screen.getByTestId("client-loader")).toHaveTextContent("Starting");
		act(() => vi.advanceTimersByTime(100));
		expect(screen.getByTestId("client-loader")).toHaveTextContent("Ready");
		vi.useRealTimers();
	});
});
