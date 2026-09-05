import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { ClaudeCodeAccountsSection } from "./ClaudeCodeAccountsSection";

const { deleteMock, getMock, postMock, terminalStateCallback } = vi.hoisted(() => ({
	deleteMock: vi.fn(),
	getMock: vi.fn(),
	postMock: vi.fn(),
	terminalStateCallback: { value: undefined as ((state: "exited" | "error") => void) | undefined },
}));

vi.mock("../../lib/api-client", () => ({
	apiClient: { DELETE: deleteMock, GET: getMock, POST: postMock },
	apiErrorMessage: (error: unknown) => error instanceof Error ? error.message : "request failed",
}));

vi.mock("../TerminalPane", () => ({
	TerminalPane: ({ onTerminalStateChange }: { onTerminalStateChange?: (state: "exited" | "error") => void }) => {
		terminalStateCallback.value = onTerminalStateChange;
		return <div data-testid="inline-terminal-body" />;
	},
}));

const capability = (state: "supported" | "unsupported" = "supported", reason = "Available.", reasonCode = state === "supported" ? "supported" : "unsupported_platform") => ({ state, reasonCode, reason });
const authentication = { state: "authorized", freshness: "fresh", checkedAt: "2026-09-02T10:00:00Z", attemptedAt: "2026-09-02T10:00:00Z", reasonCode: "authorized", reason: "Signed in." };
const identity = (id: string, email: string) => ({ accountUuid: id, emailAddress: email, displayName: email.split("@")[0], organizationName: "Example Org", billingType: "subscription", seatTier: "pro" });
const planUsage = { state: "available", freshness: "fresh", plan: "pro", promotion: { percentIncrease: 50, endsOn: "2026-09-13" }, windows: [{ id: "five_hour", displayName: "5-hour limit", usedPercent: 17, resetsAt: "2026-09-03T14:30:00Z" }, { id: "seven_day", displayName: "Weekly — all models", usedPercent: 42, resetsAt: "2026-09-08T04:00:00Z" }], observedAt: "2026-09-03T10:00:00Z", checkedAt: "2026-09-03T10:00:00Z", attemptedAt: "2026-09-03T10:00:00Z", reasonCode: "plan_usage_available", reason: "Plan usage is up to date." };
const activeAccount = { id: "11111111-1111-4111-8111-111111111111", label: "AO", status: "valid", reasonCode: "account_valid", reason: "Ready.", active: true, authentication, identity: identity("11111111-1111-4111-8111-111111111111", "active@example.com"), accountEmail: "active@example.com", planUsage, createdAt: "2026-09-02T09:00:00Z", updatedAt: "2026-09-02T09:00:00Z" };
const inactiveAccount = { ...activeAccount, id: "22222222-2222-4222-8222-222222222222", label: "other@example.com", active: false, identity: identity("22222222-2222-4222-8222-222222222222", "other@example.com"), accountEmail: "other@example.com", createdAt: "2026-09-02T09:05:00Z", updatedAt: "2026-09-02T09:05:00Z" };
const signedOutAccount = { ...inactiveAccount, status: "signed_out", authentication: { ...authentication, state: "unauthorized", reasonCode: "unauthorized" } };
const capabilities = { accountRead: capability(), nativeLogin: capability(), accountManagement: capability(), globalSwitch: capability(), hotReload: capability(), sessionExitResume: capability("unsupported", "Session exit and resume is not supported.") };
const accountResponse = { activeAccountId: activeAccount.id, accountRevision: 3, accounts: [activeAccount, inactiveAccount], capabilities };
const pendingLogin = {
	operation: { operationId: "login-1", status: "pending", reasonCode: "login_pending", reason: "Waiting for Claude Code sign-in.", expiresAt: "2026-09-02T10:15:00Z" },
	shellTerminal: { handleId: "shellterm-login-1", title: "Add Claude Code account", createdAt: "2026-09-02T10:00:00Z" },
};

function renderSection(response: unknown = accountResponse) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	getMock.mockResolvedValue({ data: response });
	return { queryClient, ...render(<QueryClientProvider client={queryClient}><ClaudeCodeAccountsSection /></QueryClientProvider>) };
}

beforeEach(() => {
	Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
	terminalStateCallback.value = undefined;
	getMock.mockReset();
	deleteMock.mockReset().mockResolvedValue({ data: accountResponse });
	postMock.mockReset().mockImplementation((path: string) => {
		if (path === "/api/v1/agents/claude-code/accounts/ensure") return Promise.resolve({ data: accountResponse });
		if (path === "/api/v1/agents/claude-code/accounts/login-terminal") return Promise.resolve({ data: pendingLogin });
		return Promise.resolve({ data: {} });
	});
});

it("shows the email, plan, remaining limits, and promotion without global activity", async () => {
	const response = { ...accountResponse, accounts: [activeAccount, signedOutAccount] };
	postMock.mockImplementation((path: string) => path.endsWith("/ensure") ? Promise.resolve({ data: response }) : Promise.resolve({ data: {} }));
	const { container } = renderSection(response);
	await screen.findAllByText("active@example.com");
	expect(screen.getByText("Claude Code accounts")).toBeInTheDocument();

	fireEvent.click(container.querySelector(`[data-account-id="${activeAccount.id}"] button`) as HTMLButtonElement);
	expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
	expect(screen.getByText("Signed in")).toBeInTheDocument();
	expect(screen.getAllByText("Claude · Pro · 58% remaining").length).toBeGreaterThan(0);
	expect(screen.getByText("Your plan")).toBeInTheDocument();
	expect(screen.getByText("Pro plan")).toBeInTheDocument();
	expect(screen.getByText("50% higher through Sep 13")).toBeInTheDocument();
	expect(screen.getByLabelText("Your weekly Claude Code limit is 50% higher through September 13.")).toBeInTheDocument();
	expect(screen.getByText("83% remaining")).toBeInTheDocument();
	expect(screen.getByText("Weekly — all models")).toBeInTheDocument();
	expect(screen.getByRole("progressbar", { name: "5-hour limit, 83% remaining" })).toHaveAttribute("aria-valuenow", "83");
	fireEvent.click(container.querySelector(`[data-account-id="${signedOutAccount.id}"] button`) as HTMLButtonElement);
	expect(screen.getByRole("button", { name: "Sign in again" })).toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Delete account" })).toBeInTheDocument();
	expect(screen.queryByText("Claude Code activity")).not.toBeInTheDocument();
	expect(screen.queryByText("15,112")).not.toBeInTheDocument();
	expect(screen.queryByRole("button", { name: /reset/i })).not.toBeInTheDocument();
});

it("shows when no plan boost is available", async () => {
	const account = { ...activeAccount, planUsage: { ...planUsage, promotion: undefined } };
	const response = { ...accountResponse, accounts: [account], activeAccountId: account.id };
	postMock.mockImplementation((path: string) => path.endsWith("/ensure") ? Promise.resolve({ data: response }) : Promise.resolve({ data: {} }));
	const { container } = renderSection(response);
	await screen.findAllByText("active@example.com");
	fireEvent.click(container.querySelector(`[data-account-id="${account.id}"] button`) as HTMLButtonElement);
	expect(screen.getByText("No boosts available")).toBeInTheDocument();
});

it("does not claim whether an inactive account has a plan boost", async () => {
	const response = { ...accountResponse, accounts: [activeAccount, inactiveAccount] };
	postMock.mockImplementation((path: string) => path.endsWith("/ensure") ? Promise.resolve({ data: response }) : Promise.resolve({ data: {} }));
	const { container } = renderSection(response);
	await screen.findAllByText("other@example.com");
	fireEvent.click(container.querySelector(`[data-account-id="${inactiveAccount.id}"] button`) as HTMLButtonElement);
	expect(screen.getByText("Your plan")).toBeInTheDocument();
	expect(screen.getByText("Pro plan")).toBeInTheDocument();
	expect(screen.queryByText("50% higher through Sep 13")).not.toBeInTheDocument();
	expect(screen.queryByText("No boosts available")).not.toBeInTheDocument();
});

it("keeps the plan section visible while plan metadata is unavailable", async () => {
	const account = { ...activeAccount, planUsage: { ...planUsage, plan: undefined, promotion: undefined, windows: [] } };
	const response = { ...accountResponse, accounts: [account], activeAccountId: account.id };
	postMock.mockImplementation((path: string) => path.endsWith("/ensure") ? Promise.resolve({ data: response }) : Promise.resolve({ data: {} }));
	const { container } = renderSection(response);
	await screen.findAllByText("active@example.com");
	fireEvent.click(container.querySelector(`[data-account-id="${account.id}"] button`) as HTMLButtonElement);
	expect(screen.getByText("Your plan")).toBeInTheDocument();
	expect(screen.getByText("Plan information unavailable")).toBeInTheDocument();
	expect(screen.getByText("No boosts available")).toBeInTheDocument();
});

it("requires an inactive signed-in account to be logged out before deletion", async () => {
	renderSection();
	await screen.findAllByText("other@example.com");
	await userEvent.click(document.querySelector(`[data-account-id="${inactiveAccount.id}"] button`) as HTMLButtonElement);
	expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
	expect(screen.queryByRole("button", { name: "Delete account" })).not.toBeInTheDocument();
	expect(deleteMock).not.toHaveBeenCalled();
});

it("adds account B without making it active", async () => {
	const addedAccount = { ...inactiveAccount, id: "33333333-3333-4333-8333-333333333333", label: "added@example.com", identity: identity("33333333-3333-4333-8333-333333333333", "added@example.com"), accountEmail: "added@example.com" };
	postMock.mockImplementation((path: string) => {
		if (path.endsWith("/ensure")) return Promise.resolve({ data: accountResponse });
		if (path.endsWith("/accounts/login-terminal")) return Promise.resolve({ data: pendingLogin });
		if (path.includes("/login-operations/") && path.endsWith("/verify")) return Promise.resolve({ data: { ...pendingLogin.operation, status: "completed", reasonCode: "login_completed", account: addedAccount } });
		return Promise.resolve({ data: {} });
	});
	const { queryClient } = renderSection();
	const cancelQueries = vi.spyOn(queryClient, "cancelQueries");
	await userEvent.click(await screen.findByRole("button", { name: "Add account" }));
	expect(cancelQueries).toHaveBeenCalledWith({ queryKey: ["claude-code-accounts"] });
	expect(await screen.findByTestId("claude-code-account-login-terminal")).toBeInTheDocument();
	act(() => terminalStateCallback.value?.("exited"));

	expect(await screen.findByText("added@example.com")).toBeInTheDocument();
	const activeRow = document.querySelector(`[data-account-id="${activeAccount.id}"]`);
	const addedRow = document.querySelector(`[data-account-id="${addedAccount.id}"]`);
	expect(activeRow).toHaveTextContent("In use");
	expect(addedRow).not.toHaveTextContent("In use");
	expect(screen.getByText("Account added.")).toHaveAttribute("aria-live", "polite");
});

it("shows the first added account as active after login completes", async () => {
	const emptyResponse = { ...accountResponse, activeAccountId: undefined, accountRevision: 0, accounts: [] };
	const firstAccount = { ...activeAccount, active: true };
	const activatedResponse = { ...emptyResponse, activeAccountId: firstAccount.id, accountRevision: 1, accounts: [firstAccount] };
	const firstLogin = {
		...pendingLogin,
		operation: { ...pendingLogin.operation, operationId: "login-first" },
		shellTerminal: { ...pendingLogin.shellTerminal, handleId: "shellterm-login-first" },
	};
	let loginVerified = false;
	postMock.mockImplementation((path: string) => {
		if (path.endsWith("/ensure")) return Promise.resolve({ data: loginVerified ? activatedResponse : emptyResponse });
		if (path.endsWith("/accounts/login-terminal")) return Promise.resolve({ data: firstLogin });
		if (path.includes("/login-operations/") && path.endsWith("/verify")) {
			loginVerified = true;
			return Promise.resolve({ data: { ...firstLogin.operation, status: "completed", reasonCode: "login_completed", account: firstAccount } });
		}
		return Promise.resolve({ data: {} });
	});
	renderSection(emptyResponse);

	await userEvent.click(await screen.findByRole("button", { name: "Add account" }));
	await screen.findByTestId("claude-code-account-login-terminal");
	act(() => terminalStateCallback.value?.("exited"));

	const row = await screen.findByText("active@example.com");
	expect(row.closest("[data-account-id]")).toHaveTextContent("In use");
});

it("lets the user activate a saved account when none is active", async () => {
	const noActiveResponse = {
		...accountResponse,
		activeAccountId: undefined,
		accountRevision: 0,
		accounts: [{ ...activeAccount, active: false }, inactiveAccount],
	};
	const activatedResponse = {
		...noActiveResponse,
		activeAccountId: inactiveAccount.id,
		accountRevision: 1,
		accounts: [{ ...activeAccount, active: false }, { ...inactiveAccount, active: true }],
	};
	postMock.mockImplementation((path: string) => {
		if (path.endsWith("/ensure")) return Promise.resolve({ data: noActiveResponse });
		if (path.endsWith("/activate")) return Promise.resolve({ data: activatedResponse });
		return Promise.resolve({ data: {} });
	});
	renderSection(noActiveResponse);
	await screen.findByText("other@example.com");

	await userEvent.click(screen.getByRole("button", { name: "Switch account" }));
	await userEvent.click(await screen.findByRole("menuitem", { name: /other@example.com/ }));
	const dialog = await screen.findByRole("dialog");
	await userEvent.click(within(dialog).getByRole("button", { name: "Switch account" }));

	await waitFor(() => expect(postMock).toHaveBeenCalledWith(
		"/api/v1/agents/claude-code/accounts/{accountId}/activate",
		{ params: { path: { accountId: inactiveAccount.id } } },
	));
	expect(document.querySelector(`[data-account-id="${inactiveAccount.id}"]`)).toHaveTextContent("In use");
});

it("surfaces unsupported macOS capabilities and disables account mutations", async () => {
	const reason = "Claude Code account management is available on macOS only.";
	const unsupported = capability("unsupported", reason);
	const response = { ...accountResponse, capabilities: { accountRead: unsupported, nativeLogin: unsupported, accountManagement: unsupported, globalSwitch: unsupported, hotReload: unsupported, sessionExitResume: unsupported } };
	postMock.mockImplementation((path: string) => path.endsWith("/ensure") ? Promise.resolve({ data: response }) : Promise.resolve({ data: {} }));
	renderSection(response);
	const add = await screen.findByRole("button", { name: "Add account" });
	expect(add).toBeDisabled();
	await waitFor(() => expect(add).toHaveAttribute("title", reason));
});

it("shows switch progress, recovery, and the live propagation notice", async () => {
	const currentSwitch = { id: "switch-1", sourceAccountId: activeAccount.id, targetAccountId: inactiveAccount.id, switchPolicy: "hot_reload", phase: "recovery_required", canRecover: true, createdAt: "2026-09-02T10:00:00Z", updatedAt: "2026-09-02T10:01:00Z" };
	const response = { ...accountResponse, currentSwitch };
	postMock.mockImplementation((path: string) => path.endsWith("/ensure") ? Promise.resolve({ data: response }) : Promise.resolve({ data: currentSwitch }));
	const { queryClient } = renderSection(response);
	expect(await screen.findByText("The account switch needs your attention.")).toHaveAttribute("aria-live", "polite");
	expect(screen.getByRole("button", { name: "Recover switch" })).toBeInTheDocument();

	act(() => queryClient.setQueryData(["claude-code-accounts"], {
		...accountResponse,
		accountRevision: 4,
		activeAccountId: inactiveAccount.id,
		accounts: [{ ...inactiveAccount, active: true }, { ...activeAccount, active: false }],
	}));
	expect(await screen.findByText("Switched to other@example.com. It may take a moment to refresh.")).toHaveAttribute("aria-live", "polite");
});

it("keeps a stale-revision switch error visible in the confirmation dialog", async () => {
	postMock.mockImplementation((path: string) => {
		if (path.endsWith("/ensure")) return Promise.resolve({ data: accountResponse });
		if (path.endsWith("/account-switches")) return Promise.resolve({ error: new Error("Claude Code account state changed; refresh and try again") });
		return Promise.resolve({ data: {} });
	});
	const { queryClient } = renderSection();
	const cancelQueries = vi.spyOn(queryClient, "cancelQueries");
	await userEvent.click(await screen.findByRole("button", { name: "Switch account" }));
	await userEvent.click(await screen.findByRole("menuitem", { name: /other@example.com/ }));
	const dialog = await screen.findByRole("dialog");
	await userEvent.click(within(dialog).getByRole("button", { name: "Switch account" }));
	expect(cancelQueries).toHaveBeenCalledWith({ queryKey: ["claude-code-accounts"] });
	await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("Couldn’t switch accounts. Try again."));
});
