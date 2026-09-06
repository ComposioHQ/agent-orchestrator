import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRequestUpdateInstall } from "./useRequestUpdateInstall";
import { workspaceQueryOptions } from "./useWorkspaceQuery";

const { install, openPrompt } = vi.hoisted(() => ({ install: vi.fn(), openPrompt: vi.fn() }));

vi.mock("../lib/bridge", () => ({ aoBridge: { updates: { install } } }));
vi.mock("../stores/ui-store", () => ({
	useUiStore: (select: (state: { openUpdateInstallPrompt: () => void }) => unknown) =>
		select({ openUpdateInstallPrompt: openPrompt }),
}));

// Which sessions count as at-risk is update-install-risk.test.ts's job (6 cases
// there). These only need one of each shape to drive the branch below: a chat
// session mid-turn on a daemon-owned driver is at risk, a TUI session is not.
const session = (mode: "chat" | "tui") => ({
	id: mode,
	title: "Session",
	workspaceName: "repo",
	provider: "claude-code",
	mode,
	status: "working",
});

function renderTrigger(seed?: unknown) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	if (seed !== undefined) client.setQueryData(workspaceQueryOptions.queryKey, seed);
	let trigger: () => void = () => undefined;
	function Probe() {
		trigger = useRequestUpdateInstall();
		return null;
	}
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	render(<Probe />, { wrapper });
	return () => act(() => trigger());
}

beforeEach(() => {
	install.mockReset();
	openPrompt.mockReset();
});

describe("useRequestUpdateInstall", () => {
	it("installs directly when nothing would lose a turn", () => {
		// The confirmation existed to warn about lost work. With nothing to warn
		// about it is a modal on top of the Settings modal saying nothing, and the
		// build installs on the next quit anyway.
		renderTrigger([{ sessions: [session("tui")] }])();
		expect(install).toHaveBeenCalledTimes(1);
		expect(openPrompt).not.toHaveBeenCalled();
	});

	it("confirms when a session would lose an in-flight turn", () => {
		renderTrigger([{ sessions: [session("tui"), session("chat")] }])();
		expect(openPrompt).toHaveBeenCalledTimes(1);
		expect(install).not.toHaveBeenCalled();
	});

	it("confirms when the workspace list has not resolved", () => {
		// Unknown is not the same as safe: AO cannot rule out a live turn, so it
		// asks rather than quitting out from under one.
		renderTrigger()();
		expect(openPrompt).toHaveBeenCalledTimes(1);
		expect(install).not.toHaveBeenCalled();
	});
});
