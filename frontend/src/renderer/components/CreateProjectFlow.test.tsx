import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { aoBridge } from "../lib/bridge";
import type { DaemonStatus } from "../../shared/daemon-status";
import { ShellProvider, type ShellContextValue } from "../lib/shell-context";
import { CreateProjectFlow } from "./CreateProjectFlow";

// Remote-mode gate: the native folder picker and import scan are Mac-local, so
// a remote daemon connection swaps them for an explicit absolute-path entry.

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

function renderFlow(connection?: "local" | "remote") {
	const onCreateProject = vi.fn().mockResolvedValue(undefined);
	const onInitializeProject = vi.fn().mockResolvedValue(undefined);
	const onCloneProject = vi.fn().mockResolvedValue(undefined);
	const flow = (
		<CreateProjectFlow
			mode="single_repo"
			onCloneProject={onCloneProject}
			onCreateProject={onCreateProject}
			onInitializeProject={onInitializeProject}
		>
			{({ choosePath, label }) => (
				<button type="button" onClick={choosePath}>
					{label}
				</button>
			)}
		</CreateProjectFlow>
	);
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const tree = connection ? <ShellProvider value={shellValue(connection)}>{flow}</ShellProvider> : flow;
	render(<QueryClientProvider client={queryClient}>{tree}</QueryClientProvider>);
	return { onCreateProject, onInitializeProject };
}

beforeEach(() => {
	vi.restoreAllMocks();
});

describe("CreateProjectFlow remote path entry", () => {
	it("opens the native directory picker in local mode", async () => {
		const chooseDirectory = vi.spyOn(aoBridge.app, "chooseDirectory").mockResolvedValue(null);
		const user = userEvent.setup();
		renderFlow("local");

		await user.click(screen.getByRole("button", { name: "New project" }));

		expect(chooseDirectory).toHaveBeenCalledTimes(1);
		expect(screen.queryByLabelText("Absolute path of the project folder")).not.toBeInTheDocument();
	});

	it("shows an absolute-path input instead of the directory picker in remote mode", async () => {
		const chooseDirectory = vi.spyOn(aoBridge.app, "chooseDirectory").mockResolvedValue(null);
		const scanImportFolder = vi.spyOn(aoBridge.app, "scanImportFolder");
		const user = userEvent.setup();
		renderFlow("remote");

		await user.click(screen.getByRole("button", { name: "New project" }));

		const input = await screen.findByLabelText("Absolute path of the project folder");
		expect(chooseDirectory).not.toHaveBeenCalled();
		expect(scanImportFolder).not.toHaveBeenCalled();

		await user.type(input, "/srv/code/api");
		await user.click(screen.getByRole("button", { name: "Continue" }));

		// The path entry closes and hands the path to the agent sheet — still
		// without any local filesystem probe.
		expect(screen.queryByLabelText("Absolute path of the project folder")).not.toBeInTheDocument();
		expect(chooseDirectory).not.toHaveBeenCalled();
		expect(scanImportFolder).not.toHaveBeenCalled();
	});

	it("requires a non-empty path before continuing", async () => {
		const user = userEvent.setup();
		renderFlow("remote");

		await user.click(screen.getByRole("button", { name: "New project" }));
		await screen.findByLabelText("Absolute path of the project folder");
		await user.click(screen.getByRole("button", { name: "Continue" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("Enter a path.");
		expect(screen.getByLabelText("Absolute path of the project folder")).toBeInTheDocument();
	});
});
