import { CircleAlert, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { components } from "../../../api/schema";
import { useAgentReadinessQuery, useEnsureAgentReadiness } from "../../hooks/useAgentReadinessQuery";
import { AgentProviderGroup } from "./AgentProviderGroup";
import { formatPercentage, formatPlanName } from "./CodexAccountDetails";
import { SettingsSection } from "./SettingsSection";

type SubscriptionUsage = components["schemas"]["SubscriptionUsageSnapshot"];
type SubscriptionLimit = components["schemas"]["SubscriptionUsageLimit"];

export function CursorSubscriptionUsageSection({ titleHidden }: { titleHidden?: boolean }) {
	const { t, i18n } = useTranslation();
	const readiness = useAgentReadinessQuery();
	useEnsureAgentReadiness({ agentIds: ["cursor"], purpose: "display" });
	const [expanded, setExpanded] = useState(true);
	const cursor = readiness.data?.agents.find((agent) => agent.id === "cursor");
	const usage = cursor?.subscriptionUsage;
	const plan = formatPlanName(usage?.plan);
	const summary = usage
		? [plan, usage.remainingPercent == null ? null : `${formatPercentage(usage.remainingPercent, i18n.language)} ${t("settings.codexAccounts.remaining")}`].filter(Boolean).join(" · ") || usage.reason
		: readiness.isLoading ? t("settings.codexAccounts.loading") : t("settings.codexAccounts.usageDetailsUnavailable");

	return (
		<SettingsSection title="Cursor" sectionId="cursor-subscription-usage" titleHidden={titleHidden}>
			<AgentProviderGroup provider="cursor" name="Cursor" summary={summary} expanded={expanded} onExpandedChange={setExpanded}>
				<div className="px-4 py-4">
					{usage ? <CursorSubscriptionUsageDetails usage={usage} locale={i18n.language} /> : (
						<p className="text-xs text-muted-foreground">{t("settings.codexAccounts.usageDetailsUnavailable")}</p>
					)}
				</div>
			</AgentProviderGroup>
		</SettingsSection>
	);
}

function CursorSubscriptionUsageDetails({ usage, locale }: { usage: SubscriptionUsage; locale: string }) {
	const { t } = useTranslation();
	const notice = usage.freshness !== "fresh" || usage.state === "unknown" || usage.state === "unsupported";
	return (
		<div className="space-y-5 text-xs">
			{notice ? (
				<p className="flex items-start gap-2 rounded-md border border-border bg-muted/20 px-3 py-2.5 leading-5 text-muted-foreground" role="status">
					{usage.freshness === "checking" ? <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin" aria-label={t("settings.codexAccounts.checking")} /> : <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />}
					<span>{usage.reason}</span>
				</p>
			) : null}
			{usage.plan ? (
				<section>
					<h4 className="mb-2 font-medium text-foreground">{t("settings.codexAccounts.yourPlan")}</h4>
					<div className="rounded-md border border-border/70 bg-muted/15 px-3.5 py-3 text-sm font-medium text-foreground">{formatPlanName(usage.plan)}</div>
				</section>
			) : null}
			{usage.limits.length > 0 ? (
				<section>
					<h4 className="mb-2 font-medium text-foreground">{t("settings.codexAccounts.generalUsageLimits")}</h4>
					<div className="divide-y divide-border/70 overflow-hidden rounded-md border border-border/70 bg-muted/15">
						{usage.limits.map((limit) => <CursorLimitRow key={limit.id} limit={limit} locale={locale} />)}
					</div>
				</section>
			) : null}
		</div>
	);
}

function CursorLimitRow({ limit, locale }: { limit: SubscriptionLimit; locale: string }) {
	const { t } = useTranslation();
	if (limit.usedValue != null || limit.usedPercent == null || limit.remainingPercent == null) {
		const value = absoluteLimitValue(limit, locale, t("settings.updates.disabled"), t("usage.unavailable"));
		return <div className="flex items-center justify-between gap-4 px-3.5 py-3"><p className="font-medium text-foreground">{limit.name}</p><p className="text-right font-medium tabular-nums text-muted-foreground">{value}</p></div>;
	}
	const remaining = Math.max(0, Math.min(100, limit.remainingPercent));
	const percentage = formatPercentage(remaining, locale);
	const reset = formatResetTime(limit.resetsAt, locale);
	const fillClass = remaining <= 0 ? "bg-error" : remaining <= 25 ? "bg-warning" : "bg-foreground/80";
	const valueClass = remaining <= 0 ? "text-error" : remaining <= 25 ? "text-warning" : "text-muted-foreground";
	return (
		<div className="grid gap-2 px-3.5 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(8rem,11rem)_auto] sm:items-center sm:gap-4">
			<div className="min-w-0"><p className="font-medium text-foreground">{limit.name}</p>{reset ? <p className="mt-0.5 text-muted-foreground" title={reset.full}>{t("settings.codexAccounts.capacityResets", { value: reset.visible })}</p> : null}</div>
			<div role="progressbar" aria-label={t("settings.codexAccounts.remainingForLimit", { label: limit.name, value: percentage })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining} className="h-1.5 w-full overflow-hidden rounded-full bg-muted"><div className={`h-full rounded-full transition-[width] ${fillClass}`} style={{ width: `${remaining}%` }} /></div>
			<p className={`whitespace-nowrap text-right tabular-nums ${valueClass}`}>{t("settings.codexAccounts.percentLeft", { value: percentage })}</p>
		</div>
	);
}

function absoluteLimitValue(limit: SubscriptionLimit, locale: string, disabled: string, unavailable: string): string {
	if (limit.state === "unlimited") return "Unlimited";
	if (limit.state === "disabled") return disabled;
	if (limit.state === "unavailable") return unavailable;
	const format = (value: number) => new Intl.NumberFormat(locale, { style: "currency", currency: limit.unit || "USD", maximumFractionDigits: 2 }).format(value);
	if (limit.usedValue != null && limit.totalValue != null) return `${format(limit.usedValue)} / ${format(limit.totalValue)}`;
	if (limit.usedValue != null) return format(limit.usedValue);
	return unavailable;
}

function formatResetTime(value: string | null | undefined, locale: string): { visible: string; full: string } | null {
	if (!value) return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	return {
		visible: new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date),
		full: new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "long" }).format(date),
	};
}
