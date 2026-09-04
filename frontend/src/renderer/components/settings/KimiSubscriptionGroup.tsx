import { CircleAlert, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useKimiSubscriptionQuery, useRefreshKimiSubscription, type KimiSubscription } from "../../hooks/useKimiSubscription";
import { Button } from "../ui/button";
import { AgentProviderGroup } from "./AgentProviderGroup";
import { formatPercentage, formatPlanName } from "./CodexAccountDetails";

type Capacity = NonNullable<KimiSubscription["capacity"]>;
type Limit = Capacity["limits"][number];

export function KimiSubscriptionGroup() {
	const { t } = useTranslation();
	const query = useKimiSubscriptionQuery();
	const refresh = useRefreshKimiSubscription();
	const [expanded, setExpanded] = useState(true);
	const capacity = query.data?.available ? query.data.capacity : undefined;
	if (!capacity) return null;
	const plan = formatPlanName(capacity.plan);
	const auth = capacity.authMethod === "oauth" ? "OAuth" : capacity.authMethod === "api_key" ? t("settings.kimiSubscription.apiKey") : null;
	const remaining = capacity.remainingPercent == null ? null : `${formatPercentage(capacity.remainingPercent)} ${t("settings.codexAccounts.remaining")}`;
	const summary = [plan, auth, remaining].filter(Boolean).join(" · ");
	return (
		<AgentProviderGroup
			provider="kimi"
			name="Kimi"
			summary={summary}
			expanded={expanded}
			onExpandedChange={setExpanded}
			action={
				<Button type="button" size="icon-sm" variant="outline" aria-label={t("settings.kimiSubscription.refresh")} disabled={refresh.isPending} onClick={() => refresh.mutate()}>
					<RefreshCw aria-hidden="true" className={refresh.isPending ? "animate-spin" : ""} />
				</Button>
			}
		>
			<KimiSubscriptionDetails capacity={capacity} refreshError={refresh.error instanceof Error ? refresh.error.message : null} />
		</AgentProviderGroup>
	);
}

function KimiSubscriptionDetails({ capacity, refreshError }: { capacity: Capacity; refreshError: string | null }) {
	const { t, i18n } = useTranslation();
	const plan = formatPlanName(capacity.plan);
	const notice = refreshError ?? (capacity.freshness === "stale" ? t("settings.kimiSubscription.checkFailed") : null);
	return <div className="space-y-5 px-4 py-4 text-xs">
		{notice ? <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2.5 leading-5 text-warning" role="status"><CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /><span>{notice}</span></p> : null}
		{plan ? <section><h4 className="mb-2 font-medium text-foreground">{t("settings.codexAccounts.yourPlan")}</h4><div className="rounded-md border border-border/70 bg-muted/15 px-3.5 py-3 text-sm font-medium text-foreground">{t("settings.codexAccounts.planLabel", { name: plan })}</div></section> : null}
		{capacity.limits.length > 0 ? <section><h4 className="mb-2 font-medium text-foreground">{t("settings.codexAccounts.generalUsageLimits")}</h4><div className="divide-y divide-border/70 overflow-hidden rounded-md border border-border/70 bg-muted/15">{capacity.limits.map((limit, index) => <KimiLimitRow key={`${limit.name}-${index}`} limit={limit} locale={i18n.language} />)}</div></section> : null}
		{capacity.limits.length === 0 && !notice ? <p className="text-muted-foreground">{t("settings.codexAccounts.usageDetailsUnavailable")}</p> : null}
	</div>;
}

function KimiLimitRow({ limit, locale }: { limit: Limit; locale: string }) {
	const { t } = useTranslation();
	const remaining = Math.max(0, Math.min(100, limit.remainingPercent));
	const percentage = formatPercentage(remaining, locale);
	const reset = formatResetTime(limit.resetsAt, locale);
	const tone = remaining <= 0 ? "exhausted" : remaining <= 25 ? "near" : "available";
	const fillClass = tone === "exhausted" ? "bg-error" : tone === "near" ? "bg-warning" : "bg-foreground/80";
	const valueClass = tone === "exhausted" ? "text-error" : tone === "near" ? "text-warning" : "text-muted-foreground";
	return <div className="grid gap-2 px-3.5 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(8rem,11rem)_auto] sm:items-center sm:gap-4"><div className="min-w-0"><p className="font-medium text-foreground">{limit.name}</p>{reset ? <p className="mt-0.5 text-muted-foreground" title={reset.full}>{t("settings.codexAccounts.capacityResets", { value: reset.visible })}</p> : null}</div><div role="progressbar" aria-label={t("settings.codexAccounts.remainingForLimit", { label: limit.name, value: percentage })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining} className="h-1.5 w-full overflow-hidden rounded-full bg-muted"><div className={`h-full rounded-full transition-[width] ${fillClass}`} style={{ width: `${remaining}%` }} /></div><p className={`whitespace-nowrap text-right tabular-nums ${valueClass}`}>{t("settings.codexAccounts.percentLeft", { value: percentage })}</p></div>;
}

function formatResetTime(value: string | null | undefined, locale: string): { visible: string; full: string } | null {
	if (!value) return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	const now = new Date();
	const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
	return {
		visible: new Intl.DateTimeFormat(locale, sameDay ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date),
		full: new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "long" }).format(date),
	};
}
