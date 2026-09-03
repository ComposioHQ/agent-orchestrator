import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../lib/api-client";
import { appI18n } from "../../i18n";
import { useUiStore } from "../../stores/ui-store";
import { HarnessSettingsSection } from "./HarnessSettingsSection";

const terminalMock = vi.hoisted(() => ({
	onStateChange: null as ((state: "connecting" | "attached" | "exited" | "error") => void) | null,
	onInputRequestResult: null as ((id: number, accepted: boolean) => void) | null,
	inputRequest: undefined as { id: number; data: string } | undefined,
}));

vi.mock("../TerminalPane", () => ({
	TerminalPane: (props: {
		onInputRequestResult?: typeof terminalMock.onInputRequestResult;
		onTerminalStateChange?: typeof terminalMock.onStateChange;
		inputRequest?: typeof terminalMock.inputRequest;
	}) => {
		terminalMock.onInputRequestResult = props.onInputRequestResult ?? null;
		terminalMock.onStateChange = props.onTerminalStateChange ?? null;
		terminalMock.inputRequest = props.inputRequest;
		return <div data-testid="inline-harness-auth-terminal" />;
	},
}));

type TestAuthState = "authorized" | "unauthorized" | "unknown";

function readinessCatalog(installed: string[], authentication: Partial<Record<string, TestAuthState>> = {}) {
	return {
		agents: [
			{ id: "claude-code", label: "Claude Code" },
			{ id: "codex", label: "Codex" },
			{ id: "aider", label: "Aider" },
			{ id: "devin", label: "Devin" },
			{ id: "cursor", label: "Cursor" },
			{ id: "goose", label: "Goose" },
			{ id: "qwen", label: "Qwen" },
		].map((agent) => ({
			...agent,
			installation: { state: installed.includes(agent.id) ? "installed" : "not_installed", freshness: "fresh", reason: "", reasonCode: "", attemptedAt: null, checkedAt: null },
			authentication: { state: authentication[agent.id] ?? "unknown", freshness: "fresh", reason: "", reasonCode: "", attemptedAt: null, checkedAt: null },
			effectiveReadiness: installed.includes(agent.id) ? "ready" : "not_ready",
			usageCount: 0,
		})),
	};
}

function catalogWithInstalled(...installed: string[]) {
	return readinessCatalog(installed);
}

const catalog = readinessCatalog(["claude-code"], { "claude-code": "authorized" });

const authPlans = {
	plans: [
		{ agentId: "claude-code", action: "login", launchMode: "terminal", available: true, documentationUrl: "https://example.test/claude" },
		{ agentId: "codex", action: "login", launchMode: "terminal", available: true, documentationUrl: "https://example.test/codex" },
		{ agentId: "aider", action: "setup", launchMode: "documentation", available: true, documentationUrl: "https://example.test/aider" },
		{ agentId: "qwen", action: "setup", launchMode: "terminal", available: true, documentationUrl: "https://example.test/qwen" },
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
		terminalMock.onStateChange = null;
		terminalMock.onInputRequestResult = null;
		terminalMock.inputRequest = undefined;
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
		vi.spyOn(apiClient, "DELETE").mockResolvedValue({ data: undefined } as never);
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

	it("shows login, setup, unavailable, and authorized states", async () => {
		const rowCatalog = readinessCatalog(
			["claude-code", "codex", "aider", "devin", "goose"],
			{ "claude-code": "authorized", codex: "unauthorized", devin: "authorized" },
		);
		const rowPlans = { plans: [
			{ agentId: "claude-code", action: "login", launchMode: "terminal", available: true, documentationUrl: "https://example.test/claude" },
			{ agentId: "codex", action: "login", launchMode: "terminal", available: true, documentationUrl: "https://example.test/codex" },
			{ agentId: "aider", action: "setup", launchMode: "documentation", available: true, documentationUrl: "https://example.test/aider" },
			{ agentId: "devin", action: "login", launchMode: "terminal", available: true, documentationUrl: "https://example.test/devin" },
			{ agentId: "goose", action: "setup", launchMode: "terminal", available: false, reason: "goose is not on PATH", documentationUrl: "https://example.test/goose" },
		] };
		vi.mocked(apiClient.GET).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/readiness") return { data: rowCatalog } as never;
			if (path === "/api/v1/agents/installers") return { data: plans } as never;
			if (path === "/api/v1/agents/install-jobs") return { data: { jobs: [] } } as never;
			if (path === "/api/v1/agents/auth-plans") return { data: rowPlans } as never;
			return { data: undefined } as never;
		});
		vi.mocked(apiClient.POST).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/refresh") return { data: rowCatalog } as never;
			if (path === "/api/v1/agents/readiness/ensure") return { data: rowCatalog } as never;
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
		expect(within(aiderRow).getByRole("button", { name: "Check configuration" })).toBeInTheDocument();
		expect(aiderRow).toHaveTextContent("Configuration status unknown");
		expect(within(devinRow).getAllByText("Logged in")).toHaveLength(2);
		expect(within(devinRow).queryByRole("button", { name: "Instructions" })).not.toBeInTheDocument();
		expect(within(devinRow).queryByRole("button", { name: "Login" })).not.toBeInTheDocument();
		expect(within(devinRow).queryByRole("button", { name: "Check login" })).not.toBeInTheDocument();
		expect(within(gooseRow).getByRole("button", { name: "Set up" })).toBeDisabled();
		expect(gooseRow).toHaveTextContent("goose is not on PATH");
	});

	it("opens Aider's official setup documentation without starting a terminal", async () => {
		const aiderCatalog = readinessCatalog(["aider"], { aider: "unauthorized" });
		let authStarted = false;
		vi.mocked(apiClient.GET).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/readiness") return { data: aiderCatalog } as never;
			if (path === "/api/v1/agents/installers") return { data: plans } as never;
			if (path === "/api/v1/agents/install-jobs") return { data: { jobs: [] } } as never;
			if (path === "/api/v1/agents/auth-plans") return { data: authPlans } as never;
			return { data: undefined } as never;
		});
		vi.mocked(apiClient.POST).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/readiness/ensure") return { data: aiderCatalog } as never;
			if (path === "/api/v1/agents/{agent}/auth") authStarted = true;
			return { data: undefined } as never;
		});
		const openExternal = vi.spyOn(window.ao!.app, "openExternal").mockResolvedValue(undefined);
		const user = userEvent.setup();
		renderSection();
		const aiderRow = (await screen.findByText("Aider")).closest('[data-agent="aider"]') as HTMLElement;
		await waitFor(() => expect(aiderRow).toHaveTextContent("Not configured"));

		await user.click(await within(aiderRow).findByRole("button", { name: "Set up" }));

		expect(openExternal).toHaveBeenCalledWith("https://example.test/aider");
		expect(authStarted).toBe(false);
		expect(within(aiderRow).queryByTestId("harness-auth-terminal")).not.toBeInTheDocument();
		expect(within(aiderRow).getByRole("button", { name: "Check configuration" })).toBeInTheDocument();
	});

	it("sends an interactive login command only after the user selects Open login", async () => {
		const unauthorized = readinessCatalog(["codex"], { codex: "unauthorized" });
		vi.mocked(apiClient.GET).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/readiness") return { data: unauthorized } as never;
			if (path === "/api/v1/agents/installers") return { data: plans } as never;
			if (path === "/api/v1/agents/install-jobs") return { data: { jobs: [] } } as never;
			if (path === "/api/v1/agents/auth-plans") return { data: authPlans } as never;
			return { data: undefined } as never;
		});
		vi.mocked(apiClient.POST).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/readiness/ensure") return { data: unauthorized } as never;
			if (path === "/api/v1/agents/{agent}/auth") {
				return { data: { agentId: "codex", action: "login", terminalInput: "/login\r", terminal: { handleId: "shellterm-login", workingDir: "/tmp/ao", title: "Log in to Codex", createdAt: new Date().toISOString() } } } as never;
			}
			return { data: undefined } as never;
		});
		const user = userEvent.setup();
		renderSection();
		const codexRow = (await screen.findByText("Codex")).closest('[data-agent="codex"]') as HTMLElement;

		await user.click(await within(codexRow).findByRole("button", { name: "Login" }));

		expect(await within(codexRow).findByTestId("inline-harness-auth-terminal")).toBeInTheDocument();
		const openLogin = within(codexRow).getByRole("button", { name: "Open login" });
		expect(openLogin).toBeDisabled();
		expect(terminalMock.inputRequest).toBeUndefined();

		await act(async () => terminalMock.onStateChange?.("attached"));
		await user.click(openLogin);

		expect(terminalMock.inputRequest).toEqual({ id: 1, data: "/login\r" });
		await act(async () => terminalMock.onInputRequestResult?.(1, false));
		expect(terminalMock.inputRequest).toBeUndefined();
		expect(within(codexRow).getByRole("button", { name: "Open login" })).toBeEnabled();

		await user.click(within(codexRow).getByRole("button", { name: "Open login" }));
		expect(terminalMock.inputRequest).toEqual({ id: 2, data: "/login\r" });
		await act(async () => terminalMock.onInputRequestResult?.(2, true));

		expect(within(codexRow).getByRole("button", { name: "Login opened" })).toBeDisabled();
		expect(useUiStore.getState().activeShellTerminalHandleId).toBeNull();
	});

	it("labels Qwen provider configuration as setup", async () => {
		const unauthorized = readinessCatalog(["qwen"], { qwen: "unauthorized" });
		vi.mocked(apiClient.GET).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/readiness") return { data: unauthorized } as never;
			if (path === "/api/v1/agents/installers") return { data: plans } as never;
			if (path === "/api/v1/agents/install-jobs") return { data: { jobs: [] } } as never;
			if (path === "/api/v1/agents/auth-plans") return { data: authPlans } as never;
			return { data: undefined } as never;
		});
		vi.mocked(apiClient.POST).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/readiness/ensure") return { data: unauthorized } as never;
			if (path === "/api/v1/agents/{agent}/auth") {
				return { data: { agentId: "qwen", action: "setup", terminalInput: "i\x7f/auth\r", terminal: { handleId: "shellterm-qwen-setup", workingDir: "/tmp/ao", title: "Set up Qwen", createdAt: new Date().toISOString() } } } as never;
			}
			return { data: undefined } as never;
		});
		const user = userEvent.setup();
		renderSection();
		const qwenRow = (await screen.findByText("Qwen")).closest('[data-agent="qwen"]') as HTMLElement;

		await user.click(await within(qwenRow).findByRole("button", { name: "Set up" }));
		await act(async () => terminalMock.onStateChange?.("attached"));

		expect(within(qwenRow).queryByRole("button", { name: "Open login" })).not.toBeInTheDocument();
		await user.click(within(qwenRow).getByRole("button", { name: "Open setup" }));
		expect(terminalMock.inputRequest).toEqual({ id: 1, data: "i\x7f/auth\r" });
		await act(async () => terminalMock.onInputRequestResult?.(1, true));
		expect(within(qwenRow).getByRole("button", { name: "Setup opened" })).toBeDisabled();
	});

	it("verifies login and closes the inline terminal when the command exits", async () => {
		let currentCatalog = readinessCatalog(["codex"], { codex: "unauthorized" });
		vi.mocked(apiClient.GET).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/readiness") return { data: currentCatalog } as never;
			if (path === "/api/v1/agents/installers") return { data: plans } as never;
			if (path === "/api/v1/agents/install-jobs") return { data: { jobs: [] } } as never;
			if (path === "/api/v1/agents/auth-plans") return { data: authPlans } as never;
			return { data: undefined } as never;
		});
		vi.mocked(apiClient.POST).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/refresh") return { data: currentCatalog } as never;
			if (path === "/api/v1/agents/readiness/ensure") return { data: currentCatalog } as never;
			if (path === "/api/v1/agents/{agent}/auth") {
				return { data: { agentId: "codex", action: "login", terminal: { handleId: "shellterm-login", workingDir: "/tmp/ao", title: "Log in to Codex", createdAt: new Date().toISOString() } } } as never;
			}
			if (path === "/api/v1/agents/{agent}/probe") {
				currentCatalog = readinessCatalog(["codex"], { codex: "authorized" });
				const agent = { id: "codex", label: "Codex", authStatus: "authorized" };
				return { data: { agent, supported: true, installed: true } } as never;
			}
			return { data: undefined } as never;
		});
		const user = userEvent.setup();
		renderSection();
		const codexRow = (await screen.findByText("Codex")).closest('[data-agent="codex"]') as HTMLElement;
		await user.click(await within(codexRow).findByRole("button", { name: "Login" }));
		await within(codexRow).findByTestId("inline-harness-auth-terminal");
		await act(async () => terminalMock.onStateChange?.("exited"));

		await waitFor(() => expect(apiClient.POST).toHaveBeenCalledWith("/api/v1/agents/{agent}/probe", {
			params: { path: { agent: "codex" } },
		}));
		await waitFor(() => expect(apiClient.DELETE).toHaveBeenCalledWith("/api/v1/shell-terminals/{handleId}", {
			params: { path: { handleId: "shellterm-login" } },
		}));
		await waitFor(() => expect(within(codexRow).queryByTestId("inline-harness-auth-terminal")).not.toBeInTheDocument());
		expect(within(codexRow).getAllByText("Logged in")).toHaveLength(2);
	});

	it("does not verify or discard the workflow when the terminal attachment errors", async () => {
		const unauthorized = readinessCatalog(["codex"], { codex: "unauthorized" });
		vi.mocked(apiClient.GET).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/readiness") return { data: unauthorized } as never;
			if (path === "/api/v1/agents/installers") return { data: plans } as never;
			if (path === "/api/v1/agents/install-jobs") return { data: { jobs: [] } } as never;
			if (path === "/api/v1/agents/auth-plans") return { data: authPlans } as never;
			return { data: undefined } as never;
		});
		vi.mocked(apiClient.POST).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/readiness/ensure") return { data: unauthorized } as never;
			if (path === "/api/v1/agents/{agent}/auth") {
				return { data: { agentId: "codex", action: "login", terminal: { handleId: "shellterm-login", workingDir: "/tmp/ao", title: "Log in to Codex", createdAt: new Date().toISOString() } } } as never;
			}
			return { data: undefined } as never;
		});
		const user = userEvent.setup();
		renderSection();
		const codexRow = (await screen.findByText("Codex")).closest('[data-agent="codex"]') as HTMLElement;
		await user.click(await within(codexRow).findByRole("button", { name: "Login" }));
		await within(codexRow).findByTestId("harness-auth-terminal");

		await act(async () => terminalMock.onStateChange?.("error"));

		expect(within(codexRow).getByTestId("harness-auth-terminal")).toBeInTheDocument();
		expect(apiClient.POST).not.toHaveBeenCalledWith("/api/v1/agents/{agent}/probe", expect.anything());
		expect(apiClient.DELETE).not.toHaveBeenCalled();
	});

	it("keeps failed timeout cleanup retryable until terminal deletion succeeds", async () => {
		const unauthorized = readinessCatalog(["codex"], { codex: "unauthorized" });
		let timeoutCallback: (() => Promise<void>) | undefined;
		const realSetTimeout = window.setTimeout.bind(window);
		vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
			if (typeof handler === "function" && (timeout ?? 0) > 899_000) {
				timeoutCallback = handler as () => Promise<void>;
				return 999;
			}
			return realSetTimeout(handler, timeout, ...args);
		}) as typeof window.setTimeout);
		vi.mocked(apiClient.GET).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/readiness") return { data: unauthorized } as never;
			if (path === "/api/v1/agents/installers") return { data: plans } as never;
			if (path === "/api/v1/agents/install-jobs") return { data: { jobs: [] } } as never;
			if (path === "/api/v1/agents/auth-plans") return { data: authPlans } as never;
			return { data: undefined } as never;
		});
		vi.mocked(apiClient.POST).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/readiness/ensure") return { data: unauthorized } as never;
			if (path === "/api/v1/agents/{agent}/auth") {
				return { data: { agentId: "codex", action: "login", terminal: { handleId: "shellterm-login", workingDir: "/tmp/ao", title: "Log in to Codex", createdAt: new Date().toISOString() } } } as never;
			}
			if (path === "/api/v1/agents/{agent}/probe") {
				return { data: { agent: { id: "codex", label: "Codex", authStatus: "unauthorized" }, supported: true, installed: true } } as never;
			}
			return { data: undefined } as never;
		});
		vi.mocked(apiClient.DELETE).mockResolvedValueOnce({ error: { code: "DELETE_FAILED" } } as never).mockResolvedValue({ data: undefined } as never);
		const user = userEvent.setup();
		renderSection();
		const codexRow = (await screen.findByText("Codex")).closest('[data-agent="codex"]') as HTMLElement;
		await user.click(await within(codexRow).findByRole("button", { name: "Login" }));
		const panel = await within(codexRow).findByTestId("harness-auth-terminal");
		expect(timeoutCallback).toBeDefined();

		await act(async () => { await timeoutCallback?.(); });

		expect(panel).toBeInTheDocument();
		const retry = await within(panel).findByRole("button", { name: "Retry" });
		await user.click(retry);
		await waitFor(() => expect(apiClient.DELETE).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(within(codexRow).queryByTestId("harness-auth-terminal")).not.toBeInTheDocument());
	});

	it("retries after the daemon has already pruned the previous authentication terminal", async () => {
		const unauthorized = readinessCatalog(["codex"], { codex: "unauthorized" });
		let authStarts = 0;
		vi.mocked(apiClient.GET).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/readiness") return { data: unauthorized } as never;
			if (path === "/api/v1/agents/installers") return { data: plans } as never;
			if (path === "/api/v1/agents/install-jobs") return { data: { jobs: [] } } as never;
			if (path === "/api/v1/agents/auth-plans") return { data: authPlans } as never;
			return { data: undefined } as never;
		});
		vi.mocked(apiClient.POST).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/readiness/ensure") return { data: unauthorized } as never;
			if (path === "/api/v1/agents/{agent}/auth") {
				authStarts += 1;
				return { data: { agentId: "codex", action: "login", terminal: { handleId: `shellterm-login-${authStarts}`, workingDir: "/tmp/ao", title: "Log in to Codex", createdAt: new Date().toISOString() } } } as never;
			}
			if (path === "/api/v1/agents/{agent}/probe") {
				return { data: { agent: { id: "codex", label: "Codex", authStatus: "unauthorized" }, supported: true, installed: true } } as never;
			}
			return { data: undefined } as never;
		});
		vi.mocked(apiClient.DELETE).mockResolvedValue({ error: { code: "SHELL_TERMINAL_NOT_FOUND" } } as never);
		const user = userEvent.setup();
		renderSection();
		const codexRow = (await screen.findByText("Codex")).closest('[data-agent="codex"]') as HTMLElement;
		await user.click(await within(codexRow).findByRole("button", { name: "Login" }));
		await within(codexRow).findByTestId("harness-auth-terminal");
		await act(async () => terminalMock.onStateChange?.("exited"));
		const panel = await within(codexRow).findByTestId("harness-auth-terminal");
		await user.click(await within(panel).findByRole("button", { name: "Login" }));

		await waitFor(() => expect(authStarts).toBe(2));
		expect(within(codexRow).getByTestId("harness-auth-terminal")).toBeInTheDocument();
	});

	it("refreshes authentication availability after installation succeeds", async () => {
		let authPlanRequests = 0;
		let installStarted = false;
		let currentCatalog = readinessCatalog([]);
		vi.mocked(apiClient.GET).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/readiness") return { data: currentCatalog } as never;
			if (path === "/api/v1/agents/installers") return { data: plans } as never;
			if (path === "/api/v1/agents/auth-plans") {
				authPlanRequests += 1;
				return { data: { plans: [{
					agentId: "codex", action: "login", launchMode: "terminal", available: authPlanRequests > 1,
					reason: authPlanRequests > 1 ? undefined : "codex was not found on PATH.",
					documentationUrl: "https://example.test/codex",
				}] } } as never;
			}
			if (path === "/api/v1/agents/install-jobs") {
				return { data: { jobs: installStarted ? [{ target: "codex", status: "succeeded" }] : [] } } as never;
			}
			return { data: undefined } as never;
		});
		vi.mocked(apiClient.POST).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/refresh") return { data: currentCatalog } as never;
			if (path === "/api/v1/agents/readiness/ensure") return { data: currentCatalog } as never;
			if (path === "/api/v1/agents/{agent}/install") {
				installStarted = true;
				return { data: { target: "codex", status: "installing" } } as never;
			}
			if (path === "/api/v1/agents/{agent}/probe") {
				const agent = { id: "codex", label: "Codex", authStatus: "unknown" };
				currentCatalog = readinessCatalog(["codex"]);
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

	it("automatically uses the installer available on the user's machine", async () => {
		const npmOnlyPlans = {
			agents: plans.agents.map((plan) => plan.agentId === "codex" ? {
				...plan,
				method: "npm",
				methods: plan.methods.map((method) => ({
					...method,
					available: method.id === "npm",
					recommended: method.id === "npm",
				})),
			} : plan),
		};
		vi.mocked(apiClient.GET).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/readiness") return { data: catalog } as never;
			if (path === "/api/v1/agents/installers") return { data: npmOnlyPlans } as never;
			if (path === "/api/v1/agents/install-jobs") return { data: { jobs: [] } } as never;
			return { data: undefined } as never;
		});
		const user = userEvent.setup();
		renderSection();
		const row = (await screen.findByText("Codex")).closest('[data-agent="codex"]') as HTMLElement;

		await waitFor(() => expect(row).toHaveTextContent("Available via npm"));
		expect(within(row).queryByRole("combobox", { name: "Installation method" })).not.toBeInTheDocument();
		await user.click(within(row).getByRole("button", { name: "Install" }));

		await waitFor(() => expect(apiClient.POST).toHaveBeenCalledWith("/api/v1/agents/{agent}/install", {
			params: { path: { agent: "codex" } },
			body: { method: "npm", operation: "install" },
		}));
	});

	it("shows no reinstall or instructions actions for installed harnesses", async () => {
		vi.mocked(apiClient.GET).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/readiness") return { data: catalogWithInstalled("claude-code", "cursor") } as never;
			if (path === "/api/v1/agents/installers") return { data: plans } as never;
			if (path === "/api/v1/agents/install-jobs") return { data: { jobs: [] } } as never;
			return { data: undefined } as never;
		});
		renderSection();
		const claudeRow = (await screen.findByText("Claude Code")).closest('[data-agent="claude-code"]') as HTMLElement;
		const cursorRow = (await screen.findByText("Cursor")).closest('[data-agent="cursor"]') as HTMLElement;

		for (const row of [claudeRow, cursorRow]) {
			expect(row).toHaveTextContent("Installed");
			expect(within(row).queryByRole("button", { name: "Reinstall" })).not.toBeInTheDocument();
			expect(within(row).queryByRole("button", { name: "Instructions" })).not.toBeInTheDocument();
		}
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

	it("does not show instructions for harnesses without an automatic installer", async () => {
		renderSection();
		const row = (await screen.findByText("Goose")).closest('[data-agent="goose"]') as HTMLElement;
		expect(within(row).queryByRole("button", { name: "Instructions" })).not.toBeInTheDocument();
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

	it("hides diagnostics after installation succeeds", async () => {
		vi.mocked(apiClient.GET).mockImplementation(async (path) => {
			if (path === "/api/v1/agents/readiness") return { data: catalogWithInstalled("claude-code", "codex") } as never;
			if (path === "/api/v1/agents/installers") return { data: plans } as never;
			if (path === "/api/v1/agents/install-jobs") return { data: { jobs: [{ target: "codex", status: "succeeded", method: "npm", output: "installed successfully" }] } } as never;
			if (path === "/api/v1/agents/auth-plans") return { data: authPlans } as never;
			return { data: undefined } as never;
		});
		renderSection();
		const row = (await screen.findByText("Codex")).closest('[data-agent="codex"]') as HTMLElement;
		await waitFor(() => expect(screen.getByText("2 of 27 installed")).toBeInTheDocument());
		expect(within(row).queryByRole("button", { name: "Show diagnostics" })).not.toBeInTheDocument();
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
