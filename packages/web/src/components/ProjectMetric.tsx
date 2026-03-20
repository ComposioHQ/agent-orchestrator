export function ProjectMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] px-1.5 py-1.5 md:px-2.5 md:py-2">
      <div className="truncate text-[8px] uppercase tracking-[0.06em] text-[var(--color-text-tertiary)] md:overflow-visible md:text-[10px] md:tracking-[0.08em]">
        {label}
      </div>
      <div className="mt-0.5 text-[14px] font-semibold tabular-nums md:mt-1 md:text-[18px]" style={{ color: tone }}>
        {value}
      </div>
    </div>
  );
}
