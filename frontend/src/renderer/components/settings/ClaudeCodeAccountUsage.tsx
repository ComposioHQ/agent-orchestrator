import { Info, LoaderCircle } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { ClaudeCodeAccount } from "../../hooks/useClaudeCodeAccountsQuery";
import { claudeCodePlanName, formatClaudeCodePercentage } from "./claude-code-account-format";

type UsageWindow = ClaudeCodeAccount["planUsage"]["windows"][number];
type Promotion = NonNullable<ClaudeCodeAccount["planUsage"]["promotion"]>;

const GENERAL_WINDOW_IDS = new Set(["five_hour", "seven_day"]);

export function ClaudeCodeAccountUsage({ account }: { account: ClaudeCodeAccount }) {
	const { t, i18n } = useTranslation();
	const usage = account.planUsage;
	const plan = formatPlanLabel(usage.plan, t);
	const generalWindows = usage.windows.filter((window) => GENERAL_WINDOW_IDS.has(window.id));
	const modelWindows = usage.windows.filter((window) => !GENERAL_WINDOW_IDS.has(window.id));
	const available = usage.windows.length > 0;

	return <div className="ml-9 mt-4 space-y-5 pb-1 text-xs">
		<PlanCard accountId={account.id} plan={plan} promotion={usage.promotion} showPromotionStatus={account.active} locale={i18n.language} />
		{generalWindows.length > 0 ? <UsageWindowGroup title={t("settings.claudeCodeAccounts.generalUsageLimits")} windows={generalWindows} locale={i18n.language} /> : null}
		{modelWindows.length > 0 ? <UsageWindowGroup title={t("settings.claudeCodeAccounts.modelUsageLimits")} windows={modelWindows} locale={i18n.language} /> : null}
		{!available ? <p className="flex items-center gap-2 rounded-md border border-border/70 bg-muted/15 px-3.5 py-3 text-muted-foreground" role="status">
			{usage.freshness === "checking" ? <LoaderCircle className="size-3.5 animate-spin" aria-label={t("settings.claudeCodeAccounts.checking")} /> : null}
			{usage.reason || t("settings.claudeCodeAccounts.planUsageUnavailable")}
		</p> : null}
		{available && usage.freshness === "stale" ? <p className="text-muted-foreground" role="status">{usage.reason}</p> : null}
	</div>;
}

function PlanCard({ accountId, plan, promotion, showPromotionStatus, locale }: { accountId: string; plan: string | null; promotion: Promotion | null | undefined; showPromotionStatus: boolean; locale: string }) {
	const { t } = useTranslation();
	const headingId = `claude-code-account-${accountId}-plan-heading`;
	const endDate = promotion ? formatPromotionDate(promotion.endsOn, locale) : null;
	const percent = promotion ? formatClaudeCodePercentage(promotion.percentIncrease, locale) : null;
	const details = promotion && endDate && percent ? t("settings.claudeCodeAccounts.boostDetails", { percent, date: endDate.full }) : null;

	return <section aria-labelledby={headingId}>
		<h4 id={headingId} className="mb-2 font-medium text-foreground">{t("settings.claudeCodeAccounts.yourPlan")}</h4>
		<div className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-border/70 bg-muted/15 px-3.5 py-3">
			<p className={`text-sm font-medium ${plan ? "text-foreground" : "text-muted-foreground"}`}>{plan ?? t("settings.claudeCodeAccounts.planUnavailable")}</p>
			{showPromotionStatus && promotion && endDate && percent ? <p className="flex items-center gap-1.5 font-medium text-foreground">
				{t("settings.claudeCodeAccounts.boostSummary", { percent, date: endDate.visible })}
				<span tabIndex={0} aria-label={details ?? undefined} title={details ?? undefined} className="inline-flex rounded-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"><Info className="size-3.5" aria-hidden="true" /></span>
			</p> : showPromotionStatus ? <p className="text-muted-foreground">{t("settings.claudeCodeAccounts.noBoostsAvailable")}</p> : null}
		</div>
	</section>;
}

function UsageWindowGroup({ title, windows, locale }: { title: string; windows: UsageWindow[]; locale: string }) {
	return <section>
		<h4 className="mb-2 font-medium text-foreground">{title}</h4>
		<div className="divide-y divide-border/70 overflow-hidden rounded-md border border-border/70 bg-muted/15">
			{windows.map((window) => <PlanUsageWindow key={window.id} window={window} locale={locale} />)}
		</div>
	</section>;
}

function PlanUsageWindow({ window, locale }: { window: UsageWindow; locale: string }) {
	const { t } = useTranslation();
	const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
	const percentage = formatClaudeCodePercentage(remaining, locale);
	const reset = formatResetTime(window.resetsAt, locale);
	const tone = remaining <= 0 ? "exhausted" : remaining <= 25 ? "near" : "available";
	const fillClass = tone === "exhausted" ? "bg-error" : tone === "near" ? "bg-warning" : "bg-foreground/80";
	const valueClass = tone === "exhausted" ? "text-error" : tone === "near" ? "text-warning" : "text-muted-foreground";

	return <div className="grid gap-2 px-3.5 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(8rem,11rem)_auto] sm:items-center sm:gap-4">
		<div className="min-w-0"><p className="font-medium text-foreground">{window.displayName}</p>{reset ? <p className="mt-0.5 text-muted-foreground" title={reset.full}>{t("settings.claudeCodeAccounts.resets", { value: reset.visible })}</p> : null}</div>
		<div role="progressbar" aria-label={t("settings.claudeCodeAccounts.remainingForLimit", { label: window.displayName, value: percentage })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining} className="h-1.5 w-full overflow-hidden rounded-full bg-muted"><div className={`h-full rounded-full transition-[width] ${fillClass}`} style={{ width: `${remaining}%` }} /></div>
		<p className={`whitespace-nowrap text-right tabular-nums ${valueClass}`}>{t("settings.claudeCodeAccounts.percentLeft", { value: percentage })}</p>
	</div>;
}

function formatPlanLabel(plan: string | null | undefined, t: TFunction): string | null {
	const name = claudeCodePlanName(plan);
	return name ? (/\bplan$/i.test(name) ? name : t("settings.claudeCodeAccounts.planLabel", { name })) : null;
}

function formatPromotionDate(value: string, locale: string): { visible: string; full: string } | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return null;
	const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	if (Number.isNaN(date.getTime())) return null;
	return {
		visible: new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(date),
		full: new Intl.DateTimeFormat(locale, { day: "numeric", month: "long" }).format(date),
	};
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
