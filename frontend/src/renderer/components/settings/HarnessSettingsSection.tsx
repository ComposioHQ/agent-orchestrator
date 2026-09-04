import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Download, LoaderCircle, RefreshCw, Search, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { components } from "../../../api/schema";
import {
	agentReadinessQueryKey,
	cacheAgentReadiness,
	ensureAgentReadiness,
	useAgentReadinessQuery,
	useEnsureAgentReadiness,
} from "../../hooks/useAgentReadinessQuery";
import { agentLabel, AGENT_OPTIONS, type AgentId } from "../../lib/agent-options";
import { apiClient, apiErrorMessage } from "../../lib/api-client";
import { aoBridge } from "../../lib/bridge";
import { cn } from "../../lib/utils";
import { AgentAvatar } from "../AgentAvatar";
import { Button } from "../ui/button";
import { MENU_TRIGGER_CHROME } from "../ui/option-menu";
import { SettingsSection } from "./SettingsSection";
import { SettingsOptionMenu } from "./SettingsOptionMenu";

type AgentInstallPlan = components["schemas"]["AgentInstallPlan"];
type InstallJob = components["schemas"]["InstallJob"];

const installerQueryKey = ["agent-installers"] as const;
const installJobsQueryKey = ["agent-install-jobs"] as const;
const POLL_INTERVAL_MS = 1_000;

async function fetchInstallers(): Promise<AgentInstallPlan[]> {
	const { data, error } = await apiClient.GET("/api/v1/agents/installers");
	if (error || !data) throw new Error(apiErrorMessage(error, "Could not load harness installers."));
	return data.agents;
}

async function fetchInstallJobs(): Promise<InstallJob[]> {
	const { data, error } = await apiClient.GET("/api/v1/agents/install-jobs");
	if (error || !data) throw new Error(apiErrorMessage(error, "Could not load harness installation jobs."));
	return data.jobs;
}

function upsertJob(current: InstallJob[] | undefined, next: InstallJob): InstallJob[] {
	return [...(current ?? []).filter((job) => job.target !== next.target), next];
}

function isActive(job: InstallJob | undefined): boolean {
	return job?.status === "installing" || job?.status === "verifying";
}

function diagnosticsText(agentId: AgentId, job: InstallJob): string {
	return [
		`${agentLabel(agentId)} installation diagnostics`,
		job.method ? `Method: ${job.method}` : "",
		job.expectedDestination ? `Expected destination: ${job.expectedDestination}` : "",
		job.error ? `Error: ${job.error}` : "",
		job.output ? `Output:\n${job.output}` : "",
	].filter(Boolean).join("\n");
}

function installMethodLabel(method: { id: string; label: string } | undefined, fallback?: string): string | undefined {
	if (!method) {
		if (fallback?.trim().toLocaleLowerCase() === "official-installer") return "Official";
		return fallback;
	}
	if (method.id === "official-installer" || method.label.trim().toLocaleLowerCase() === "official installer") return "Official";
	return method.label;
}

export function HarnessSettingsSection({ titleHidden = false }: { titleHidden?: boolean }) {
	const { i18n, t } = useTranslation();
	const queryClient = useQueryClient();
	const agents = useAgentReadinessQuery();
	useEnsureAgentReadiness();
	const installers = useQuery({ queryKey: installerQueryKey, queryFn: fetchInstallers, staleTime: 60_000 });
	const jobs = useQuery({ queryKey: installJobsQueryKey, queryFn: fetchInstallJobs, retry: false });
	const [search, setSearch] = useState("");
	const [refreshError, setRefreshError] = useState<string | null>(null);
	const [actionErrors, setActionErrors] = useState<Partial<Record<AgentId, string>>>({});
	const [selectedMethods, setSelectedMethods] = useState<Partial<Record<AgentId, string>>>({});
	const [expandedDiagnostics, setExpandedDiagnostics] = useState<Partial<Record<AgentId, boolean>>>({});
	const [copiedAgent, setCopiedAgent] = useState<AgentId | null>(null);
	const refreshedSuccess = useRef(new Set<string>());
	const pendingActions = useRef(new Set<AgentId>());
	const [pendingAgentIds, setPendingAgentIds] = useState<Set<AgentId>>(new Set());

	const plans = useMemo(() => new Map(installers.data?.map((plan) => [plan.agentId, plan]) ?? []), [installers.data]);
	const jobMap = useMemo(() => new Map(jobs.data?.map((job) => [job.target, job]) ?? []), [jobs.data]);
	const installed = useMemo(
		() => new Set<AgentId>(agents.data?.agents.filter((agent) => agent.installation.state === "installed").map((agent) => agent.id as AgentId) ?? []),
		[agents.data],
	);
	const normalizedSearch = search.trim().toLowerCase();
	const rows = AGENT_OPTIONS.filter((agentId) => agentLabel(agentId).toLowerCase().includes(normalizedSearch));
	const activeKey = useMemo(
		() => (jobs.data ?? []).filter((job) => isActive(job)).map((job) => job.target).sort().join(","),
		[jobs.data],
	);
	const succeededKey = useMemo(
		() => (jobs.data ?? []).filter((job) => job.status === "succeeded").map((job) => `${job.target}:${job.updatedAt ?? job.finishedAt ?? "done"}`).sort().join(","),
		[jobs.data],
	);

	useEffect(() => {
		if (!activeKey) return;
		const timer = window.setInterval(() => void jobs.refetch(), POLL_INTERVAL_MS);
		return () => window.clearInterval(timer);
	}, [activeKey, jobs.refetch]);

	useEffect(() => {
		for (const token of succeededKey ? succeededKey.split(",") : []) {
			if (!token || refreshedSuccess.current.has(token)) continue;
			refreshedSuccess.current.add(token);
			const agentId = token.split(":", 1)[0] as AgentId;
			setActionErrors((current) => ({ ...current, [agentId]: undefined }));
			void apiClient.POST("/api/v1/agents/{agent}/probe", {
				params: { path: { agent: agentId } },
			}).finally(async () => {
				try {
					const readiness = await ensureAgentReadiness([agentId], "display");
					cacheAgentReadiness(queryClient, readiness);
				} catch {
					await queryClient.invalidateQueries({ queryKey: agentReadinessQueryKey });
				} finally {
					await queryClient.invalidateQueries({ queryKey: installerQueryKey });
				}
			});
		}
	}, [queryClient, succeededKey]);

	useEffect(() => {
		setExpandedDiagnostics((current) => {
			let changed = false;
			const next = { ...current };
			for (const agentId of installed) {
				if (next[agentId]) {
					delete next[agentId];
					changed = true;
				}
			}
			return changed ? next : current;
		});
	}, [installed]);

	const updateJob = (job: InstallJob) => {
		setActionErrors((current) => ({ ...current, [job.target as AgentId]: undefined }));
		queryClient.setQueryData<InstallJob[]>(installJobsQueryKey, (current) => upsertJob(current, job));
	};

	const beginAction = (agentId: AgentId): boolean => {
		if (pendingActions.current.has(agentId)) return false;
		pendingActions.current.add(agentId);
		setPendingAgentIds(new Set(pendingActions.current));
		return true;
	};

	const endAction = (agentId: AgentId) => {
		pendingActions.current.delete(agentId);
		setPendingAgentIds(new Set(pendingActions.current));
	};

	const startInstall = async (agentId: AgentId, method: string) => {
		if (!beginAction(agentId)) return;
		setActionErrors((current) => ({ ...current, [agentId]: undefined }));
		try {
			const { data, error } = await apiClient.POST("/api/v1/agents/{agent}/install", {
				params: { path: { agent: agentId } },
				body: { method, operation: "install" },
			});
			if (error || !data) {
				setActionErrors((current) => ({ ...current, [agentId]: apiErrorMessage(error, t("settings.harness.startFailed")) }));
				return;
			}
			updateJob(data);
		} finally {
			endAction(agentId);
		}
	};

	const verifyInstall = async (agentId: AgentId) => {
		if (!beginAction(agentId)) return;
		setActionErrors((current) => ({ ...current, [agentId]: undefined }));
		try {
			const { data, error } = await apiClient.POST("/api/v1/agents/{agent}/verify", {
				params: { path: { agent: agentId } },
			});
			if (error || !data) {
				setActionErrors((current) => ({ ...current, [agentId]: apiErrorMessage(error, t("settings.harness.verifyFailed", { agent: agentLabel(agentId) })) }));
				return;
			}
			updateJob(data);
		} finally {
			endAction(agentId);
		}
	};

	const copyText = async (agentId: AgentId, text: string) => {
		await aoBridge.clipboard.writeText(text);
		setCopiedAgent(agentId);
		window.setTimeout(() => setCopiedAgent((current) => (current === agentId ? null : current)), 1_500);
	};

	const refresh = async () => {
		setRefreshError(null);
		try {
			const [{ error }] = await Promise.all([
				apiClient.POST("/api/v1/agents/refresh"),
				queryClient.invalidateQueries({ queryKey: installerQueryKey }),
				queryClient.invalidateQueries({ queryKey: installJobsQueryKey }),
			]);
			if (error) throw new Error(apiErrorMessage(error));
			await queryClient.invalidateQueries({ queryKey: agentReadinessQueryKey });
		} catch (error) {
			setRefreshError(error instanceof Error ? error.message : t("settings.harness.loadFailed"));
		}
	};

	return (
		<SettingsSection title={t("settings.harness")} titleHidden={titleHidden} sectionId="harness">
			<div className="sticky top-0 z-10 flex items-center gap-2 bg-card pb-2">
				<label className="flex h-9! min-w-0 flex-1 items-center gap-2 rounded-md border border-(--color-border-settings-input) bg-(--color-bg-settings-input) px-3">
					<Search aria-hidden="true" className="size-4 shrink-0 text-settings-muted" />
					<span className="sr-only">{t("settings.harness.search")}</span>
					<input aria-label={t("settings.harness.search")} className="min-w-0 flex-1 bg-transparent text-sm text-settings-label outline-none placeholder:text-settings-muted" placeholder={t("settings.harness.searchPlaceholder")} value={search} onChange={(event) => setSearch(event.target.value)} />
				</label>
				<Button
					aria-label={t("settings.harness.refresh")}
					className="h-9! w-9! min-h-9! min-w-9! shrink-0 aspect-square p-0"
					size="icon-sm"
					variant="outline"
					onClick={() => void refresh()}
				>
					<RefreshCw className={cn((agents.isFetching || installers.isFetching || jobs.isFetching) && "animate-spin")} />
				</Button>
			</div>

			{installers.error || agents.error || jobs.error || refreshError ? (
				<div className="flex items-center gap-2 rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
					<TriangleAlert className="size-4" aria-hidden="true" />
					{refreshError ?? (jobs.error instanceof Error ? jobs.error.message : t("settings.harness.loadFailed"))}
				</div>
			) : null}

			<div className="settings-grouped-rows flex w-full flex-col">
			{rows.map((agentId) => {
					const plan = plans.get(agentId);
					const job = jobMap.get(agentId);
					const isInstalled = installed.has(agentId);
					const availableMethods = plan?.methods.filter((method) => method.available) ?? [];
					const recommendedMethod = availableMethods.find((method) => method.recommended) ?? availableMethods[0];
					const selectedMethodId = selectedMethods[agentId] ?? (availableMethods.some((method) => method.id === job?.method) ? job?.method : recommendedMethod?.id) ?? "";
					const selectedMethod = availableMethods.find((method) => method.id === selectedMethodId);
					const actionError = actionErrors[agentId];
					const failed = job?.status === "failed" || job?.status === "unsupported" || job?.status === "interrupted" || Boolean(actionError);
					const active = isActive(job);
					const pending = pendingAgentIds.has(agentId);
					const hasDiagnostics = Boolean(job && (job.error || job.output || job.method || job.expectedDestination));
					const methodLabel = installMethodLabel(selectedMethod, plan?.method);
					const installedMethod = job?.method
						? installMethodLabel(availableMethods.find((method) => method.id === job.method), job.method)
						: undefined;
					const availableMethodsLabel = availableMethods.length > 0
						? new Intl.ListFormat(i18n.resolvedLanguage ?? "en", { style: "short", type: "conjunction" }).format(availableMethods.map((method) => installMethodLabel(method) ?? method.label))
						: methodLabel;
					const methodSelect = availableMethods.length > 1 ? (
										<SettingsOptionMenu
											aria-label={t("settings.harness.installMethod")}
											value={selectedMethodId}
											options={availableMethods.map((method) => ({ value: method.id, label: installMethodLabel(method) ?? method.label }))}
											triggerClassName="h-8! min-h-8! w-8! min-w-8! justify-center! rounded-none! border-l border-settings-menu bg-transparent px-0! text-xs leading-4 hover:bg-[var(--color-bg-settings-trigger-hover)]!"
							renderTrigger={(selected) => <span className="sr-only">{selected?.label}</span>}
							onChange={(value) => setSelectedMethods((current) => ({ ...current, [agentId]: value }))}
						/>
					) : null;
					return (
						<div className="settings-row-bar min-h-14 flex-wrap gap-3" data-agent={agentId} key={agentId}>
							<AgentAvatar className="size-7 shrink-0" decorative provider={agentId} />
							<div className="min-w-0 flex-1">
								<p className="truncate text-sm font-medium text-settings-label" id={`harness-agent-${agentId}`}>{agentLabel(agentId)}</p>
								<p className={cn("truncate text-xs text-settings-muted", failed && "text-error")} title={actionError ?? job?.error ?? plan?.reason}>
										{actionError ?? (job?.status === "interrupted" ? t("settings.harness.interrupted") : failed ? (job?.error ?? t("settings.harness.installFailed")) : isInstalled ? (installedMethod ? t("settings.harness.installedVia", { method: installedMethod }) : t("settings.harness.installed")) : plan?.available ? t("settings.harness.availableWith", { method: availableMethodsLabel }) : (plan?.reason ?? t("settings.harness.manualRequired")))}
								</p>
							</div>

			{active ? (
				<span className="inline-flex items-center gap-1.5 text-xs text-settings-muted" role="status"><LoaderCircle className="size-4 animate-spin" aria-hidden="true" />{job?.status === "installing" ? t("settings.harness.installing") : t("settings.harness.verifying")}</span>
			) : isInstalled ? (
				<Button
					type="button"
					size="none"
					variant="ghost"
					className={cn(MENU_TRIGGER_CHROME, "h-8! min-h-8! shrink-0 rounded-md! border-0! bg-[var(--color-bg-settings-trigger)] px-3! text-xs leading-4")}
					aria-label={t("settings.harness.installed")}
					disabled
				>
					{t("settings.harness.installed")}
				</Button>
							) : failed ? (
								<div className="flex items-center gap-1.5">
									{methodSelect}
									<Button size="sm" variant="outline" disabled={pending} onClick={() => void verifyInstall(agentId)}>{t("settings.harness.verifyAgain")}</Button>
									{selectedMethodId ? <Button className={MENU_TRIGGER_CHROME} size="sm" variant="ghost" onClick={() => void startInstall(agentId, selectedMethodId)} disabled={pending}>{t("settings.harness.retry")}</Button> : null}
								</div>
							) : !plan && installers.isPending ? (
								<span className="inline-flex items-center gap-1.5 text-xs text-settings-muted" role="status"><LoaderCircle className="size-4 animate-spin" aria-hidden="true" /></span>
							) : availableMethods.length > 0 ? (
				<div className="flex items-stretch overflow-hidden rounded-md bg-[var(--color-bg-settings-trigger)]">
									<Button
										className={cn(
											MENU_TRIGGER_CHROME,
											"h-8! min-h-8! rounded-none! border-0! bg-transparent px-3! text-xs leading-4 hover:bg-[var(--color-bg-settings-trigger-hover)]! dark:hover:bg-[var(--color-bg-settings-trigger-hover)]!",
											availableMethods.length > 1 && "pr-3",
										)}
										size="none"
										variant="ghost"
										aria-label={t("settings.harness.install")}
										disabled={pending}
										onClick={() => selectedMethodId && void startInstall(agentId, selectedMethodId)}
									>
										<Download aria-hidden="true" />{methodLabel}
									</Button>
									{methodSelect}
								</div>
							) : plan?.command ? (
								<Button size="sm" variant="outline" onClick={() => void copyText(agentId, plan.command!)}>{copiedAgent === agentId ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copiedAgent === agentId ? t("settings.harness.copied") : t("settings.harness.copyCommand")}</Button>
							) : null}

			{!isInstalled && hasDiagnostics ? (
				<div className="basis-full">
					<div className={cn("grid transition-[grid-template-rows] duration-200 ease-out", expandedDiagnostics[agentId] ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
						<div className="min-h-0 overflow-hidden">
							<div className="mt-1 rounded-md border border-(--color-border-settings-input) bg-(--color-bg-settings-input) p-3 text-xs text-settings-muted">
								{job?.method ? <p><span className="font-medium text-settings-label">{t("settings.harness.method")}:</span> {job.method}</p> : null}
								{job?.expectedDestination ? <p className="break-all"><span className="font-medium text-settings-label">{t("settings.harness.expectedDestination")}:</span> {job.expectedDestination}</p> : null}
								{job?.error ? <p className="mt-2 whitespace-pre-wrap text-error">{job.error}</p> : null}
								{job?.output ? <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono">{job.output}</pre> : null}
								<Button className="mt-2" size="sm" variant="outline" onClick={() => job && void copyText(agentId, diagnosticsText(agentId, job))}><Copy aria-hidden="true" />{t("settings.harness.copyDiagnostics")}</Button>
							</div>
						</div>
					</div>
					<Button aria-expanded={expandedDiagnostics[agentId] === true} size="sm" variant="ghost" onClick={() => setExpandedDiagnostics((current) => ({ ...current, [agentId]: !current[agentId] }))}>
						{expandedDiagnostics[agentId] ? t("settings.harness.hideDiagnostics") : t("settings.harness.showDiagnostics")}
					</Button>
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
