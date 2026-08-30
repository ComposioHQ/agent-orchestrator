import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShellTerminalsView } from "./ShellTerminalsView";

const { hosts } = vi.hoisted(() => ({
	hosts: {
		connected: [] as string[],
		shells: {} as Record<string, Array<Record<string, unknown>>>,
	},
}));

// The real useShellTerminals hooks run against these: the standalone screen is
// an app-wide list, so what it shows is decided by which hosts it asks.
vi.mock("../lib/host-clients", () => ({
	connectedHosts: () => hosts.connected,
	subscribeConnectedHosts: () => () => undefined,
	isHostReady: () => true,
	clientFor: (host: string) => ({
		GET: () => Promise.resolve({ data: { shellTerminals: hosts.shells[host] ?? [] }, error: undefined }),
		DELETE: () => Promise.resolve({ data: {}, error: undefined }),
		PATCH: () => Promise.resolve({ data: {}, error: undefined }),
		POST: () => Promise.resolve({ data: {}, error: undefined }),
	}),
}));

vi.mock("../lib/shell-context", () => ({
	useShell: () => ({ daemonStatus: { state: "ready" } }),
}));

vi.mock("./TerminalPane", () => ({ TerminalPane: () => <div>terminal body</div> }));

function shell(overrides: { handleId: string; title: string; sessionId?: string }) {
	return {
		workingDir: "/repos/app",
		createdAt: "2026-08-24T00:00:00Z",
		...overrides,
	};
}

function renderView() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<ShellTerminalsView />
		</QueryClientProvider>,
	);
}

describe("ShellTerminalsView", () => {
	beforeEach(() => {
		hosts.connected = [];
		hosts.shells = {};
	});

	it("points the empty state at the visible plus tab-strip control", () => {
		renderView();

		expect(screen.getByText("No terminals open")).toBeInTheDocument();
		expect(screen.getByText(/use the \+ button/i)).toBeInTheDocument();
		expect(screen.queryByText(/terminal button/i)).not.toBeInTheDocument();
	});

	// The standalone terminals screen is app-wide, not local-only: a shell opened
	// on a remote host has nowhere else to appear, so asking only the local host
	// leaves it with no UI surface at all.
	it("lists the standalone shells of every connected host", async () => {
		hosts.connected = ["remote"];
		hosts.shells = {
			local: [shell({ handleId: "sh-local", title: "local shell" })],
			remote: [shell({ handleId: "sh-remote", title: "remote shell" })],
		};

		renderView();

		expect(await screen.findByText("remote shell")).toBeInTheDocument();
		expect(screen.getByText("local shell")).toBeInTheDocument();
	});

	// A session's shells belong beside that session's pane, on whichever host
	// they live — the filter has to hold across hosts, not just locally.
	it("leaves every host's session-scoped shells out of the standalone list", async () => {
		hosts.connected = ["remote"];
		hosts.shells = {
			local: [shell({ handleId: "sh-local", title: "local shell" })],
			remote: [shell({ handleId: "sh-remote-sess", title: "remote session shell", sessionId: "sess-1" })],
		};

		renderView();

		await waitFor(() => expect(screen.getByText("local shell")).toBeInTheDocument());
		expect(screen.queryByText("remote session shell")).toBeNull();
	});
});
