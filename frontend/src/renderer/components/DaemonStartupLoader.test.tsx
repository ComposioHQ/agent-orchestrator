import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../../api/schema";
import { DaemonStartupLoader } from "./DaemonStartupLoader";

type Requirement = components["schemas"]["SystemRequirement"];
type InstallJob = components["schemas"]["InstallJob"];

const { getMock, postMock } = vi.hoisted(() => ({
	getMock: vi.fn(),
	postMock: vi.fn(),
}));

vi.mock("../lib/api-client", () => ({
	apiClient: {
		GET: (...args: unknown[]) => getMock(...args),
		POST: (...args: unknown[]) => postMock(...args),
	},
	apiErrorMessage: (error: unknown, fallback = "Request failed") => {
		if (typeof error === "object" && error !== null && "message" in error) {
			return String((error as { message: unknown }).message);
		}
		return fallback;
	},
}));

const REQUIREMENT_DEFAULTS: Record<Requirement["id"], Requirement> = {
	git: { id: "git", label: "git", satisfied: true, required: true, detail: "/usr/bin/git" },
	tmux: { id: "tmux", label: "tmux", satisfied: true, required: true, detail: "/opt/homebrew/bin/tmux" },
	harness: { id: "harness", label: "agent harness", satisfied: true, required: true, detail: "Claude Code" },
	gh: { id: "gh", label: "gh", satisfied: true, required: false, detail: "/usr/bin/gh" },
};

function requirementsResponse(
	overrides: Partial<Record<Requirement["id"], Partial<Requirement>>> = {},
): components["schemas"]["SystemRequirementsResponse"] {
	const ids: Requirement["id"][] = ["git", "tmux", "harness", "gh"];
	const requirements = ids.map((id) => ({ ...REQUIREMENT_DEFAULTS[id], ...overrides[id] }));
	return { ready: requirements.every((requirement) => !requirement.required || requirement.satisfied), requirements };
}

function renderLoader() {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<DaemonStartupLoader />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	getMock.mockReset();
	postMock.mockReset();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("DaemonStartupLoader", () => {
	it("renders the checklist from the requirements response in backend order", async () => {
		getMock.mockImplementation(async (path: string) => {
			if (path === "/api/v1/system/requirements") return { data: requirementsResponse(), error: undefined };
			throw new Error(`unexpected GET ${path}`);
		});

		renderLoader();

		await waitFor(() => expect(screen.getByText("/opt/homebrew/bin/tmux")).toBeInTheDocument());
		// harness is relabeled "Coding agent" in the UI, never the backend's "agent harness".
		expect(screen.getByText("Coding agent")).toBeInTheDocument();
		expect(screen.queryByText("agent harness")).not.toBeInTheDocument();

		const text = document.body.textContent ?? "";
		expect(text.indexOf("git")).toBeLessThan(text.indexOf("tmux"));
		expect(text.indexOf("tmux")).toBeLessThan(text.indexOf("Coding agent"));
		expect(text.indexOf("Coding agent")).toBeLessThan(text.indexOf("gh"));
	});

	it("blocks with 'Missing dependency' when tmux is unsatisfied", async () => {
		getMock.mockImplementation(async (path: string) => {
			if (path === "/api/v1/system/requirements") {
				return {
					data: requirementsResponse({
						tmux: { satisfied: false, detail: "tmux was not found on PATH." },
					}),
					error: undefined,
				};
			}
			throw new Error(`unexpected GET ${path}`);
		});

		renderLoader();

		expect(await screen.findByRole("dialog", { name: "Missing dependency" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Install tmux" })).toBeInTheDocument();
	});

	it("titles the blocking modal 'No coding agent found' when the harness check fails, even if tmux also fails", async () => {
		getMock.mockImplementation(async (path: string) => {
			if (path === "/api/v1/system/requirements") {
				return {
					data: requirementsResponse({
						tmux: { satisfied: false, detail: "tmux was not found on PATH." },
						harness: { satisfied: false, detail: "No agent CLI was found on PATH." },
					}),
					error: undefined,
				};
			}
			throw new Error(`unexpected GET ${path}`);
		});

		renderLoader();

		expect(await screen.findByRole("dialog", { name: "No coding agent found" })).toBeInTheDocument();
		// Both issues still surface in the body.
		expect(screen.getByRole("button", { name: "Install tmux" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Install selected" })).toBeInTheDocument();
	});

	it("shows no popup for an unsatisfied gh when nothing required is missing", async () => {
		getMock.mockImplementation(async (path: string) => {
			if (path === "/api/v1/system/requirements") {
				return {
					data: requirementsResponse({ gh: { satisfied: false, detail: "gh was not found on PATH." } }),
					error: undefined,
				};
			}
			throw new Error(`unexpected GET ${path}`);
		});

		renderLoader();

		await waitFor(() => expect(screen.getByText("gh was not found on PATH.")).toBeInTheDocument());
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("disables install until an agent is selected in the picker", async () => {
		getMock.mockImplementation(async (path: string) => {
			if (path === "/api/v1/system/requirements") {
				return {
					data: requirementsResponse({ harness: { satisfied: false, detail: "No agent CLI was found on PATH." } }),
					error: undefined,
				};
			}
			throw new Error(`unexpected GET ${path}`);
		});

		renderLoader();
		const user = userEvent.setup();

		await screen.findByRole("dialog", { name: "No coding agent found" });
		const installButton = screen.getByRole("button", { name: "Install selected" });
		expect(installButton).toBeDisabled();

		await user.click(screen.getByRole("radio", { name: /Claude Code/ }));
		expect(installButton).toBeEnabled();
	});

	it("closes the modal and falls through to phrase rotation once a running install succeeds", async () => {
		vi.useFakeTimers();
		let requirementsCalls = 0;
		getMock.mockImplementation(async (path: string, options?: { params?: { path?: { target?: string } } }) => {
			if (path === "/api/v1/system/requirements") {
				requirementsCalls += 1;
				const data =
					requirementsCalls === 1
						? requirementsResponse({ tmux: { satisfied: false, detail: "tmux was not found on PATH." } })
						: requirementsResponse();
				return { data, error: undefined };
			}
			if (path === "/api/v1/system/install/{target}") {
				const job: InstallJob = { target: options?.params?.path?.target as InstallJob["target"], status: "succeeded" };
				return { data: job, error: undefined };
			}
			throw new Error(`unexpected GET ${path}`);
		});
		postMock.mockResolvedValue({
			data: { target: "tmux", status: "running", command: "brew install tmux" },
			error: undefined,
		});

		renderLoader();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});

		expect(screen.getByRole("dialog", { name: "Missing dependency" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Install tmux" }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(screen.getByText(/Installing/)).toBeInTheDocument();

		// Fire the poll interval's single tick under fake timers, then switch to
		// real timers: the "succeeded" status it returns fans out through a
		// react-query refetch (a plain promise chain, not a timer) and then the
		// component's own real 700ms "All checks passed" hold — both settle on
		// real wall-clock ticks that waitFor can poll for.
		act(() => {
			vi.advanceTimersByTime(1_000);
		});
		vi.useRealTimers();

		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		await waitFor(() => expect(screen.getByText("Starting local services")).toBeInTheDocument());
	});

	it("shows the error and output, and offers a retry, when the install job fails", async () => {
		vi.useFakeTimers();
		getMock.mockImplementation(async (path: string) => {
			if (path === "/api/v1/system/requirements") {
				return {
					data: requirementsResponse({ tmux: { satisfied: false, detail: "tmux was not found on PATH." } }),
					error: undefined,
				};
			}
			if (path === "/api/v1/system/install/{target}") {
				const job: InstallJob = {
					target: "tmux",
					status: "failed",
					command: "brew install tmux",
					error: "brew: command not found",
					output: "bash: brew: command not found\n",
				};
				return { data: job, error: undefined };
			}
			throw new Error(`unexpected GET ${path}`);
		});
		postMock.mockResolvedValue({
			data: { target: "tmux", status: "running", command: "brew install tmux" },
			error: undefined,
		});

		renderLoader();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});

		expect(screen.getByRole("dialog", { name: "Missing dependency" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Install tmux" }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1_000);
		});

		expect(screen.getByText("brew: command not found")).toBeInTheDocument();
		expect(screen.getByText(/bash: brew: command not found/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Retry: Install tmux" })).toBeInTheDocument();
	});
});
