import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Managing saved hosts from the Host dropdown. Two consequences are the point of
// these cases: the renderer must not keep a client for a removed or edited
// host after main has dropped the proxy behind that base URL.
const { bridge, connectHostMock, disconnectHostMock } = vi.hoisted(() => ({
	bridge: {
		app: { chooseDirectory: vi.fn() },
		remotes: {
			list: vi.fn(),
			probe: vi.fn(),
			add: vi.fn(),
			update: vi.fn(),
			remove: vi.fn(),
		},
	},
	connectHostMock: vi.fn(),
	disconnectHostMock: vi.fn(),
}));

vi.mock("../lib/bridge", () => ({ aoBridge: bridge }));
vi.mock("../lib/host-clients", () => ({
	connectHost: connectHostMock,
	disconnectHost: disconnectHostMock,
}));
// These cases exercise the local remote-host chooser only. Keep the cloud
// integration inactive so the partial bridge fixture remains focused on that UI.
vi.mock("../hooks/useCloudGate", () => ({
	useCloudGate: () => ({ cloudEnabled: false, localEnabled: true, client: "" }),
}));
vi.mock("../lib/cloud-session", () => ({
	useCloudSession: () => ({
		configured: false,
		session: null,
		status: "unauthenticated",
		signIn: () => undefined,
		signOut: async () => undefined,
	}),
}));

import { CreateProjectFlow } from "./CreateProjectFlow";
import { useUiStore } from "../stores/ui-store";

const WORKBOX = { label: "workbox", url: "http://192.0.2.1:3011" };

beforeEach(() => {
	vi.clearAllMocks();
	bridge.remotes.list.mockResolvedValue([WORKBOX]);
	bridge.remotes.probe.mockResolvedValue("online");
	bridge.remotes.update.mockResolvedValue("online");
	bridge.remotes.remove.mockResolvedValue(undefined);
	connectHostMock.mockResolvedValue(undefined);
	disconnectHostMock.mockResolvedValue(undefined);
	useUiStore.setState({ remoteHosts: true });
});

describe("with the Remote hosts flag off", () => {
	it("shows no host picker and contacts no saved host", async () => {
		useUiStore.setState({ remoteHosts: false });
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<CreateProjectFlow
					embedded
					mode="choose"
					onCloneProject={vi.fn()}
					onCreateProject={vi.fn()}
					onInitializeProject={vi.fn()}
				/>
			</QueryClientProvider>,
		);

		expect(await screen.findByRole("button", { name: /clone/i })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /^host:/i })).toBeNull();
		expect(bridge.remotes.list).not.toHaveBeenCalled();
		expect(bridge.remotes.probe).not.toHaveBeenCalled();
	});
});

async function openHostList() {
	// The agent sheet inside the flow reads the agent catalog through React Query
	// on mount; nothing here reaches it, but it still needs a client to mount at all.
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<CreateProjectFlow
				embedded
				mode="choose"
				onCloneProject={vi.fn()}
				onCreateProject={vi.fn()}
				onInitializeProject={vi.fn()}
			/>
		</QueryClientProvider>,
	);
	await screen.findByRole("button", { name: /^host:/i });
	await waitFor(() => expect(bridge.remotes.probe).toHaveBeenCalled());
	await userEvent.click(screen.getByRole("button", { name: /^host:/i }));
}

describe("host management from the Host dropdown", () => {
	it("removes a host after naming it in a confirmation", async () => {
		await openHostList();
		await userEvent.click(screen.getByRole("button", { name: /remove workbox/i }));

		// The confirmation says which machine, not just "this host".
		expect(await screen.findByText(/remove workbox from AO/i)).toBeInTheDocument();
		expect(bridge.remotes.remove).not.toHaveBeenCalled();

		await userEvent.click(screen.getByRole("button", { name: /^remove$/i }));
		await waitFor(() => expect(bridge.remotes.remove).toHaveBeenCalledWith(WORKBOX.url));
	});

	it("forgets the renderer client when a host is removed", async () => {
		await openHostList();
		await userEvent.click(screen.getByRole("button", { name: /remove workbox/i }));
		await userEvent.click(await screen.findByRole("button", { name: /^remove$/i }));

		await waitFor(() => expect(disconnectHostMock).toHaveBeenCalledWith(WORKBOX.url));
	});

	it("does not connect a replacement when a host is removed", async () => {
		await openHostList();
		await userEvent.click(screen.getByRole("button", { name: /remove workbox/i }));
		await userEvent.click(await screen.findByRole("button", { name: /^remove$/i }));

		await waitFor(() => expect(bridge.remotes.remove).toHaveBeenCalled());
		expect(connectHostMock).not.toHaveBeenCalled();
	});

	it("replaces the renderer client when a host is re-pointed", async () => {
		await openHostList();
		await userEvent.click(screen.getByRole("button", { name: /edit workbox/i }));

		const address = await screen.findByLabelText(/address/i);
		await userEvent.clear(address);
		await userEvent.type(address, "192.0.2.5:3011");
		await userEvent.click(screen.getByRole("button", { name: /save/i }));

		await waitFor(() =>
			expect(bridge.remotes.update).toHaveBeenCalledWith(WORKBOX.url, {
				label: "workbox",
				url: "http://192.0.2.5:3011",
			}),
		);
		await waitFor(() => expect(disconnectHostMock).toHaveBeenCalledWith(WORKBOX.url));
		expect(connectHostMock).toHaveBeenCalledWith("http://192.0.2.5:3011");
	});

	it("reconnects after a password fix, whose proxy main just dropped", async () => {
		await openHostList();
		await userEvent.click(screen.getByRole("button", { name: /edit workbox/i }));
		await userEvent.type(await screen.findByLabelText(/password/i), "rotated");
		await userEvent.click(screen.getByRole("button", { name: /save/i }));

		await waitFor(() => expect(bridge.remotes.update).toHaveBeenCalled());
		// Same url, but the proxy behind it held the old password — the app has to
		// come back through a fresh one rather than keep a base that now 401s.
		expect(disconnectHostMock).toHaveBeenCalledWith(WORKBOX.url);
		expect(connectHostMock).toHaveBeenCalledWith(WORKBOX.url);
	});
});
