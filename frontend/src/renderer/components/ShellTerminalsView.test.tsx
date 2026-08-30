import { render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "../stores/ui-store";
import { ShellTerminalsView } from "./ShellTerminalsView";
import { TooltipProvider } from "./ui/tooltip";

function render(ui: ReactElement) {
	return rtlRender(<TooltipProvider>{ui}</TooltipProvider>);
}

const terminalMocks = vi.hoisted(() => ({ data: [] as unknown[] }));

vi.mock("../hooks/useShellTerminals", () => ({
	useCloseShellTerminal: () => ({ mutate: vi.fn() }),
	useRenameShellTerminal: () => ({ mutate: vi.fn() }),
	useShellTerminals: () => ({ data: terminalMocks.data }),
}));

vi.mock("../lib/shell-context", () => ({
	useShell: () => ({ daemonStatus: { state: "ready" } }),
}));

vi.mock("./TerminalPane", () => ({ TerminalPane: () => <div>terminal body</div> }));

describe("ShellTerminalsView", () => {
	beforeEach(() => {
		terminalMocks.data = [];
		useUiStore.setState({ activeShellTerminalHandleId: null, agentAuthTerminalRequest: null });
	});

	it("points the empty state at the visible plus tab-strip control", () => {
		render(<ShellTerminalsView />);

		expect(screen.getByText("No terminals open")).toBeInTheDocument();
		expect(screen.getByText(/use the \+ button/i)).toBeInTheDocument();
		expect(screen.queryByText(/terminal button/i)).not.toBeInTheDocument();
	});

	it("keeps manual authentication guidance visible above its active terminal", () => {
		terminalMocks.data = [{
			handleId: "shellterm-qwen",
			workingDir: "/tmp/ao",
			title: "Set up Qwen",
			createdAt: "2026-08-31T00:00:00Z",
		}];
		useUiStore.setState({
			activeShellTerminalHandleId: "shellterm-qwen",
			agentAuthTerminalRequest: {
				agentId: "qwen",
				handleId: "shellterm-qwen",
				nonce: 1,
				guidance: "Run /auth to configure a provider",
			} as never,
		});

		render(<ShellTerminalsView />);

		expect(screen.getByRole("status")).toHaveTextContent("Run /auth to configure a provider");
	});
});
