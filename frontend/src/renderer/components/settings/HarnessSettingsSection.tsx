import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Download, ExternalLink, LoaderCircle, RefreshCw, Search, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { components } from "../../../api/schema";
import { useAgentsQuery, agentsQueryKey, refreshAgents, refreshAgentsIfStale, type AgentCatalog } from "../../hooks/useAgentsQuery";
import { AGENT_OPTIONS, agentLabel, type AgentId } from "../../lib/agent-options";
import { apiClient, apiErrorMessage } from "../../lib/api-client";
import { aoBridge } from "../../lib/bridge";
import { cn } from "../../lib/utils";
import { AgentAvatar } from "../AgentAvatar";
import { Button } from "../ui/button";
import { SettingsSection } from "./SettingsSection";

type AgentInstallPlan = components["schemas"]["AgentInstallPlan"];
type InstallJob = components["schemas"]["InstallJob"];
type AgentInstallState = {
	job: InstallJob | null;
	error: string | null;
	verifying: boolean;
};
type AgentInstallStates = Partial<Record<AgentId, AgentInstallState>>;

const installerQueryKey = ["agent-installers"] as const;
const POLL_INTERVAL_MS = 1_000;

async function fetchInstallers(): Promise<AgentInstallPlan[]> {
	const { data, error } = await apiClient.GET("/api/v1/agents/installers");
	if (error || !data) throw new Error(apiErrorMessage(error, "Could not load harness installers."));
	return data.agents;
}

function addInstalledAgent(catalog: AgentCatalog | undefined, agentId: AgentId): AgentCatalog | undefined {
	if (!catalog || catalog.installed.some((agent) => agent.id === agentId)) return catalog;
	const supported = catalog.supported.find((agent) => agent.id === agentId);
	if (!supported) return catalog;
	return { ...catalog, installed: [...catalog.installed, supported] };
}

export function HarnessSettingsSection({ titleHidden = false }: { titleHidden?: boolean }) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const agents = useAgentsQuery();
	const installers = useQuery({ queryKey: installerQueryKey, queryFn: fetchInstallers, staleTime: 60_000 });
	const [search, setSearch] = useState("");
	const [installStates, setInstallStates] = useState<AgentInstallStates>({});
	const [refreshError, setRefreshError] = useState<string | null>(null);
	const [copiedAgent, setCopiedAgent] = useState<AgentId | null>(null);
	const verificationRef = useRef(new Set<AgentId>());
	const updateInstallState = useCallback((agentId: AgentId, patch: Partial<AgentInstallState>) => {
		setInstallStates((current) => ({
			...current,
			[agentId]: { job: null, error: null, verifying: false, ...current[agentId], ...patch },
		}));
	}, []);

	useEffect(() => {
		void refreshAgentsIfStale().then((fresh) => {
			if (fresh) queryClient.setQueryData(agentsQueryKey, fresh);
		});
	}, [queryClient]);

	const plans = useMemo(() => new Map(installers.data?.map((plan) => [plan.agentId, plan]) ?? []), [installers.data]);
	const installed = useMemo(() => new Set(agents.data?.installed.map((agent) => agent.id) ?? []), [agents.data]);
	const normalizedSearch = search.trim().toLowerCase();
	const rows = AGENT_OPTIONS.filter((agentId) => agentLabel(agentId).toLowerCase().includes(normalizedSearch));
	const runningAgentKey = useMemo(
		() => AGENT_OPTIONS.filter((agentId) => installStates[agentId]?.job?.status === "running").join(","),
		[installStates],
	);
	const succeededAgentKey = useMemo(
		() => AGENT_OPTIONS.filter((agentId) => installStates[agentId]?.job?.status === "succeeded").join(","),
		[installStates],
	);

	useEffect(() => {
		const runningAgents = runningAgentKey ? (runningAgentKey.split(",") as AgentId[]) : [];
		if (runningAgents.length === 0) return;
		const timer = window.setInterval(() => {
			void Promise.all(runningAgents.map(async (agentId) => {
				const { data, error } = await apiClient.GET("/api/v1/agents/{agent}/install", {
					params: { path: { agent: agentId } },
				});
				if (!error && data) updateInstallState(agentId, { job: data });
			}));
		}, POLL_INTERVAL_MS);
		return () => window.clearInterval(timer);
	}, [runningAgentKey, updateInstallState]);

	useEffect(() => {
		const succeededAgents = succeededAgentKey ? (succeededAgentKey.split(",") as AgentId[]) : [];
		for (const agentId of succeededAgents) {
			if (verificationRef.current.has(agentId)) continue;
			verificationRef.current.add(agentId);
			updateInstallState(agentId, { verifying: true, error: null });
			void (async () => {
				const { data, error } = await apiClient.POST("/api/v1/agents/{agent}/probe", {
					params: { path: { agent: agentId } },
				});
				if (error || !data?.installed) {
					updateInstallState(agentId, {
						error: apiErrorMessage(error, t("settings.harness.verifyFailed", { agent: agentLabel(agentId) })),
					});
					return;
				}
				queryClient.setQueryData<AgentCatalog | undefined>(agentsQueryKey, (current) => addInstalledAgent(current, agentId));
				await queryClient.invalidateQueries({ queryKey: agentsQueryKey });
			})().finally(() => updateInstallState(agentId, { verifying: false }));
		}
	}, [queryClient, succeededAgentKey, t, updateInstallState]);

	const startInstall = async (agentId: AgentId) => {
		updateInstallState(agentId, { job: null, error: null, verifying: false });
		verificationRef.current.delete(agentId);
		const { data, error } = await apiClient.POST("/api/v1/agents/{agent}/install", {
			params: { path: { agent: agentId } },
		});
		if (error || !data) {
			updateInstallState(agentId, { error: apiErrorMessage(error, t("settings.harness.startFailed")) });
			return;
		}
		updateInstallState(agentId, { job: data });
	};

	const copyCommand = async (agentId: AgentId, command: string) => {
		await aoBridge.clipboard.writeText(command);
		setCopiedAgent(agentId);
		window.setTimeout(() => setCopiedAgent((current) => (current === agentId ? null : current)), 1_500);
	};

	const refresh = async () => {
		setRefreshError(null);
		try {
			const [fresh] = await Promise.all([
				refreshAgents(),
				queryClient.invalidateQueries({ queryKey: installerQueryKey }),
			]);
			queryClient.setQueryData(agentsQueryKey, fresh);
		} catch (error) {
			setRefreshError(error instanceof Error ? error.message : t("settings.harness.loadFailed"));
		}
	};

	return (
		<SettingsSection title={t("settings.harness")} titleHidden={titleHidden} sectionId="harness">
			<div className="flex items-center gap-2 px-1">
				<label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-(--color-border-settings-input) bg-(--color-bg-settings-input) px-3">
					<Search aria-hidden="true" className="size-4 shrink-0 text-settings-muted" />
					<span className="sr-only">{t("settings.harness.search")}</span>
					<input
						aria-label={t("settings.harness.search")}
						className="min-w-0 flex-1 bg-transparent text-sm text-settings-label outline-none placeholder:text-settings-muted"
						placeholder={t("settings.harness.searchPlaceholder")}
						value={search}
						onChange={(event) => setSearch(event.target.value)}
					/>
				</label>
				<Button aria-label={t("settings.harness.refresh")} size="icon-sm" variant="outline" onClick={() => void refresh()}>
					<RefreshCw className={cn((agents.isFetching || installers.isFetching) && "animate-spin")} />
				</Button>
			</div>

			<p className="px-1 text-xs text-settings-muted">
				{t("settings.harness.summary", { installed: installed.size, total: AGENT_OPTIONS.length })}
			</p>

			{installers.isError || agents.isError || refreshError ? (
				<div className="flex items-center gap-2 rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
					<TriangleAlert className="size-4" aria-hidden="true" />
					{refreshError ?? t("settings.harness.loadFailed")}
				</div>
			) : null}

			<div className="settings-grouped-rows flex w-full flex-col">
				{rows.map((agentId) => {
					const plan = plans.get(agentId);
					const isInstalled = installed.has(agentId);
					const installState = installStates[agentId];
					const rowJob = installState?.job;
					const failed = rowJob?.status === "failed" || rowJob?.status === "unsupported" || Boolean(installState?.error);
					const running = rowJob?.status === "running";
					const rowVerifying = installState?.verifying === true;
					const statusId = `harness-agent-${agentId}-status`;
					return (
						<div className="settings-row-bar relative min-h-14 gap-3 overflow-hidden" data-agent={agentId} key={agentId}>
							<AgentAvatar className="size-7 shrink-0" decorative provider={agentId} />
							<div className="min-w-0 flex-1">
								<p className="truncate text-sm font-medium text-settings-label" id={`harness-agent-${agentId}`}>{agentLabel(agentId)}</p>
								<p className={cn("truncate text-xs text-settings-muted", failed && "text-error")} title={failed ? (installState?.error ?? rowJob?.error) : plan?.reason}>
									{isInstalled
										? t("settings.harness.installed")
										: failed
											? (installState?.error ?? rowJob?.error ?? t("settings.harness.installFailed"))
												: plan?.available
													? t("settings.harness.availableWith", { method: plan.method })
														: (plan?.reason ?? t("settings.harness.manualRequired"))}
								</p>
							</div>
							{isInstalled ? (
								<span className="inline-flex items-center gap-1 text-xs font-medium text-success">
									<Check className="size-4" aria-hidden="true" />
									{t("settings.harness.installed")}
								</span>
							) : running || rowVerifying ? (
								<span className="inline-flex items-center gap-1.5 text-xs text-settings-muted" id={statusId} role="status">
									<LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
									{running ? t("settings.harness.installing") : t("settings.harness.verifying")}
								</span>
							) : !plan && installers.isPending ? (
								<span className="inline-flex items-center gap-1.5 text-xs text-settings-muted" role="status">
									<LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
								</span>
							) : plan?.available && plan.automatic ? (
								<Button size="sm" onClick={() => void startInstall(agentId)}>
									<Download aria-hidden="true" />
									{failed ? t("settings.harness.retry") : t("settings.harness.install")}
								</Button>
							) : plan?.command ? (
								<Button size="sm" variant="outline" onClick={() => void copyCommand(agentId, plan.command!)}>
									{copiedAgent === agentId ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
									{copiedAgent === agentId ? t("settings.harness.copied") : t("settings.harness.copyCommand")}
								</Button>
							) : (
								<Button size="sm" variant="outline" onClick={() => void aoBridge.app.openExternal(plan?.documentationUrl ?? "https://aoagents.dev/docs/installation")}>
									<ExternalLink aria-hidden="true" />
									{t("settings.harness.instructions")}
								</Button>
							)}
							{running || rowVerifying ? (
								<div
									aria-labelledby={`harness-agent-${agentId} ${statusId}`}
									className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-settings-menu-selected"
									role="progressbar"
								>
									<div className="h-full w-2/5 bg-primary harness-install-progress-indicator" />
								</div>
							) : null}
						</div>
					);
				})}
				{rows.length === 0 ? <p className="px-3 py-6 text-center text-sm text-settings-muted">{t("settings.harness.noResults")}</p> : null}
			</div>
		</SettingsSection>
	);
}
