import { useTranslation } from "react-i18next";
import type { components } from "../../api/schema";
import { formatCostNanos } from "../lib/format-cost";
import { formatTokenCount } from "../lib/format-token-count";
import { cn } from "../lib/utils";

export type UsageTotals = components["schemas"]["UsageTotalsResponse"];
type EstimatedCost = components["schemas"]["EstimatedCostResponse"];

export function UsageBreakdown({
	className,
	totals,
}: {
	className?: string;
	totals: UsageTotals;
}) {
	const { t } = useTranslation();
	const cacheHitRate = formatCacheHitRate(totals.cachedInputTokens, totals.inputTokens);
	return (
		<div className={cn("space-y-2.5", className)}>
			<dl
				className="grid grid-cols-2 gap-x-4 gap-y-2 @max-[300px]/inspector:grid-cols-1"
				data-testid="session-usage-metrics"
			>
				<TokenMetric label={t("inspector.usage.uncachedInputTokens")} metric={totals.uncachedInputTokens} />
				<TokenMetric label={t("inspector.usage.cachedInputTokens")} metric={totals.cachedInputTokens} />
				<TokenMetric label={t("inspector.usage.outputTokens")} metric={totals.outputTokens} />
				<RateMetric rate={cacheHitRate} />
			</dl>
			{totals.estimatedCost ? (
				<dl className="grid grid-cols-3 gap-x-3 border-t border-border/70 pt-2">
					<CostMetric label={t("usage.input")} nanos={totals.estimatedCost.inputNanos} />
					<CostMetric label={t("usage.cachedInput")} nanos={totals.estimatedCost.cachedInputNanos} />
					<CostMetric label={t("usage.output")} nanos={totals.estimatedCost.outputNanos} />
				</dl>
			) : null}
		</div>
	);
}

export function EstimatedCostExplanation({ cost }: { cost: EstimatedCost }) {
	const { t } = useTranslation();
	const providerInfoKey =
		cost.providerAttribution === "inferred"
			? "usage.estimatedCostInfoInferred"
			: cost.providerAttribution === "mixed"
				? "usage.estimatedCostInfoMixed"
				: "usage.estimatedCostInfo";
	return (
		<>
			<p>{t(providerInfoKey)}</p>
			{cost.coverage === "partial" ? <p className="mt-1.5">{t("usage.estimatedCostInfoPartial")}</p> : null}
		</>
	);
}

function TokenMetric({ label, metric }: { label: string; metric: number | null | undefined }) {
	const { t } = useTranslation();
	const value = typeof metric === "number" && Number.isFinite(metric) ? metric : null;
	const exactValue = value?.toLocaleString("en-US");
	const accessibleLabel =
		value === null
			? t("inspector.usage.metricUnavailable", { label })
			: t("inspector.usage.metricAria", { label, count: exactValue });
	return (
		<div className="min-w-0">
			<dt className="truncate text-2xs text-settings-muted">{label}</dt>
			<dd
				aria-label={accessibleLabel}
				className="mt-0.5 truncate font-mono text-sm-md text-settings-label"
				title={
					value === null
						? t("inspector.usage.metricUnavailable", { label })
						: t("inspector.usage.tokensExact", { count: exactValue })
				}
			>
				{value === null ? "—" : formatTokenCount(value).replace(/ tok$/, "")}
			</dd>
		</div>
	);
}

function RateMetric({ rate }: { rate: string | null }) {
	const { t } = useTranslation();
	const label = t("inspector.usage.cacheHitRate");
	const description =
		rate === null
			? t("inspector.usage.metricUnavailable", { label })
			: t("inspector.usage.cacheHitRateDescription", { rate });
	return (
		<div className="min-w-0">
			<dt className="truncate text-2xs text-settings-muted">{label}</dt>
			<dd
				aria-label={description}
				className="mt-0.5 truncate font-mono text-sm-md text-settings-label"
				title={description}
			>
				{rate === null ? "—" : `${rate}%`}
			</dd>
		</div>
	);
}

function CostMetric({ label, nanos }: { label: string; nanos: number | null | undefined }) {
	const { t } = useTranslation();
	const value = formatCostNanos(nanos);
	const accessibleLabel = value ? `${label}: ${value}` : t("inspector.usage.metricUnavailable", { label });
	return (
		<div className="min-w-0">
			<dt className="truncate text-2xs text-settings-muted">{label}</dt>
			<dd
				aria-label={accessibleLabel}
				className="mt-0.5 truncate font-mono text-2xs text-settings-label"
				title={accessibleLabel}
			>
				{value ?? "—"}
			</dd>
		</div>
	);
}

function formatCacheHitRate(
	cachedInputTokens: number | null | undefined,
	inputTokens: number | null | undefined,
): string | null {
	if (
		typeof cachedInputTokens !== "number" ||
		!Number.isFinite(cachedInputTokens) ||
		typeof inputTokens !== "number" ||
		!Number.isFinite(inputTokens) ||
		inputTokens <= 0
	) {
		return null;
	}
	const percentage = Math.min(100, Math.max(0, (cachedInputTokens / inputTokens) * 100));
	return percentage.toFixed(1).replace(/\.0$/, "");
}
