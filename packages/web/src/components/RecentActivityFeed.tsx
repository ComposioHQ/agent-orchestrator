"use client";

import { useEffect, useState } from "react";

interface ActivitySample {
  status: string;
  activity: string | null;
  lastActivityAt: string;
}

interface ActivityEvent extends ActivitySample {
  id: string;
}

export function RecentActivityFeed({ status, activity, lastActivityAt }: ActivitySample) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);

  useEffect(() => {
    const next: ActivityEvent = {
      id: `${lastActivityAt}:${status}:${activity ?? "none"}`,
      status,
      activity,
      lastActivityAt,
    };
    setEvents((current) => {
      if (current[0]?.id === next.id) {
        return current;
      }
      return [next, ...current].slice(0, 6);
    });
  }, [status, activity, lastActivityAt]);

  return (
    <section className="mb-6 rounded-[8px] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-4">
      <div className="mb-3">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
          Recent Activity
        </h2>
        <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
          Latest status transitions observed by the dashboard.
        </p>
      </div>
      <div className="space-y-2">
        {events.map((event) => (
          <div
            key={event.id}
            className="flex items-center justify-between gap-3 rounded-[6px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)] px-3 py-2"
          >
            <div className="min-w-0">
              <div className="text-[12px] font-semibold text-[var(--color-text-primary)]">{humanize(event.status)}</div>
              <div className="text-[11px] text-[var(--color-text-secondary)]">
                activity: {event.activity ? humanize(event.activity) : "unknown"}
              </div>
            </div>
            <div className="font-[var(--font-mono)] text-[10px] text-[var(--color-text-tertiary)]">
              {formatTime(event.lastActivityAt)}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function humanize(value: string): string {
  return value.replace(/_/g, " ");
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
