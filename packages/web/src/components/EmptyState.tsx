import type { ReactNode } from "react";

interface EmptyStateProps {
  icon?: ReactNode;
  message: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, message, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border-subtle)] px-6 py-10 text-center">
      {icon ? <div className="mb-3 text-[var(--color-text-muted)]">{icon}</div> : null}
      <p className="text-[13px] font-medium text-[var(--color-text-secondary)]">{message}</p>
      {description ? (
        <p className="mt-1 max-w-[320px] text-[11px] leading-relaxed text-[var(--color-text-tertiary)]">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
