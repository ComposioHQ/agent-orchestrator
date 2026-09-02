import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { aoBridge } from "../lib/bridge";
import { useUiStore } from "../stores/ui-store";
import { CreateProjectFlow } from "./CreateProjectFlow";

beforeEach(() => {
	vi.restoreAllMocks();
	vi.spyOn(aoBridge.remotes, "list").mockResolvedValue([{ label: "workbox", url: "http://192.0.2.1:3011" }]);
	vi.spyOn(aoBridge.remotes, "probe").mockResolvedValue("online");
	useUiStore.setState({ remoteHosts: true });
});

function renderFlow(props: Partial<Parameters<typeof CreateProjectFlow>[0]> = {}) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={queryClient}>
			<CreateProjectFlow
				embedded
				mode="choose"
				onCloneProject={vi.fn()}
				onCreateProject={vi.fn()}
				onInitializeProject={vi.fn()}
				{...props}
			/>
		</QueryClientProvider>,
	);
}

async function selectWorkbox() {
	await userEvent.click(await screen.findByRole("button", { name: /^host:/i }));
	await userEvent.click(await screen.findByRole("button", { name: /^workbox/ }));
}

describe("CreateProjectFlow — remote host", () => {
	it("defaults to the local host and keeps the native folder picker", async () => {
		const chooseDirectory = vi.spyOn(aoBridge.app, "chooseDirectory").mockResolvedValue(null);
		renderFlow();
		await userEvent.click(screen.getByRole("button", { name: /open local repository/i }));
		expect(chooseDirectory).toHaveBeenCalled();
	});

	it("replaces the folder picker with an absolute-path field for a remote host", async () => {
		const chooseDirectory = vi.spyOn(aoBridge.app, "chooseDirectory").mockResolvedValue(null);
		renderFlow();
		await selectWorkbox();
		await userEvent.click(screen.getByRole("button", { name: /open local repository/i }));
		expect(screen.getByLabelText(/path on workbox/i)).toBeInTheDocument();
		expect(chooseDirectory).not.toHaveBeenCalled();
	});

	it("registers the project on the remote daemon, not the local one", async () => {
		const request = vi.spyOn(aoBridge.remotes, "request").mockResolvedValue({ status: 201, body: { id: "p1" } });
		const onCreateProject = vi.fn();
		renderFlow({ onCreateProject });
		await selectWorkbox();
		await userEvent.click(screen.getByRole("button", { name: /open local repository/i }));
		await userEvent.type(screen.getByLabelText(/path on workbox/i), "/srv/repo");
		await userEvent.click(screen.getByRole("button", { name: /add project on workbox/i }));

		expect(request).toHaveBeenCalledWith("http://192.0.2.1:3011", {
			method: "POST",
			path: "/api/v1/projects",
			body: { path: "/srv/repo", asWorkspace: false },
		});
		// The local create path must not also fire — that would register the
		// project twice, on the wrong machine.
		expect(onCreateProject).not.toHaveBeenCalled();
	});

	it("carries the workspace choice through to the remote daemon", async () => {
		const request = vi.spyOn(aoBridge.remotes, "request").mockResolvedValue({ status: 201, body: { id: "p1" } });
		renderFlow();
		await selectWorkbox();
		await userEvent.click(screen.getByRole("button", { name: /add a workspace folder/i }));
		await userEvent.type(screen.getByLabelText(/path on workbox/i), "/srv/team");
		await userEvent.click(screen.getByRole("button", { name: /add project on workbox/i }));

		expect(request).toHaveBeenCalledWith("http://192.0.2.1:3011", {
			method: "POST",
			path: "/api/v1/projects",
			body: { path: "/srv/team", asWorkspace: true },
		});
	});

	it("shows the daemon's own rejection rather than guessing locally", async () => {
		vi.spyOn(aoBridge.remotes, "request").mockResolvedValue({
			status: 400,
			body: { error: "path must be absolute on the daemon host" },
		});
		renderFlow();
		await selectWorkbox();
		await userEvent.click(screen.getByRole("button", { name: /open local repository/i }));
		await userEvent.type(screen.getByLabelText(/path on workbox/i), "~/repo");
		await userEvent.click(screen.getByRole("button", { name: /add project on workbox/i }));
		expect(await screen.findByRole("alert")).toHaveTextContent(/must be absolute on the daemon host/i);
	});

	it("browsing fills the remote path field", async () => {
		vi.spyOn(aoBridge.remotes, "request")
			.mockResolvedValueOnce({
				status: 200,
				body: { path: "/srv", parent: "/", entries: [{ name: "repo", path: "/srv/repo", gitRepo: true }] },
			})
			.mockResolvedValueOnce({ status: 200, body: { path: "/srv/repo", parent: "/srv", entries: [] } });
		renderFlow();
		await selectWorkbox();
		await userEvent.click(screen.getByRole("button", { name: /open local repository/i }));
		await userEvent.click(screen.getByRole("button", { name: /browse/i }));
		// Descend into repo, then take the folder the picker is standing in.
		await userEvent.click(await screen.findByRole("button", { name: /^repo/ }));
		await userEvent.click(screen.getByRole("button", { name: /choose this folder/i }));
		expect(screen.getByLabelText(/path on workbox/i)).toHaveValue("/srv/repo");
	});

	it("keeps a typed path working alongside Browse", async () => {
		const request = vi.spyOn(aoBridge.remotes, "request").mockResolvedValue({ status: 201, body: { id: "p1" } });
		renderFlow();
		await selectWorkbox();
		await userEvent.click(screen.getByRole("button", { name: /open local repository/i }));
		await userEvent.type(screen.getByLabelText(/path on workbox/i), "/srv/typed");
		await userEvent.click(screen.getByRole("button", { name: /add project on workbox/i }));
		expect(request).toHaveBeenCalledWith("http://192.0.2.1:3011", {
			method: "POST",
			path: "/api/v1/projects",
			body: { path: "/srv/typed", asWorkspace: false },
		});
	});

	it("skips the local git preflight on the remote path", async () => {
		const scanImportFolder = vi.spyOn(aoBridge.app, "scanImportFolder");
		const checkAncestorRepo = vi.spyOn(aoBridge.app, "checkAncestorRepo");
		vi.spyOn(aoBridge.remotes, "request").mockResolvedValue({ status: 201, body: { id: "p1" } });
		renderFlow();
		await selectWorkbox();
		await userEvent.click(screen.getByRole("button", { name: /add a workspace folder/i }));
		await userEvent.type(screen.getByLabelText(/path on workbox/i), "/srv/team");
		await userEvent.click(screen.getByRole("button", { name: /add project on workbox/i }));
		// Both shell out on this machine and would judge the wrong filesystem.
		expect(scanImportFolder).not.toHaveBeenCalled();
		expect(checkAncestorRepo).not.toHaveBeenCalled();
	});
});
