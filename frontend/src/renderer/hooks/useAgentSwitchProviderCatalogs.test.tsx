import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { act, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatConfigOption, ChatModel, ChatSkill } from "../types/conversation";
import type { WorkspaceSession } from "../types/workspace";
import {
	conversationConfigOptionsQueryKey,
	conversationModelsQueryKey,
	conversationSkillsQueryKey,
	useConversationConfigOptions,
	useConversationModels,
	useConversationSkills,
} from "./useConversation";

const { getMock, patchMock, useAgentSwitchesMock, useSwitchAgentStateMock } = vi.hoisted(() => ({
	getMock: vi.fn(),
	patchMock: vi.fn(),
	useAgentSwitchesMock: vi.fn(),
	useSwitchAgentStateMock: vi.fn(),
}));

vi.mock("../lib/api-client", () => ({
	apiClient: { GET: getMock, PATCH: patchMock },
	apiErrorMessage: () => "failed",
}));

vi.mock("./useAgentSwitches", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./useAgentSwitches")>();
	return {
		...actual,
		useAgentSwitches: useAgentSwitchesMock,
	};
});

vi.mock("./useSwitchAgent", () => ({
	useSwitchAgentState: useSwitchAgentStateMock,
}));

import { useAgentSwitchProviderCatalogs } from "./useAgentSwitchProviderCatalogs";

const CLAUDE_OPTIONS = [
	{
		id: "model",
		name: "Model",
		category: "model",
		type: "select",
		currentValue: "opus-1m",
		choices: [{ value: "opus-1m", name: "Opus (1M context)" }],
	},
	{
		id: "effort",
		name: "Effort",
		category: "thought_level",
		type: "select",
		currentValue: "high",
		choices: [{ value: "high", name: "High" }],
	},
] satisfies ChatConfigOption[];

const CODEX_OPTIONS = [
	{
		id: "model",
		name: "Model",
		category: "model",
		type: "select",
		currentValue: "gpt-5.6-terra",
		choices: [{ value: "gpt-5.6-terra", name: "GPT-5.6 Terra" }],
	},
] satisfies ChatConfigOption[];

type ProviderName = "claude-code" | "codex";
type ProviderCatalog = {
	models: readonly ChatModel[];
	options: readonly ChatConfigOption[];
	skills: readonly ChatSkill[];
};

const PROVIDER_CATALOGS = {
	"claude-code": {
		models: [{ id: "opus-1m", displayName: "Opus", default: true }],
		options: CLAUDE_OPTIONS,
		skills: [{ name: "claude-commit", displayName: "Claude Commit" }],
	},
	codex: {
		models: [{ id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", default: true }],
		options: CODEX_OPTIONS,
		skills: [{ name: "codex-commit", displayName: "Codex Commit" }],
	},
} as const satisfies Record<ProviderName, ProviderCatalog>;

function wrapper(queryClient: QueryClient) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
	};
}

/** Chat sessions intentionally have no terminal runtime metadata. */
function chatSession(
	provider: ProviderName,
	activeAgentSwitch?: WorkspaceSession["activeAgentSwitch"],
): WorkspaceSession {
	return {
		activity: { state: "active", lastActivityAt: "2026-06-10T00:00:00Z" },
		branch: "ao/sess-1",
		id: "sess-1",
		kind: "worker",
		provider,
		prs: [],
		status: "working",
		title: "do the thing",
		updatedAt: "2026-06-10T00:00:00Z",
		workspaceId: "proj-1",
		workspaceName: "my-app",
		activeAgentSwitch,
		terminalHandleId: undefined,
	};
}

function catalogHarness(session: WorkspaceSession, targetChatControllerReady: boolean) {
	const { catalogsEnabled } = useAgentSwitchProviderCatalogs(session, targetChatControllerReady);
	const config = useConversationConfigOptions(session.id, catalogsEnabled);
	const models = useConversationModels(session.id, catalogsEnabled);
	const skills = useConversationSkills(session.id, catalogsEnabled);
	return {
		catalogsEnabled,
		models: models.models,
		options: config.options,
		setOption: config.setOption,
		skills: skills.skills,
	};
}

function serveCatalog(getCatalog: () => ProviderCatalog) {
	getMock.mockImplementation(async (path: string) => {
		const catalog = getCatalog();
		if (path.endsWith("/models")) {
			return { data: { models: catalog.models }, error: undefined };
		}
		if (path.endsWith("/skills")) {
			return { data: { skills: catalog.skills }, error: undefined };
		}
		if (path.endsWith("/config-options")) {
			return { data: { options: catalog.options }, error: undefined };
		}
		throw new Error(`Unexpected GET ${path}`);
	});
}

beforeEach(() => {
	getMock.mockReset();
	patchMock.mockReset();
	useAgentSwitchesMock.mockReset().mockReturnValue({ data: [] });
	useSwitchAgentStateMock.mockReset().mockReturnValue({
		error: null,
		input: undefined,
		isPending: false,
	});
});

describe("useAgentSwitchProviderCatalogs", () => {
	it.each([
		["claude-code", "codex"],
		["codex", "claude-code"],
	] as const)(
		"refetches active catalog observers after a Chat switch from %s to %s",
		async (sourceProvider, targetProvider) => {
			const queryClient = new QueryClient({
				defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
			});
			let servedProvider: ProviderName = sourceProvider;
			serveCatalog(() => PROVIDER_CATALOGS[servedProvider]);
			const sourceSession = chatSession(sourceProvider);
			const switchSummary = {
				agentHandoffStatus: "received",
				fromHarness: sourceProvider,
				id: `switch-${sourceProvider}-${targetProvider}`,
				state: "starting_target",
				targetHarness: targetProvider,
			} as const satisfies NonNullable<WorkspaceSession["activeAgentSwitch"]>;
			const { rerender, result } = renderHook(
				({
					targetChatControllerReady,
					session,
				}: {
					targetChatControllerReady: boolean;
					session: WorkspaceSession;
				}) => catalogHarness(session, targetChatControllerReady),
				{
					initialProps: { targetChatControllerReady: true, session: sourceSession },
					wrapper: wrapper(queryClient),
				},
			);

			await waitFor(() => {
				expect(result.current.models[0]?.id).toBe(PROVIDER_CATALOGS[sourceProvider].models[0].id);
				expect(result.current.options[0]?.currentValue).toBe(
					PROVIDER_CATALOGS[sourceProvider].options[0].currentValue,
				);
				expect(result.current.skills[0]?.name).toBe(
					PROVIDER_CATALOGS[sourceProvider].skills[0].name,
				);
			});

			const staleSourceOptions = PROVIDER_CATALOGS[sourceProvider].options.map((option) =>
				option.id === "model" ? { ...option, currentValue: "delayed-model" } : option,
			);
			let resolveDelayedPatch:
				| ((value: {
						data: { options: readonly ChatConfigOption[] };
						error: undefined;
				  }) => void)
				| undefined;
			patchMock.mockReturnValue(
				new Promise((resolve) => {
					resolveDelayedPatch = resolve;
				}),
			);
			let delayedMutation!: Promise<unknown>;
			act(() => {
				delayedMutation = result.current.setOption("model", { value: "delayed-model" });
			});
			await waitFor(() => expect(patchMock).toHaveBeenCalledOnce());

			useAgentSwitchesMock.mockReturnValue({ data: [switchSummary] });
			rerender({
				targetChatControllerReady: false,
				session: chatSession(sourceProvider, switchSummary),
			});
			expect(result.current.catalogsEnabled).toBe(false);
			await waitFor(() => {
				expect(result.current.models).toEqual([]);
				expect(result.current.options).toEqual([]);
				expect(result.current.skills).toEqual([]);
			});

			servedProvider = targetProvider;
			useAgentSwitchesMock.mockReturnValue({
				data: [{ ...switchSummary, state: "completed" as const }],
			});
			// Durable success alone is not enough: catalogs stay paused until the target
			// controller is ready, even though Chat sessions have no terminal runtime.
			rerender({
				targetChatControllerReady: false,
				session: chatSession(targetProvider),
			});
			expect(result.current.catalogsEnabled).toBe(false);

			rerender({
				targetChatControllerReady: true,
				session: chatSession(targetProvider),
			});
			await waitFor(() => {
				expect(result.current.catalogsEnabled).toBe(true);
				expect(result.current.models[0]?.id).toBe(PROVIDER_CATALOGS[targetProvider].models[0].id);
				expect(result.current.options[0]?.currentValue).toBe(
					PROVIDER_CATALOGS[targetProvider].options[0].currentValue,
				);
				expect(result.current.skills[0]?.name).toBe(
					PROVIDER_CATALOGS[targetProvider].skills[0].name,
				);
			});

			resolveDelayedPatch!({ data: { options: staleSourceOptions }, error: undefined });
			await act(async () => delayedMutation);
			expect(result.current.options[0]?.currentValue).toBe(
				PROVIDER_CATALOGS[targetProvider].options[0].currentValue,
			);
		},
	);

	it("refetches recovered source catalogs after a failed Chat switch", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
		});
		let recovered = false;
		const recoveredCatalog = {
			...PROVIDER_CATALOGS["claude-code"],
			options: [{ ...CLAUDE_OPTIONS[0], currentValue: "opus-recovered" }],
		} as const;
		serveCatalog(() => (recovered ? recoveredCatalog : PROVIDER_CATALOGS["claude-code"]));
		const recoverySwitch = {
			agentHandoffStatus: "received",
			errorCode: "target_start_unconfirmed",
			fromHarness: "claude-code",
			id: "switch-failed-recovery",
			state: "starting_target",
			targetHarness: "codex",
		} as const satisfies NonNullable<WorkspaceSession["activeAgentSwitch"]>;
		useAgentSwitchesMock.mockReturnValue({ data: [recoverySwitch] });
		const { rerender, result } = renderHook(
			({
				targetChatControllerReady,
				session,
			}: {
				targetChatControllerReady: boolean;
				session: WorkspaceSession;
			}) => catalogHarness(session, targetChatControllerReady),
			{
				initialProps: {
					targetChatControllerReady: false,
					session: chatSession("claude-code", recoverySwitch),
				},
				wrapper: wrapper(queryClient),
			},
		);
		expect(result.current.catalogsEnabled).toBe(false);

		recovered = true;
		useAgentSwitchesMock.mockReturnValue({
			data: [{ ...recoverySwitch, errorCode: "target_start_failed", state: "failed" as const }],
		});
		rerender({
			targetChatControllerReady: true,
			session: chatSession("claude-code"),
		});

		await waitFor(() => {
			expect(result.current.catalogsEnabled).toBe(true);
			expect(result.current.options[0]?.currentValue).toBe("opus-recovered");
		});
	});

	it("clears stale catalogs on admission and refetches only after controller readiness", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
		});
		const removeQueries = vi.spyOn(queryClient, "removeQueries");
		const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
		serveCatalog(() => PROVIDER_CATALOGS["codex"]);
		const sourceSession = chatSession("claude-code");
		const switchSummary = {
			agentHandoffStatus: "received",
			fromHarness: "claude-code",
			id: "switch-1",
			state: "starting_target",
			targetHarness: "codex",
		} as const satisfies NonNullable<WorkspaceSession["activeAgentSwitch"]>;

		useSwitchAgentStateMock.mockReturnValue({
			error: null,
			input: {
				idempotencyKey: "switch-request-1",
				model: "",
				session: sourceSession,
				targetHarness: "codex",
			},
			isPending: true,
		});

		const { rerender, result } = renderHook(
			({
				targetChatControllerReady,
				session,
			}: {
				targetChatControllerReady: boolean;
				session: WorkspaceSession;
			}) => catalogHarness(session, targetChatControllerReady),
			{
				initialProps: { targetChatControllerReady: true, session: sourceSession },
				wrapper: wrapper(queryClient),
			},
		);

		await waitFor(() => {
			expect(removeQueries).toHaveBeenCalledWith({
				queryKey: conversationConfigOptionsQueryKey("sess-1"),
			});
		});
		expect(invalidateQueries).not.toHaveBeenCalledWith({
			queryKey: conversationConfigOptionsQueryKey("sess-1"),
		});

		useSwitchAgentStateMock.mockReturnValue({
			error: null,
			input: undefined,
			isPending: false,
		});
		useAgentSwitchesMock.mockReturnValue({ data: [switchSummary] });
		rerender({
			targetChatControllerReady: false,
			session: chatSession("claude-code", switchSummary),
		});
		expect(result.current.catalogsEnabled).toBe(false);

		useAgentSwitchesMock.mockReturnValue({
			data: [{ ...switchSummary, state: "completed" as const }],
		});
		rerender({
			targetChatControllerReady: false,
			session: chatSession("codex"),
		});
		expect(result.current.catalogsEnabled).toBe(false);

		rerender({
			targetChatControllerReady: true,
			session: chatSession("codex"),
		});
		await waitFor(() => {
			expect(result.current.catalogsEnabled).toBe(true);
			expect(invalidateQueries).toHaveBeenCalledWith({
				queryKey: conversationConfigOptionsQueryKey("sess-1"),
			});
			expect(invalidateQueries).toHaveBeenCalledWith({
				queryKey: conversationModelsQueryKey("sess-1"),
			});
			expect(invalidateQueries).toHaveBeenCalledWith({
				queryKey: conversationSkillsQueryKey("sess-1"),
			});
			expect(result.current.options[0]?.currentValue).toBe(CODEX_OPTIONS[0].currentValue);
		});
	});

	it("keeps catalogs cleared when durable history requires recovery", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
		});
		queryClient.setQueryData(conversationConfigOptionsQueryKey("sess-1"), CLAUDE_OPTIONS);
		const recoverySwitch = {
			agentHandoffStatus: "received",
			errorCode: "target_start_unconfirmed",
			fromHarness: "claude-code",
			id: "switch-recovery",
			state: "starting_target",
			targetHarness: "codex",
		} as const satisfies NonNullable<WorkspaceSession["activeAgentSwitch"]>;
		useAgentSwitchesMock.mockReturnValue({ data: [recoverySwitch] });

		const { result } = renderHook(
			() => useAgentSwitchProviderCatalogs(chatSession("claude-code", recoverySwitch), false),
			{ wrapper: wrapper(queryClient) },
		);

		expect(result.current.catalogsEnabled).toBe(false);
		await waitFor(() => {
			expect(queryClient.getQueryData(conversationConfigOptionsQueryKey("sess-1"))).toBeUndefined();
		});
	});
});
