/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRegistry } from "../../../shared/workspaces";
import { WorkspacesSection } from "./WorkspacesSection";

const vm = { id: "build-vm", sshTarget: "build-vm" };

const bridge = {
	list: vi.fn<() => Promise<WorkspaceRegistry>>(),
	add: vi.fn<(workspace: unknown) => Promise<WorkspaceRegistry>>(),
	remove: vi.fn<(id: string) => Promise<WorkspaceRegistry>>(),
	setActive: vi.fn<(id: string) => Promise<WorkspaceRegistry>>(),
	sshHosts: vi.fn<() => Promise<{ alias: string; hostName?: string }[]>>(),
};

vi.mock("../../lib/bridge", () => ({
	aoBridge: {
		get workspaces() {
			return bridge;
		},
	},
}));

async function renderSection(
	registry: WorkspaceRegistry,
	daemonStatus = { state: "ready" as const, port: 51234 },
	hosts: { alias: string; hostName?: string }[] = [],
) {
	bridge.list.mockResolvedValue(registry);
	bridge.sshHosts.mockResolvedValue(hosts);
	await act(async () => {
		render(<WorkspacesSection daemonStatus={daemonStatus} />);
		await Promise.resolve();
	});
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("WorkspacesSection", () => {
	it("always offers the local workspace, even with none registered", async () => {
		await renderSection({ remotes: [] });
		expect(screen.getByRole("button", { name: /this computer/i })).toHaveAttribute("aria-pressed", "true");
	});

	it("lists a registered workspace by its ssh target", async () => {
		await renderSection({ activeId: "local", remotes: [vm] });
		expect(screen.getByRole("button", { name: /^build-vm/ })).toBeInTheDocument();
	});

	// The supervisor auto-connects a single registered remote when the user has
	// never chosen, so showing "This computer" as selected would be a lie.
	it("marks the single registered remote as selected when nothing was ever chosen", async () => {
		await renderSection({ remotes: [vm] });
		expect(screen.getByRole("button", { name: /^build-vm/ })).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByRole("button", { name: /this computer/i })).toHaveAttribute("aria-pressed", "false");
	});

	// ...and an explicit "Local" must survive, or registering one VM silently
	// moves the user's work onto it.
	it("keeps local selected when local was chosen explicitly", async () => {
		await renderSection({ activeId: "local", remotes: [vm] });
		expect(screen.getByRole("button", { name: /this computer/i })).toHaveAttribute("aria-pressed", "true");
	});

	it("switches workspace through the supervisor", async () => {
		bridge.setActive.mockResolvedValue({ activeId: "build-vm", remotes: [vm] });
		await renderSection({ activeId: "local", remotes: [vm] });

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /^build-vm/ }));
		});
		expect(bridge.setActive).toHaveBeenCalledWith("build-vm");
	});

	it("validates a new workspace inline before the supervisor is called", async () => {
		await renderSection({ remotes: [] });
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /add a remote workspace/i }));
		});

		fireEvent.change(screen.getByLabelText(/workspace name/i), { target: { value: "Build VM" } });
		fireEvent.change(screen.getByLabelText(/ssh target/i), { target: { value: "build-vm" } });

		expect(screen.getByRole("alert")).toHaveTextContent(/lowercase letters/i);
		expect(screen.getByRole("button", { name: /^add$/i })).toBeDisabled();
		expect(bridge.add).not.toHaveBeenCalled();
	});

	it("adds a valid workspace and closes the form", async () => {
		bridge.add.mockResolvedValue({ remotes: [vm] });
		await renderSection({ remotes: [] });
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /add a remote workspace/i }));
		});

		fireEvent.change(screen.getByLabelText(/workspace name/i), { target: { value: "build-vm" } });
		fireEvent.change(screen.getByLabelText(/ssh target/i), { target: { value: "build-vm" } });
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
		});

		expect(bridge.add).toHaveBeenCalledWith(vm);
		await waitFor(() => expect(screen.queryByLabelText(/workspace name/i)).not.toBeInTheDocument());
	});

	it("surfaces a rejected add without closing the form", async () => {
		bridge.add.mockRejectedValue(new Error('Workspace "build-vm" already exists.'));
		await renderSection({ remotes: [] });
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /add a remote workspace/i }));
		});
		fireEvent.change(screen.getByLabelText(/workspace name/i), { target: { value: "build-vm" } });
		fireEvent.change(screen.getByLabelText(/ssh target/i), { target: { value: "build-vm" } });
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
		});

		expect(screen.getByText(/already exists/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/workspace name/i)).toBeInTheDocument();
	});

	// The remedy lives in the message (accept the host key, load your key,
	// install `ao` there); an icon-only failure would strand the user.
	it("shows the connection failure message on the selected workspace", async () => {
		await renderSection(
			{ activeId: "build-vm", remotes: [vm] },
			{ state: "error", message: "build-vm is not in your known_hosts." } as never,
		);
		expect(screen.getByText(/not in your known_hosts/i)).toBeInTheDocument();
	});

	it("removes a workspace through the supervisor", async () => {
		bridge.remove.mockResolvedValue({ remotes: [] });
		await renderSection({ activeId: "local", remotes: [vm] });
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /remove build-vm/i }));
		});
		expect(bridge.remove).toHaveBeenCalledWith("build-vm");
	});

	// The point of the picker: a target you already have in ~/.ssh/config should
	// be a click, not a retyped hostname.
	it("offers ssh_config aliases and fills both fields from one click", async () => {
		await renderSection({ remotes: [] }, undefined, [{ alias: "dev-training-vm", hostName: "10.0.0.8" }]);
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /add a remote workspace/i }));
		});

		await act(async () => {
			fireEvent.click(await screen.findByRole("button", { name: "dev-training-vm" }));
		});
		expect(screen.getByLabelText(/ssh target/i)).toHaveValue("dev-training-vm");
		// The id is coerced to the registry's stricter rules, so the form is valid
		// immediately rather than opening pre-filled with something rejected.
		expect(screen.getByLabelText(/workspace name/i)).toHaveValue("dev-training-vm");
		expect(screen.getByRole("button", { name: /^add$/i })).toBeEnabled();
	});

	it("stops overwriting the name once the user has typed one", async () => {
		await renderSection({ remotes: [] }, undefined, [{ alias: "gpu" }]);
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /add a remote workspace/i }));
		});
		fireEvent.change(screen.getByLabelText(/workspace name/i), { target: { value: "mine" } });
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "gpu" }));
		});
		expect(screen.getByLabelText(/workspace name/i)).toHaveValue("mine");
	});

	it("hides aliases that are already registered", async () => {
		await renderSection({ remotes: [vm] }, undefined, [{ alias: "build-vm" }, { alias: "gpu" }]);
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /add a remote workspace/i }));
		});
		expect(screen.queryByRole("button", { name: "build-vm" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "gpu" })).toBeInTheDocument();
	});

	it("offers no way to remove the local workspace", async () => {
		await renderSection({ remotes: [] });
		expect(screen.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
	});
});
