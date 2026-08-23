import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../lib/api-client";
import { appI18n } from "../../i18n";
import { HarnessSettingsSection } from "./HarnessSettingsSection";

const catalog = {
	supported: [
		{ id: "claude-code", label: "Claude Code" },
		{ id: "codex", label: "Codex" },
	],
	installed: [{ id: "claude-code", label: "Claude Code" }],
	authorized: [],
};

const plans = {
	agents: [
		{
			agentId: "claude-code", available: true, automatic: true, method: "official-installer",
			command: "bash installer", documentationUrl: "https://code.claude.com/docs/en/installation",
		},
		{
			agentId: "codex", available: true, automatic: true, method: "npm",
			command: "npm install -g @openai/codex", documentationUrl: "https://github.com/openai/codex",
		},
		{
			agentId: "aider", available: true, automatic: true, method: "pipx",
			command: "pipx install aider-chat", documentationUrl: "https://aider.chat/docs/install.html",
		},
	],
};

function renderSection() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<HarnessSettingsSection />
		</QueryClientProvider>,
	);
}

describe("HarnessSettingsSection", () => {
	beforeEach(async () => {
		await appI18n.changeLanguage("en");
		vi.spyOn(apiClient, "GET").mockImplementation(async (path) => {
			if (path === "/api/v1/agents") return { data: catalog } as never;
			if (path === "/api/v1/agents/installers") return { data: plans } as never;
			return { data: undefined } as never;
		});
		vi.spyOn(apiClient, "POST").mockImplementation(async (path) => {
			if (path === "/api/v1/agents/refresh") return { data: catalog } as never;
			if (path === "/api/v1/agents/{agent}/install") {
				return { data: { target: "codex", status: "failed", error: "npm failed" } } as never;
			}
			return { data: undefined } as never;
		});
	});

	afterEach(() => vi.restoreAllMocks());

	it("shows installed harnesses and install actions without authentication UI", async () => {
		renderSection();
		await waitFor(() => expect(screen.getByText("1 of 27 installed")).toBeInTheDocument(), { timeout: 10_000 });
		expect(screen.getByText("Claude Code")).toBeInTheDocument();
		expect(screen.getAllByText("Installed").length).toBeGreaterThan(0);
		expect(screen.getByText("Codex")).toBeInTheDocument();
		expect(screen.queryByText(/sign in/i)).not.toBeInTheDocument();
	});

	it("starts the fixed daemon install route and exposes retry after failure", async () => {
		const user = userEvent.setup();
		renderSection();
		await screen.findByText("Codex");
		const codexRow = document.querySelector('[data-agent="codex"]');
		expect(codexRow).not.toBeNull();
		await waitFor(() => expect(codexRow).toHaveTextContent("Available via npm"), { timeout: 10_000 });
		await user.click(within(codexRow as HTMLElement).getByRole("button", { name: "Install" }));

		await waitFor(() => expect(apiClient.POST).toHaveBeenCalledWith("/api/v1/agents/{agent}/install", {
			params: { path: { agent: "codex" } },
		}));
		await waitFor(() => expect(codexRow).toHaveTextContent("npm failed"));
		expect(codexRow).toHaveTextContent("Retry");
	});

	it("keeps concurrent installs independent with one progress indicator per row", async () => {
		vi.mocked(apiClient.POST).mockImplementation(async (path, options) => {
			if (path === "/api/v1/agents/{agent}/install") {
				const agent = (options as { params: { path: { agent: string } } }).params.path.agent;
				return { data: { target: agent, status: "running" } } as never;
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
		await waitFor(() => expect(within(codexRow as HTMLElement).getByRole("progressbar")).toBeInTheDocument());
		await user.click(within(aiderRow as HTMLElement).getByRole("button", { name: "Install" }));

		await waitFor(() => expect(within(aiderRow as HTMLElement).getByRole("progressbar")).toBeInTheDocument());
		expect(within(codexRow as HTMLElement).getAllByText("Installing…")).toHaveLength(1);
		expect(within(aiderRow as HTMLElement).getAllByText("Installing…")).toHaveLength(1);
	});
});
