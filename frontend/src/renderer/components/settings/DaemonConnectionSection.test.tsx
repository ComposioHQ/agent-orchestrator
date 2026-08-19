import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonStatus } from "../../../shared/daemon-status";
import { ShellProvider, type ShellContextValue } from "../../lib/shell-context";
import { DaemonConnectionSection } from "./DaemonConnectionSection";

const { getConfig, testAndConnect, disconnect, forget } = vi.hoisted(() => ({
	getConfig: vi.fn(),
	testAndConnect: vi.fn(),
	disconnect: vi.fn(),
	forget: vi.fn(),
}));

vi.mock("../../lib/bridge", () => ({
	aoBridge: {
		remote: { getConfig, testAndConnect, disconnect, forget },
	},
}));

const LOCAL_CONFIG = { mode: "local" as const, url: undefined, hasPassword: false, passwordPersistent: false };
const REMOTE_CONFIG = {
	mode: "remote" as const,
	url: "https://builder.tail1234.ts.net",
	hasPassword: true,
	passwordPersistent: true,
};

function shellValue(daemonStatus: DaemonStatus): ShellContextValue {
	return {
		daemonStatus,
		workspaceStartupState: "ready",
		cloneProject: vi.fn(),
		createProject: vi.fn(),
		initializeProjectRepository: vi.fn(),
	};
}

function renderSection(daemonStatus?: DaemonStatus) {
	const section = <DaemonConnectionSection />;
	render(daemonStatus ? <ShellProvider value={shellValue(daemonStatus)}>{section}</ShellProvider> : section);
}

beforeEach(() => {
	for (const mock of [getConfig, testAndConnect, disconnect, forget]) mock.mockReset();
	getConfig.mockResolvedValue(LOCAL_CONFIG);
	testAndConnect.mockResolvedValue({ ok: true });
	disconnect.mockResolvedValue({ state: "stopped" });
	forget.mockResolvedValue({ state: "stopped" });
});

describe("DaemonConnectionSection", () => {
	it("renders local mode by default without the remote form", async () => {
		renderSection();

		expect(await screen.findByRole("radio", { name: "Local (this Mac)" })).toHaveAttribute("aria-checked", "true");
		expect(screen.getByRole("radio", { name: "Remote (Tailscale HTTPS)" })).toHaveAttribute("aria-checked", "false");
		expect(screen.queryByLabelText("Daemon URL")).not.toBeInTheDocument();
		expect(getConfig).toHaveBeenCalledTimes(1);
	});

	it("reveals the URL and password fields when remote is selected", async () => {
		const user = userEvent.setup();
		renderSection();

		await user.click(await screen.findByRole("radio", { name: "Remote (Tailscale HTTPS)" }));

		expect(screen.getByLabelText("Daemon URL")).toBeInTheDocument();
		expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
		expect(screen.getByText(/ao remote credentials/)).toBeInTheDocument();
	});

	it("shows the saved-password and non-persistent notes from the config", async () => {
		getConfig.mockResolvedValue({ ...REMOTE_CONFIG, passwordPersistent: false });
		renderSection();

		expect(await screen.findByText(/password is saved on this machine/)).toBeInTheDocument();
		expect(screen.getByText(/can't store the password securely/)).toBeInTheDocument();
		// Remote config selects the remote mode and prefills the (non-secret) URL.
		expect(screen.getByLabelText("Daemon URL")).toHaveValue("https://builder.tail1234.ts.net");
	});

	it("surfaces client-side URL validation without calling the bridge", async () => {
		const user = userEvent.setup();
		renderSection();

		await user.click(await screen.findByRole("radio", { name: "Remote (Tailscale HTTPS)" }));
		await user.type(screen.getByLabelText("Daemon URL"), "http://builder.tail1234.ts.net");
		await user.click(screen.getByRole("button", { name: "Test and connect" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Remote daemon URLs must use HTTPS (Tailscale Serve).",
		);
		expect(testAndConnect).not.toHaveBeenCalled();
	});

	it("shows the daemon's message when the connection test fails", async () => {
		testAndConnect.mockResolvedValue({ ok: false, code: "remote_unauthorized", message: "password rejected" });
		const user = userEvent.setup();
		renderSection();

		await user.click(await screen.findByRole("radio", { name: "Remote (Tailscale HTTPS)" }));
		await user.type(screen.getByLabelText("Daemon URL"), "https://builder.tail1234.ts.net");
		await user.type(screen.getByLabelText("Password"), "wrong");
		await user.click(screen.getByRole("button", { name: "Test and connect" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("password rejected");
		expect(testAndConnect).toHaveBeenCalledWith("https://builder.tail1234.ts.net", "wrong");
	});

	it("connects successfully, clears the password field, and reloads the config", async () => {
		getConfig.mockResolvedValueOnce(LOCAL_CONFIG).mockResolvedValueOnce(REMOTE_CONFIG);
		const user = userEvent.setup();
		renderSection();

		await user.click(await screen.findByRole("radio", { name: "Remote (Tailscale HTTPS)" }));
		await user.type(screen.getByLabelText("Daemon URL"), "https://builder.tail1234.ts.net/");
		await user.type(screen.getByLabelText("Password"), "secret");
		await user.click(screen.getByRole("button", { name: "Test and connect" }));

		// The URL is normalized (trailing slash dropped) before hitting the bridge.
		await waitFor(() => expect(testAndConnect).toHaveBeenCalledWith("https://builder.tail1234.ts.net", "secret"));
		await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(2));
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(screen.getByLabelText("Password")).toHaveValue("");
	});

	it("shows the connected state and disconnects via the bridge", async () => {
		getConfig.mockResolvedValue(REMOTE_CONFIG);
		const user = userEvent.setup();
		renderSection({ state: "ready", connection: "remote", port: 31001 });

		expect(await screen.findByText("Connected to https://builder.tail1234.ts.net")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Disconnect" }));

		expect(disconnect).toHaveBeenCalledTimes(1);
		expect(forget).not.toHaveBeenCalled();
	});

	it("forgets the remote only after confirming", async () => {
		getConfig.mockResolvedValue(REMOTE_CONFIG);
		const user = userEvent.setup();
		renderSection({ state: "ready", connection: "remote", port: 31001 });

		await user.click(await screen.findByRole("button", { name: "Forget remote" }));
		expect(forget).not.toHaveBeenCalled();
		// The destructive action sits behind a ConfirmDialog with its own button.
		const dialog = await screen.findByRole("dialog");
		await user.click(within(dialog).getByRole("button", { name: "Forget remote" }));

		await waitFor(() => expect(forget).toHaveBeenCalledTimes(1));
	});
});
