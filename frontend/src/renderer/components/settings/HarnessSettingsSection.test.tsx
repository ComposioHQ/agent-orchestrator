import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../lib/api-client";
import { appI18n } from "../../i18n";
import { agentsQueryKey, type AgentCatalog } from "../../hooks/useAgentsQuery";
import { useUiStore } from "../../stores/ui-store";
import { HarnessSettingsSection } from "./HarnessSettingsSection";

function catalogWithInstalled(...installed: string[]) {
	return {
		agents: [
			{ id: "claude-code", label: "Claude Code" },
			{ id: "codex", label: "Codex" },
			{ id: "cursor", label: "Cursor" },
			{ id: "goose", label: "Goose" },
		].map((agent) => ({
			...agent,
			installation: { state: installed.includes(agent.id) ? "installed" : "not_installed", freshness: "fresh", reason: "", reasonCode: "", attemptedAt: null, checkedAt: null },
			authentication: { state: "unknown", freshness: "fresh", reason: "", reasonCode: "", attemptedAt: null, checkedAt: null },
			effectiveReadiness: installed.includes(agent.id) ? "ready" : "not_ready",
			usageCount: 0,
		})),
	};
}

const catalog = catalogWithInstalled("claude-code");

const authPlans = {
	plans: [
		{ agentId: "claude-code", action: "login", available: true, documentationUrl: "https://example.test/claude" },
		{ agentId: "codex", action: "login", available: true, documentationUrl: "https://example.test/codex" },
		{ agentId: "aider", action: "setup", available: true, documentationUrl: "https://example.test/aider" },
	],
};

const plans = {
	agents: [
		{
			agentId: "claude-code", available: true, automatic: true, method: "homebrew",
			command: "brew install --cask claude-code", documentationUrl: "https://code.claude.com/docs/en/installation",
			methods: [{ id: "homebrew", label: "Homebrew", available: true, recommended: true, command: "brew install --cask claude-code", reinstallAvailable: true, reinstallCommand: "brew reinstall --cask claude-code" }],
		},
		{
			agentId: "codex", available: true, automatic: true, method: "homebrew",
			command: "brew install --cask codex", documentationUrl: "https://github.com/openai/codex",
			methods: [
				{ id: "homebrew", label: "Homebrew", available: true, recommended: true, command: "brew install --cask codex", reinstallAvailable: true, reinstallCommand: "brew reinstall --cask codex" },
				{ id: "npm", label: "npm", available: true, recommended: false, command: "npm install -g @openai/codex", expectedDestination: "/Users/test/.npm/bin", reinstallAvailable: true, reinstallCommand: "npm install -g @openai/codex --force" },
			],
		},
		{
			agentId: "aider", available: true, automatic: true, method: "pipx",
			command: "pipx install aider-chat", documentationUrl: "https://aider.chat/docs/install.html",
			methods: [{ id: "pipx", label: "pipx", available: true, recommended: true, command: "pipx install aider-chat", reinstallAvailable: true, reinstallCommand: "pipx reinstall aider-chat" }],
		},
		{
			agentId: "cursor", available: true, automatic: true, method: "official-installer",
			command: "bash <downloaded from https://cursor.com/install>", documentationUrl: "https://cursor.com/cli",
			methods: [{ id: "official-installer", label: "Official installer", available: true, recommended: true, command: "bash <downloaded from https://cursor.com/install>", reinstallAvailable: false, reinstallReason: "No headless reinstall" }],
		},
		{
			agentId: "goose", available: false, automatic: false, method: "manual",
			reason: "Goose does not publish a native Windows CLI installer; use WSL or the desktop download.",
			documentationUrl: "https://block.github.io/goose/index.html", methods: [],
		},
	],
};

function renderSection() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const view = render(
		<QueryClientProvider client={client}>
			<HarnessSettingsSection />
		</QueryClientProvider>,
	);
	return { ...view, queryClient: client };
}

describe("HarnessSettingsSection", () => {
	beforeEach(async () => {
		await appI18n.changeLanguage("en");
		window.ao!.clipboard.writeText = vi.fn().mockResolvedValue(undefined);
		useUiStore.setState({ agentAuthTerminalRequest: null, agentAuthCheckRequest: null });
		vi.spyOn(apiClient, "GET").mockImplementation(async (path) => {
			if (path === "/api/v1/agents/readiness") return { data: catalog } as never;
			if (path === "/api/v1/agents/installers") return { data: plans } as never;
			if (path === "/api/v1/agents/install-jobs") return { data: { jobs: [] } } as never;
			if (path === "/api/v1/agents/auth-plans") return { data: authPlans } as never;
			return { data: undefined } as never;
		});
		vi.spyOn(apiClient, "POST").mockImplementation(async (path) => {
			if (path === "/api/v1/agents/readiness/ensure") return { data: catalog } as never;
			if (path === "/api/v1/agents/refresh") return { data: catalog } as never;
			if (path === "/api/v1/agents/{agent}/install") {
				return { data: { target: "codex", status: "failed", error: "npm failed" } } as never;
			}
			return { data: undefined } as never;
		});
	});

	afterEach(() => vi.restoreAllMocks());

	it("keeps authentication controls hidden until a harness is installed", async () => {
		renderSection();
		await waitFor(() => expect(screen.getByText("1 of 27 installed")).toBeInTheDocument(), { timeout: 10_000 });
		const codexRow = screen.getByText("Codex").closest('[data-agent="codex"]');
		expect(codexRow).not.toBeNull();
		expect(within(codexRow as HTMLElement).getByRole("button", { name: "Install" })).toBeInTheDocument();
		expect(within(codexRow as HTMLElement).queryByRole("button", { name: "Login" })).not.toBeInTheDocument();
	});

	it("shows login, setup, instructions, unavailable, and authorized states", async () => {
		const rowCatalog = {
			supported: [
				{ id: "claude-code", label: "Claude Code" }, { id: "codex", label: "Codex" },
				{ id: "aider", label: "Aider" }, { id: "devin", label: "Devin" }, { id: "goose", label: "Goose" },
			],
			installed: [
				{ id: "claude-code", label: "Claude Code", authStatus: "authorized" },
				{ id: "codex", label: "Codex", authStatus: "unauthorized" },
				{ id: "aider", label: "Aider", authStatus: "unknown" },
				{ id: "devin", label: "Devin", authStatus: "unknown" },
				{ id: "goose", label: "Goose", authStatus: "unknown" },
			],
			authorized: [{ id: "claude-code", label: "Claude Code", authStatus: "authorized" }],
		};
		const rowPlans = { plans: [
			{ agentId: "claude-code", action: "login", available: true, documentationUrl: "https://example.test/claude" },
			{ agentId: "codex", action: "login", available: true, documentationUrl: "https://example.test/codex" },
			{ agentId: "aider", action: "setup", available: true, documentationUrl: "https://example.test/aider" },
			{ agentId: "devin", action: "instructions", available: true, documentationUrl: "https://example.test/devin" },
			{ agentId: "goose", action: "setup", available: false, reason: "goose is not on PATH", documentationUrl: "https://example.test/goose" },
		] };
		vi.mocked(apiClient.GET).mockImplementation(async (path) => {
			if (path === "/api/v1/agents") return { data: rowCatalog } as never;
			if (path === "/api/v1/agents/installers") return { data: plans } as never;
			if (path === "/api/v1/agents/auth-plans") return { data: rowPlans } as never;
			return { data: undefined } as never;
		});
		vi.mocked(apiClient.POST).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/refresh") return { data: rowCatalog } as never;
			return { data: undefined } as never;
		});

		renderSection();
		const claudeRow = (await screen.findByText("Claude Code")).closest('[data-agent="claude-code"]') as HTMLElement;
		const codexRow = screen.getByText("Codex").closest('[data-agent="codex"]') as HTMLElement;
		const aiderRow = screen.getByText("Aider").closest('[data-agent="aider"]') as HTMLElement;
		const devinRow = screen.getByText("Devin").closest('[data-agent="devin"]') as HTMLElement;
		const gooseRow = screen.getByText("Goose").closest('[data-agent="goose"]') as HTMLElement;

		await waitFor(() => expect(within(claudeRow).getAllByText("Logged in")).toHaveLength(2));
		expect(within(claudeRow).queryByRole("button", { name: "Check login" })).not.toBeInTheDocument();
		expect(within(codexRow).getByRole("button", { name: "Login" })).toBeInTheDocument();
		expect(within(codexRow).getByRole("button", { name: "Check login" })).toBeInTheDocument();
		expect(within(aiderRow).getByRole("button", { name: "Set up" })).toBeInTheDocument();
		expect(within(aiderRow).getByRole("button", { name: "Check login" })).toBeInTheDocument();
		expect(aiderRow).toHaveTextContent("Login status unknown");
		expect(within(devinRow).getByRole("button", { name: "Instructions" })).toBeInTheDocument();
		expect(within(gooseRow).getByRole("button", { name: "Set up" })).toBeDisabled();
		expect(gooseRow).toHaveTextContent("goose is not on PATH");
	});

	it("requests the returned authentication terminal when Login is clicked", async () => {
		const unauthorized = {
			...catalog,
			installed: [{ id: "codex", label: "Codex", authStatus: "unauthorized" }],
			authorized: [],
		};
		vi.mocked(apiClient.GET).mockImplementation(async (path) => {
			if (path === "/api/v1/agents") return { data: unauthorized } as never;
			if (path === "/api/v1/agents/installers") return { data: plans } as never;
			if (path === "/api/v1/agents/auth-plans") return { data: authPlans } as never;
			return { data: undefined } as never;
		});
		vi.mocked(apiClient.POST).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/{agent}/auth") {
				return { data: { agentId: "codex", action: "login", terminal: { handleId: "shellterm-login", workingDir: "/tmp/ao", title: "Log in to Codex", createdAt: new Date().toISOString() } } } as never;
			}
			return { data: undefined } as never;
		});
		const user = userEvent.setup();
		renderSection();
		const codexRow = (await screen.findByText("Codex")).closest('[data-agent="codex"]') as HTMLElement;

		await user.click(await within(codexRow).findByRole("button", { name: "Login" }));

		await waitFor(() => expect(useUiStore.getState().agentAuthTerminalRequest?.handleId).toBe("shellterm-login"));
		expect(useUiStore.getState().agentAuthTerminalRequest?.agentId).toBe("codex");
	});

	it("rechecks the selected agent when Settings reopens after login", async () => {
		let currentCatalog = {
			...catalog,
			installed: [{ id: "codex", label: "Codex", authStatus: "unauthorized" }],
			authorized: [] as typeof catalog.authorized,
		};
		vi.mocked(apiClient.GET).mockImplementation(async (path) => {
			if (path === "/api/v1/agents") return { data: currentCatalog } as never;
			if (path === "/api/v1/agents/installers") return { data: plans } as never;
			if (path === "/api/v1/agents/auth-plans") return { data: authPlans } as never;
			return { data: undefined } as never;
		});
		vi.mocked(apiClient.POST).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/refresh") return { data: currentCatalog } as never;
			if (path === "/api/v1/agents/{agent}/auth") {
				return { data: { agentId: "codex", action: "login", terminal: { handleId: "shellterm-login", workingDir: "/tmp/ao", title: "Log in to Codex", createdAt: new Date().toISOString() } } } as never;
			}
			if (path === "/api/v1/agents/{agent}/probe") {
				const agent = { id: "codex", label: "Codex", authStatus: "authorized" };
				currentCatalog = { ...currentCatalog, installed: [agent], authorized: [agent] };
				return { data: { agent, supported: true, installed: true } } as never;
			}
			return { data: undefined } as never;
		});
		const user = userEvent.setup();
		const first = renderSection();
		const firstCodexRow = (await screen.findByText("Codex")).closest('[data-agent="codex"]') as HTMLElement;
		expect(await within(firstCodexRow).findByRole("button", { name: "Check login" })).toBeInTheDocument();
		await user.click(await within(firstCodexRow).findByRole("button", { name: "Login" }));
		await waitFor(() => expect(useUiStore.getState().agentAuthTerminalRequest?.handleId).toBe("shellterm-login"));
		first.unmount();

		useUiStore.getState().openGlobalSettings();
		expect(useUiStore.getState().agentAuthCheckRequest?.agentId).toBe("codex");
		const second = renderSection();

		await screen.findByText("Codex");
		await waitFor(() => expect(apiClient.POST).toHaveBeenCalledWith("/api/v1/agents/{agent}/probe", {
			params: { path: { agent: "codex" } },
		}));
		await waitFor(() => expect((second.queryClient.getQueryData<AgentCatalog>(agentsQueryKey)?.installed[0])?.authStatus).toBe("authorized"));
		await waitFor(() => {
			const codexRow = screen.getByText("Codex").closest('[data-agent="codex"]') as HTMLElement;
			expect(within(codexRow).getAllByText("Logged in")).toHaveLength(2);
		});
		expect(useUiStore.getState().agentAuthCheckRequest).toBeNull();
	});

	it("refreshes authentication availability after installation succeeds", async () => {
		let authPlanRequests = 0;
		let currentCatalog = {
			supported: [{ id: "codex", label: "Codex" }],
			installed: [] as typeof catalog.installed,
			authorized: [] as typeof catalog.authorized,
		};
		vi.mocked(apiClient.GET).mockImplementation(async (path) => {
			if (path === "/api/v1/agents") return { data: currentCatalog } as never;
			if (path === "/api/v1/agents/installers") return { data: plans } as never;
			if (path === "/api/v1/agents/auth-plans") {
				authPlanRequests += 1;
				return { data: { plans: [{
					agentId: "codex", action: "login", available: authPlanRequests > 1,
					reason: authPlanRequests > 1 ? undefined : "codex was not found on PATH.",
					documentationUrl: "https://example.test/codex",
				}] } } as never;
			}
			if (path === "/api/v1/agents/{agent}/install") {
				return { data: { target: "codex", status: "succeeded" } } as never;
			}
			return { data: undefined } as never;
		});
		vi.mocked(apiClient.POST).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/refresh") return { data: currentCatalog } as never;
			if (path === "/api/v1/agents/{agent}/install") {
				return { data: { target: "codex", status: "running" } } as never;
			}
			if (path === "/api/v1/agents/{agent}/probe") {
				const agent = { id: "codex", label: "Codex", authStatus: "unknown" };
				currentCatalog = { ...currentCatalog, installed: [agent] };
				return { data: { agent, supported: true, installed: true } } as never;
			}
			return { data: undefined } as never;
		});
		const user = userEvent.setup();
		renderSection();
		const codexRow = (await screen.findByText("Codex")).closest('[data-agent="codex"]') as HTMLElement;

		await user.click(await within(codexRow).findByRole("button", { name: "Install" }));

		await waitFor(() => expect(authPlanRequests).toBeGreaterThanOrEqual(2), { timeout: 4_000 });
		expect(within(codexRow).getByRole("button", { name: "Login" })).toBeEnabled();
	}, 6_000);

	it("starts the fixed daemon install route and exposes retry after failure", async () => {
		const user = userEvent.setup();
		renderSection();
		await screen.findByText("Codex");
		const codexRow = document.querySelector('[data-agent="codex"]');
		expect(codexRow).not.toBeNull();
		await waitFor(() => expect(codexRow).toHaveTextContent("Available via Homebrew"), { timeout: 10_000 });
		await user.selectOptions(within(codexRow as HTMLElement).getByRole("combobox", { name: "Installation method" }), "npm");
		await user.click(within(codexRow as HTMLElement).getByRole("button", { name: "Install" }));

		await waitFor(() => expect(apiClient.POST).toHaveBeenCalledWith("/api/v1/agents/{agent}/install", {
			params: { path: { agent: "codex" } },
			body: { method: "npm", operation: "install" },
		}));
		await waitFor(() => expect(codexRow).toHaveTextContent("npm failed"));
		expect(codexRow).toHaveTextContent("Retry");
		await user.selectOptions(within(codexRow as HTMLElement).getByRole("combobox", { name: "Installation method" }), "homebrew");
		await user.click(within(codexRow as HTMLElement).getByRole("button", { name: "Retry" }));
		await waitFor(() => expect(apiClient.POST).toHaveBeenLastCalledWith("/api/v1/agents/{agent}/install", {
			params: { path: { agent: "codex" } },
			body: { method: "homebrew", operation: "install" },
		}));
	});

	it("allows an installed harness to be reinstalled with its recommended method", async () => {
		const user = userEvent.setup();
		renderSection();
		const row = (await screen.findByText("Claude Code")).closest('[data-agent="claude-code"]') as HTMLElement;
		const reinstall = await within(row).findByRole("button", { name: "Reinstall" });

		await user.click(reinstall);

		await waitFor(() => expect(apiClient.POST).toHaveBeenCalledWith("/api/v1/agents/{agent}/install", {
			params: { path: { agent: "claude-code" } },
			body: { method: "homebrew", operation: "reinstall" },
		}));
	});

	it("shows vendor instructions when an installed harness has no headless reinstall method", async () => {
		vi.mocked(apiClient.GET).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/readiness") return { data: catalogWithInstalled("claude-code", "cursor") } as never;
			if (path === "/api/v1/agents/installers") return { data: plans } as never;
			if (path === "/api/v1/agents/install-jobs") return { data: { jobs: [] } } as never;
			return { data: undefined } as never;
		});
		renderSection();
		const row = (await screen.findByText("Cursor")).closest('[data-agent="cursor"]') as HTMLElement;

		expect(await within(row).findByRole("button", { name: "Instructions" })).toBeEnabled();
		expect(within(row).queryByRole("button", { name: "Reinstall" })).not.toBeInTheDocument();
	});

	it("starts an official vendor installer with one click and no instructions dialog", async () => {
		vi.mocked(apiClient.POST).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/{agent}/install") {
				return { data: { target: "cursor", status: "installing", method: "official-installer" } } as never;
			}
			return { data: undefined } as never;
		});
		const user = userEvent.setup();
		renderSection();
		const row = (await screen.findByText("Cursor")).closest('[data-agent="cursor"]') as HTMLElement;
		await waitFor(() => expect(row).toHaveTextContent("Available via Official installer"));
		expect(within(row).queryByRole("button", { name: "Instructions" })).not.toBeInTheDocument();

		await user.click(within(row).getByRole("button", { name: "Install" }));

		await waitFor(() => expect(apiClient.POST).toHaveBeenCalledWith("/api/v1/agents/{agent}/install", {
			params: { path: { agent: "cursor" } },
			body: { method: "official-installer", operation: "install" },
		}));
		expect(row).toHaveTextContent("Installing…");
	});

	it("keeps unsupported native Windows harnesses on vendor instructions", async () => {
		renderSection();
		const row = (await screen.findByText("Goose")).closest('[data-agent="goose"]') as HTMLElement;
		expect(await within(row).findByRole("button", { name: "Instructions" })).toBeEnabled();
		expect(within(row).queryByRole("button", { name: "Install" })).not.toBeInTheDocument();
	});

	it("does not treat a historical successful job as current installation inventory", async () => {
		vi.mocked(apiClient.GET).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/readiness") return { data: catalog } as never;
			if (path === "/api/v1/agents/installers") return { data: plans } as never;
			if (path === "/api/v1/agents/install-jobs") return { data: { jobs: [{ target: "codex", status: "succeeded", method: "npm", updatedAt: "2026-08-01T00:00:00Z" }] } } as never;
			return { data: undefined } as never;
		});
		renderSection();
		const row = (await screen.findByText("Codex")).closest('[data-agent="codex"]') as HTMLElement;
		await waitFor(() => expect(row).toHaveTextContent("Available via npm"));
		expect(within(row).getByRole("button", { name: "Install" })).toBeEnabled();
	});

	it("probes the installed harness before refreshing inventory after success", async () => {
		let installed = false;
		let installerFetches = 0;
		vi.mocked(apiClient.GET).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/readiness") return { data: installed ? catalogWithInstalled("claude-code", "codex") : catalog } as never;
			if (path === "/api/v1/agents/installers") {
				installerFetches += 1;
				return { data: plans } as never;
			}
			if (path === "/api/v1/agents/install-jobs") return { data: { jobs: [{ target: "codex", status: "succeeded", method: "npm", updatedAt: "2026-08-31T00:00:00Z" }] } } as never;
			return { data: undefined } as never;
		});
		vi.mocked(apiClient.POST).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/{agent}/probe") {
				installed = true;
				return { data: { agent: { id: "codex", label: "Codex" }, supported: true, installed: true } } as never;
			}
			if (path === "/api/v1/agents/readiness/ensure") {
				return { data: installed ? catalogWithInstalled("claude-code", "codex") : catalog } as never;
			}
			return { data: undefined } as never;
		});
		renderSection();
		const row = (await screen.findByText("Codex")).closest('[data-agent="codex"]') as HTMLElement;
		await waitFor(() => expect(apiClient.POST).toHaveBeenCalledWith("/api/v1/agents/{agent}/probe", { params: { path: { agent: "codex" } } }));
		await waitFor(() => expect(row).toHaveTextContent("Installed"));
		await waitFor(() => expect(installerFetches).toBe(2));
	});

	it("admits only one install request per harness while the first POST is pending", async () => {
		let resolveInstall!: (value: unknown) => void;
		let installCalls = 0;
		const pendingInstall = new Promise((resolve) => { resolveInstall = resolve; });
		vi.mocked(apiClient.POST).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/{agent}/install") {
				installCalls += 1;
				return await pendingInstall as never;
			}
			return { data: undefined } as never;
		});
		const user = userEvent.setup();
		renderSection();
		const row = (await screen.findByText("Codex")).closest('[data-agent="codex"]') as HTMLElement;
		const button = await within(row).findByRole("button", { name: "Install" });
		await user.dblClick(button);
		expect(installCalls).toBe(1);
		resolveInstall({ data: { target: "codex", status: "installing", method: "homebrew" } });
		await waitFor(() => expect(row).toHaveTextContent("Installing…"));
	});

	it("keeps concurrent installs independent with only one spinner status per row", async () => {
		vi.mocked(apiClient.POST).mockImplementation(async (path, options) => {
			if (path === "/api/v1/agents/{agent}/install") {
				const agent = (options as { params: { path: { agent: string } } }).params.path.agent;
				return { data: { target: agent, status: "installing" } } as never;
			}
			return { data: undefined } as never;
		});
		const user = userEvent.setup();
		renderSection();
		const codexRow = (await screen.findByText("Codex")).closest('[data-agent="codex"]');
		const aiderRow = (await screen.findByText("Aider")).closest('[data-agent="aider"]');
		expect(codexRow).not.toBeNull();
		expect(aiderRow).not.toBeNull();
		await waitFor(() => expect(within(codexRow as HTMLElement).getByRole("button", { name: "Install" })).toBeEnabled());

		await user.click(within(codexRow as HTMLElement).getByRole("button", { name: "Install" }));
		const codexStatus = await within(codexRow as HTMLElement).findByRole("status");
		await user.click(within(aiderRow as HTMLElement).getByRole("button", { name: "Install" }));

		const aiderStatus = await within(aiderRow as HTMLElement).findByRole("status");
		expect(codexStatus.querySelector("svg.animate-spin")).not.toBeNull();
		expect(aiderStatus.querySelector("svg.animate-spin")).not.toBeNull();
		expect(within(codexRow as HTMLElement).queryByRole("progressbar")).not.toBeInTheDocument();
		expect(within(aiderRow as HTMLElement).queryByRole("progressbar")).not.toBeInTheDocument();
		expect(within(codexRow as HTMLElement).getAllByText("Installing…")).toHaveLength(1);
		expect(within(aiderRow as HTMLElement).getAllByText("Installing…")).toHaveLength(1);
	});

	it("hydrates interrupted jobs and offers separate verify and reinstall actions", async () => {
		vi.mocked(apiClient.GET).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/readiness") return { data: catalog } as never;
			if (path === "/api/v1/agents/installers") return { data: plans } as never;
			if (path === "/api/v1/agents/install-jobs") return { data: { jobs: [{ target: "codex", status: "interrupted", method: "npm", error: "AO restarted", output: "partial output", expectedDestination: "/Users/test/.npm/bin/codex" }] } } as never;
			return { data: undefined } as never;
		});
		vi.mocked(apiClient.POST).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/{agent}/verify") return { data: { target: "codex", status: "verifying" } } as never;
			if (path === "/api/v1/agents/{agent}/install") return { data: { target: "codex", status: "installing", method: "npm" } } as never;
			return { data: undefined } as never;
		});
		const user = userEvent.setup();
		renderSection();
		const row = (await screen.findByText("Codex")).closest('[data-agent="codex"]') as HTMLElement;
		await waitFor(() => expect(row).toHaveTextContent("Interrupted"));
		await user.click(within(row).getByRole("button", { name: "Verify again" }));
		expect(apiClient.POST).toHaveBeenCalledWith("/api/v1/agents/{agent}/verify", { params: { path: { agent: "codex" } } });
		await waitFor(() => expect(row).toHaveTextContent("Verifying…"));
	});

	it("shows and copies daemon diagnostics", async () => {
		vi.mocked(apiClient.GET).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/readiness") return { data: catalog } as never;
			if (path === "/api/v1/agents/installers") return { data: plans } as never;
			if (path === "/api/v1/agents/install-jobs") return { data: { jobs: [{ target: "codex", status: "failed", method: "npm", error: "exit status 1", output: "permission denied", expectedDestination: "/Users/test/.npm/bin/codex" }] } } as never;
			return { data: undefined } as never;
		});
		const user = userEvent.setup();
		renderSection();
		const row = (await screen.findByText("Codex")).closest('[data-agent="codex"]') as HTMLElement;
		await user.click(await within(row).findByRole("button", { name: "Show diagnostics" }));
		expect(row).toHaveTextContent("permission denied");
		expect(row).toHaveTextContent("/Users/test/.npm/bin/codex");
		await user.click(within(row).getByRole("button", { name: "Copy diagnostics" }));
		expect(window.ao!.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("permission denied"));
	});

	it("surfaces install job polling failures", async () => {
		vi.mocked(apiClient.GET).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/readiness") return { data: catalog } as never;
			if (path === "/api/v1/agents/installers") return { data: plans } as never;
			if (path === "/api/v1/agents/install-jobs") return { error: { error: { message: "Could not poll installation status." } } } as never;
			return { data: undefined } as never;
		});
		renderSection();
		expect(await screen.findByText("Could not poll installation status.")).toBeInTheDocument();
	});
});
