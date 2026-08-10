import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSwitch } from "../hooks/useAgentSwitches";
import { AGENT_OPTIONS } from "../lib/agent-options";
import type { WorkspaceSession } from "../types/workspace";
import { TerminalSwitchAgentButton } from "./TerminalSwitchAgentButton";
import { TooltipProvider } from "./ui/tooltip";

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

function switchRecord(overrides: Partial<AgentSwitch> = {}): AgentSwitch {
	return {
		agentHandoffStatus: "not_attempted",
		fromHarness: "claude-code",
		id: "switch-1",
		requestedAt: "2026-06-10T00:00:00Z",
		semanticHandoffIncluded: true,
		sessionId: "sess-1",
		state: "starting_target",
		targetHarness: "codex",
		updatedAt: "2026-06-10T00:00:01Z",
		...overrides,
	};
}

function renderControl(session: WorkspaceSession = worker) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const control = (nextSession: WorkspaceSession) => (
		<QueryClientProvider client={queryClient}>
			<TooltipProvider>
				<TerminalSwitchAgentButton key={nextSession.id} session={nextSession} />
			</TooltipProvider>
		</QueryClientProvider>
	);
	const result = render(control(session));
	return {
		...result,
		queryClient,
		rerenderControl: (nextSession: WorkspaceSession) => result.rerender(control(nextSession)),
	};
}

beforeEach(() => {
	getMock.mockReset();
	getMock.mockResolvedValue({ data: { switches: [] }, error: undefined, response: { status: 200 } });
	postMock.mockReset();
});

describe("TerminalSwitchAgentButton", () => {
	it("renders with the same semantic topbar hover surface as adjacent session actions", async () => {
		renderControl();

		const button = await screen.findByRole("button", { name: "Switch agent" });
		expect(button).toHaveClass("topbar-control--icon", "size-control-lg", "rounded-md");
		expect(button).not.toHaveClass("ml-2", "rounded-full");
		expect(button.querySelector(".lucide-repeat-2")).toBeInTheDocument();
		expect(button.querySelector("img")).not.toBeInTheDocument();
		expect(button).toHaveTextContent("");
	});

	it.each([
		["unsupported provider", { provider: "cursor" }],
		["terminated worker", { isTerminated: true, status: "terminated" }],
		["orchestrator", { id: "orch-1", kind: "orchestrator" }],
	] as const)("does not render for an %s", async (_name, overrides) => {
		renderControl({ ...worker, ...overrides } as WorkspaceSession);
		await waitFor(() => expect(getMock).toHaveBeenCalled());
		expect(screen.queryByRole("button", { name: "Switch agent" })).not.toBeInTheDocument();
	});

	it("opens the existing dialog and submits the selected switch", async () => {
		const activeSwitch = switchRecord();
		postMock.mockResolvedValue({ data: { switch: activeSwitch }, error: undefined, response: { status: 200 } });
		const { queryClient } = renderControl();
		const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

		await userEvent.click(await screen.findByRole("button", { name: "Switch agent" }));
		const dialog = screen.getByRole("dialog", { name: "Switch agent" });
		const targetAgent = within(dialog).getByRole("combobox", { name: "Target agent" });
		expect(targetAgent).toHaveTextContent("Codex");
		await userEvent.click(targetAgent);
		expect(screen.getAllByRole("option")).toHaveLength(AGENT_OPTIONS.length);
		expect(screen.getByRole("option", { name: /Cursor,\s*Coming soon/ })).toHaveAttribute("data-disabled");
		await userEvent.keyboard("{Escape}");
		await userEvent.type(within(dialog).getByLabelText("Note (optional)"), "  Check tests first.  ");
		await userEvent.click(within(dialog).getByRole("button", { name: "Switch" }));

		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(postMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/switch-agent", {
			params: { path: { sessionId: "sess-1" } },
			body: {
				idempotencyKey: expect.any(String),
				note: "Check tests first.",
				targetHarness: "codex",
			},
		});
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["workspaces"] });
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("shows terminal progress immediately while the synchronous request is pending", async () => {
		postMock.mockReturnValue(new Promise(() => {}));
		renderControl();

		await userEvent.click(await screen.findByRole("button", { name: "Switch agent" }));
		await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Switch" }));

		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Switching to Codex…" })).toHaveAttribute(
			"aria-busy",
			"true",
		);
	});

	it("restores durable progress and keeps it inspectable after the source exits", async () => {
		getMock.mockResolvedValue({
			data: { switches: [switchRecord()] },
			error: undefined,
			response: { status: 200 },
		});
		renderControl({
			...worker,
			activity: { state: "exited", lastActivityAt: "2026-06-10T00:00:02Z" },
			status: "exited",
		});

		const button = await screen.findByRole("button", { name: "Switching to Codex…" });
		await userEvent.click(button);
		expect(within(screen.getByRole("dialog")).getByRole("status")).toHaveTextContent(
			"Switching from Claude Code to CodexStarting target agent",
		);
	});

	it("shows a static recovery warning when target startup is unconfirmed", async () => {
		getMock.mockResolvedValue({
			data: { switches: [switchRecord({ errorCode: "target_start_unconfirmed" })] },
			error: undefined,
			response: { status: 200 },
		});
		renderControl({
			...worker,
			activity: { state: "exited", lastActivityAt: "2026-06-10T00:00:02Z" },
			status: "exited",
		});

		const button = await screen.findByRole("button", { name: "Agent switch needs recovery" });
		expect(button).not.toHaveAttribute("aria-busy");
		expect(button.querySelector(".lucide-triangle-alert")).toBeInTheDocument();
		await userEvent.click(button);
		expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent(
			"AO could not confirm whether the target agent started. Terminal input remains locked to prevent two agents from owning the session.",
		);
	});

	it.each([
		["target_binary_missing", "Target agent is not installed"],
		["target_agent_unauthorized", "Target agent is not authenticated"],
		["source_stop_unconfirmed", "Source shutdown unconfirmed"],
		["daemon_restart_post_stop", "Recovery failed after source shutdown"],
		["daemon_restart_unrecoverable_target", "Target agent could not be recovered"],
		["delivery_unconfirmed", "Delivery unconfirmed"],
		["future_error_code", "Failed"],
	] as const)("renders an actionable history label for %s", async (errorCode, label) => {
		getMock.mockResolvedValue({
			data: { switches: [switchRecord({ errorCode, state: "failed" })] },
			error: undefined,
			response: { status: 200 },
		});
		renderControl();

		await userEvent.click(await screen.findByRole("button", { name: "Switch agent" }));
		expect(within(screen.getByTestId("agent-switch-history")).getByText(label)).toBeInTheDocument();
	});

	it.each([
		["marks completed history when AO had to use fallback context", false, true],
		["does not mark completed history when the semantic handoff was included", true, false],
	] as const)("%s", async (_label, semanticHandoffIncluded, expected) => {
		getMock.mockResolvedValue({
			data: {
				switches: [
					switchRecord({
						agentHandoffStatus: "received",
						semanticHandoffIncluded,
						sourceTranscriptStatus: "unavailable",
						state: "completed",
					}),
				],
			},
			error: undefined,
			response: { status: 200 },
		});
		renderControl();

		await userEvent.click(await screen.findByRole("button", { name: "Switch agent" }));
		const fallbackLabel = within(screen.getByTestId("agent-switch-history")).queryByText("Fallback context used");
		if (expected) expect(fallbackLabel).toBeInTheDocument();
		else expect(fallbackLabel).not.toBeInTheDocument();
	});

	it("reopens a rejected switch and retries with a fresh idempotency key", async () => {
		postMock
			.mockResolvedValueOnce({
				data: undefined,
				error: { message: "target agent is unavailable" },
				response: { status: 409 },
			})
			.mockResolvedValueOnce({
				data: { switch: switchRecord({ id: "switch-2" }) },
				error: undefined,
				response: { status: 200 },
			});
		renderControl();

		await userEvent.click(await screen.findByRole("button", { name: "Switch agent" }));
		await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Switch" }));

		const reopenedDialog = await screen.findByRole("dialog", { name: "Switch agent" });
		expect(within(reopenedDialog).getByRole("alert")).toHaveTextContent("target agent is unavailable");
		const firstIdempotencyKey = postMock.mock.calls[0]?.[1]?.body?.idempotencyKey;
		await userEvent.click(within(reopenedDialog).getByRole("button", { name: "Switch" }));

		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
		const retryIdempotencyKey = postMock.mock.calls[1]?.[1]?.body?.idempotencyKey;
		expect(firstIdempotencyKey).toEqual(expect.any(String));
		expect(retryIdempotencyKey).toEqual(expect.any(String));
		expect(retryIdempotencyKey).not.toBe(firstIdempotencyKey);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});
});
