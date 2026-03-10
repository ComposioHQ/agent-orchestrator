import { cn } from "@/lib/cn";
import type { CostEstimate, UsageDial, UsageProvider, UsageSnapshot } from "@/lib/types";

interface UsagePanelsProps {
  snapshots: UsageSnapshot[];
  compact?: boolean;
}

interface SessionUsageCardProps {
  cost: CostEstimate | null;
  snapshot: UsageSnapshot | null;
}

const PROVIDER_META: Record<
  UsageProvider,
  { title: string; accent: string; glow: string; heading: string }
> = {
  codex: {
    title: "Codex",
    accent: "var(--color-accent-blue)",
    glow: "rgba(88,166,255,0.16)",
    heading: "ChatGPT Pro limits",
  },
  "claude-code": {
    title: "Claude Code",
    accent: "var(--color-accent-violet)",
    glow: "rgba(163,113,247,0.16)",
    heading: "claude.ai subscription",
  },
};

function formatResetTime(resetsAt: string | null | undefined): string | null {
  if (!resetsAt) return null;

  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) return null;

  const formatted = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);

  return `Resets ${formatted.replace(",", "")}`;
}

function progressForDial(dial: UsageDial): number | null {
  if (dial.status === "unavailable") return null;
  if (dial.status === "unlimited") return 100;
  if (dial.value === null) return null;

  if (dial.kind === "absolute") {
    if (typeof dial.maxValue === "number" && dial.maxValue > 0) {
      return Math.min(100, Math.max(0, (dial.value / dial.maxValue) * 100));
    }
    return 100;
  }

  const maxValue = typeof dial.maxValue === "number" && dial.maxValue > 0 ? dial.maxValue : 100;
  return Math.min(100, Math.max(0, (dial.value / maxValue) * 100));
}

function valueClassName(displayValue: string): string {
  if (displayValue.length >= 9) return "text-[11px]";
  if (displayValue.length >= 6) return "text-[14px]";
  return "text-[18px]";
}

function CircularUsageDial({
  dial,
  accent,
  compact = false,
}: {
  dial: UsageDial;
  accent: string;
  compact?: boolean;
}) {
  const size = compact ? 104 : 116;
  const strokeWidth = compact ? 8 : 9;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = progressForDial(dial);
  const dashOffset =
    progress === null ? circumference : circumference - (progress / 100) * circumference;
  const resetLabel = formatResetTime(dial.resetsAt);
  const helperText =
    dial.status === "unavailable"
      ? "No live data yet"
      : resetLabel ?? (dial.kind === "absolute" ? "Live balance" : "Live usage");

  return (
    <div
      className={cn(
        "rounded-[14px] border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.02)] px-3 py-3",
        compact ? "min-w-[150px]" : "min-w-[168px]",
      )}
    >
      <div className="flex items-center justify-center">
        <div className="relative">
          <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            className="-rotate-90"
            aria-hidden="true"
          >
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke="rgba(255,255,255,0.08)"
              strokeWidth={strokeWidth}
            />
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={dial.status === "unavailable" ? "rgba(125,133,144,0.35)" : accent}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeDasharray={
                dial.status === "unavailable"
                  ? `${circumference / 18} ${circumference / 22}`
                  : circumference
              }
              strokeDashoffset={dashOffset}
              style={{
                transition: "stroke-dashoffset 320ms ease, stroke 220ms ease",
                filter:
                  dial.status === "unavailable"
                    ? "none"
                    : `drop-shadow(0 0 12px color-mix(in srgb, ${accent} 32%, transparent))`,
              }}
            />
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            <div
              className={cn(
                "font-[var(--font-mono)] font-semibold tabular-nums text-[var(--color-text-primary)]",
                valueClassName(dial.displayValue),
              )}
            >
              {dial.status === "unlimited" ? "∞" : dial.displayValue}
            </div>
            {dial.status === "unlimited" && (
              <div className="mt-0.5 text-[9px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                unlimited
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="mt-2 space-y-1 text-center">
        <div className="text-[11px] font-medium leading-snug text-[var(--color-text-secondary)]">
          {dial.label}
        </div>
        <div className="text-[10px] text-[var(--color-text-tertiary)]">{helperText}</div>
      </div>
    </div>
  );
}

function UsageProviderSection({
  snapshot,
  compact = false,
}: {
  snapshot: UsageSnapshot;
  compact?: boolean;
}) {
  const meta = PROVIDER_META[snapshot.provider];

  return (
    <section
      className="overflow-hidden rounded-[14px] border border-[var(--color-border-default)]"
      style={{
        background: `linear-gradient(180deg, ${meta.glow} 0%, rgba(255,255,255,0.02) 32%, rgba(255,255,255,0.02) 100%)`,
        boxShadow: `0 14px 32px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.04)`,
      }}
    >
      <div className="border-b border-[var(--color-border-subtle)] px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: meta.accent, boxShadow: `0 0 14px ${meta.glow}` }}
          />
          <h3 className="text-[13px] font-semibold text-[var(--color-text-primary)]">
            {meta.title}
          </h3>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.11em] text-[var(--color-text-tertiary)]">
          <span>{meta.heading}</span>
          {snapshot.plan && (
            <span className="rounded-full border border-[var(--color-border-subtle)] px-2 py-0.5 normal-case tracking-normal text-[10px]">
              {snapshot.plan}
            </span>
          )}
        </div>
      </div>
      <div
        className={cn(
          "grid gap-3 p-4",
          compact ? "grid-cols-1 sm:grid-cols-2 xl:grid-cols-4" : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3",
        )}
      >
        {snapshot.dials.map((dial) => (
          <CircularUsageDial
            key={`${snapshot.provider}-${dial.id}`}
            dial={dial}
            accent={meta.accent}
            compact={compact}
          />
        ))}
      </div>
    </section>
  );
}

function UsageMetric({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="rounded-[12px] border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.03)] px-3 py-3">
      <div className="text-[10px] uppercase tracking-[0.11em] text-[var(--color-text-tertiary)]">
        {label}
      </div>
      <div className="mt-1 font-[var(--font-mono)] text-[18px] font-semibold tabular-nums" style={{ color: accent }}>
        {value}
      </div>
    </div>
  );
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 0.1 ? 3 : 2,
    maximumFractionDigits: value < 0.1 ? 3 : 2,
  }).format(value);
}

export function UsagePanels({ snapshots, compact = false }: UsagePanelsProps) {
  return (
    <div className="space-y-4">
      {snapshots.map((snapshot) => (
        <UsageProviderSection
          key={snapshot.provider}
          snapshot={snapshot}
          compact={compact}
        />
      ))}
    </div>
  );
}

export function SessionUsageCard({ cost, snapshot }: SessionUsageCardProps) {
  if (!cost && !snapshot) {
    return null;
  }

  const accent = snapshot ? PROVIDER_META[snapshot.provider].accent : "var(--color-accent)";

  return (
    <div className="detail-card mb-6 rounded-[8px] border border-[var(--color-border-default)] p-5">
      <div className="mb-4 flex items-center gap-2">
        <div className="h-3 w-0.5 rounded-full" style={{ background: accent, opacity: 0.8 }} />
        <span className="text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
          Usage
        </span>
      </div>

      {cost && (
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <UsageMetric
            label="Input tokens"
            value={new Intl.NumberFormat("en-US").format(cost.inputTokens)}
            accent={accent}
          />
          <UsageMetric
            label="Output tokens"
            value={new Intl.NumberFormat("en-US").format(cost.outputTokens)}
            accent={accent}
          />
          <UsageMetric
            label="Estimated cost"
            value={formatCurrency(cost.estimatedCostUsd)}
            accent={accent}
          />
        </div>
      )}

      {snapshot && <UsageProviderSection snapshot={snapshot} compact />}
    </div>
  );
}
