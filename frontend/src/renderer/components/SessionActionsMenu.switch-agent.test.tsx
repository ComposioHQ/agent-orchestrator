import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSession } from "../types/workspace";
import { SessionActionsMenu } from "./SessionActionsMenu";
import { SwitchAgentDialog } from "./SwitchAgentDialog";
import { TerminalSwitchAgentButton } from "./TerminalSwitchAgentButton";
import { TooltipProvider } from "./ui/tooltip";

// Regression test for: clicking "Switch agent" in the session actions dropdown
// opened SwitchAgentDialog and then immediately closed it again in the same
// tick. Root cause: DropdownMenuItem's onSelect closes the parent
// DropdownMenu (Radix default, no preventDefault), and SwitchAgentDialog is
// non-modal (Dialog modal={false}), so its Radix DismissableLayer treats the
// residual pointer/focus activity from the closing dropdown as an
// outside-interaction and dismisses the dialog right after it opens.
//
// Unlike TerminalSwitchAgentButton.test.tsx and SwitchAgentDialog.test.tsx,
// this test drives the *real* DropdownMenuItem click path (variant="menu-item"
// inside a real SessionActionsMenu/DropdownMenu) instead of mocking the
// button out or opening the dialog directly with open=true.

const { getMock, postMock } = vi.hoisted(() => ({
	getMock: vi.fn(),
	postMock: vi.fn(),
}));

vi.mock("../lib/api-client", () => ({
	apiClient: {
		GET: getMock,
		POST: postMock,
	},
	apiErrorMessage: (error: unknown, fallback = "Request failed") => {
		if (error instanceof Error) return error.message;
		if (typeof error === "object" && error !== null && "message" in error) {
			return String((error as { message: unknown }).message);
		}
		return fallback;
	},
}));

const worker: WorkspaceSession = {
	activity: { state: "active", lastActivityAt: "2026-06-10T00:00:00Z" },
	branch: "ao/sess-1",
	id: "sess-1",
	kind: "worker",
	provider: "claude-code",
	prs: [],
	status: "working",
	title: "do the thing",
	updatedAt: "2026-06-10T00:00:00Z",
	workspaceId: "proj-1",
	workspaceName: "my-app",
};

function SessionActionsMenuHarness() {
	const [container, setContainer] = useState<HTMLDivElement | null>(null);
	const [open, setOpen] = useState(false);
	return (
		<div className="relative" data-testid="terminal-container" ref={setContainer}>
			<SessionActionsMenu>
				<TerminalSwitchAgentButton
					container={container}
					onOpenChange={setOpen}
					open={open}
					session={worker}
					switchError={null}
					variant="menu-item"
				/>
			</SessionActionsMenu>
			{container ? (
				<SwitchAgentDialog container={container} onOpenChange={setOpen} open={open} session={worker} />
			) : null}
		</div>
	);
}

function renderHarness() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<TooltipProvider>
				<SessionActionsMenuHarness />
			</TooltipProvider>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	getMock.mockReset();
	getMock.mockImplementation(async (path: string, options?: { params?: { path?: { agent?: string } } }) => {
		if (path === "/api/v1/agents/{agent}/models") {
			const agentId = options?.params?.path?.agent ?? "codex";
			return {
				data: {
					agentId,
					allowCustom: false,
					fetchedAt: "2026-06-10T00:00:00Z",
					models: [{ id: agentId === "codex" ? "gpt-5.4" : "claude-opus-4-6", label: "Default" }],
					selectionMode: "catalog",
					source: "test",
					stale: false,
				},
				error: undefined,
				response: { status: 200 },
			};
		}
		return { data: { switches: [] }, error: undefined, response: { status: 200 } };
	});
	postMock.mockReset();
});

describe("SessionActionsMenu > Switch agent", () => {
	it("keeps the switch-agent dialog open after choosing it from the actions menu", async () => {
		renderHarness();

		await userEvent.click(await screen.findByRole("button", { name: "Session actions" }));
		await userEvent.click(await screen.findByRole("menuitem", { name: "Switch agent" }));

		// The bug: the dialog opens and is immediately dismissed by Radix's
		// DismissableLayer reacting to the same click that closed the dropdown.
		// Assert it is still there after the dropdown's close animation/focus
		// return has had a chance to run.
		const dialog = await screen.findByRole("dialog", { name: "Switch agent" });
		await waitFor(() => expect(screen.getByRole("dialog", { name: "Switch agent" })).toBeInTheDocument());
		expect(dialog).toBeInTheDocument();
	});

	it("still closes the dialog on a genuine outside click", async () => {
		renderHarness();

		await userEvent.click(await screen.findByRole("button", { name: "Session actions" }));
		await userEvent.click(await screen.findByRole("menuitem", { name: "Switch agent" }));
		await screen.findByRole("dialog", { name: "Switch agent" });

		// Let any open-time transition settle, then click somewhere genuinely
		// outside the dialog — this must still dismiss it.
		await new Promise((resolve) => requestAnimationFrame(resolve));
		await userEvent.click(document.body);

		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
	});
});
