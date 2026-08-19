import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DaemonStatus } from "../../../shared/daemon-status";
import { ShellProvider, type ShellContextValue } from "../../lib/shell-context";
import { GeneralSettingsSection } from "./GeneralSettingsSection";

function shellValue(connection: "local" | "remote"): ShellContextValue {
	const daemonStatus: DaemonStatus = { state: "ready", port: 31001, connection };
	return {
		daemonStatus,
		workspaceStartupState: "ready",
		cloneProject: vi.fn(),
		createProject: vi.fn(),
		initializeProjectRepository: vi.fn(),
	};
}

function renderSection(connection: "local" | "remote", onConnectMobile = vi.fn()) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={queryClient}>
			<ShellProvider value={shellValue(connection)}>
				<GeneralSettingsSection onConnectMobile={onConnectMobile} />
			</ShellProvider>
		</QueryClientProvider>,
	);
	return onConnectMobile;
}

describe("GeneralSettingsSection remote gate", () => {
	it("shows the Connect Mobile row in local mode", async () => {
		const onConnectMobile = renderSection("local");

		const row = screen.getByRole("button", { name: "Connect Mobile" });
		await userEvent.click(row);

		expect(onConnectMobile).toHaveBeenCalledTimes(1);
	});

	it("hides the Connect Mobile row in remote mode and points at the CLI instead", () => {
		renderSection("remote");

		expect(screen.queryByRole("button", { name: "Connect Mobile" })).not.toBeInTheDocument();
		expect(screen.getByText(/Manage remote pairing with `ao remote` on the daemon host\./)).toBeInTheDocument();
	});
});
