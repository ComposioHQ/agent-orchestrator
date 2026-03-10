"use client";

import { startTransition, useEffect, useState } from "react";
import { UsagePanels } from "./UsageDials";
import type { DashboardUsageResponse } from "@/lib/types";

interface UsageOverviewProps {
  refreshIntervalMs?: number;
}

export function UsageOverview({ refreshIntervalMs = 60_000 }: UsageOverviewProps) {
  const [usage, setUsage] = useState<DashboardUsageResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const fetchUsage = async () => {
      try {
        const response = await fetch("/api/usage");
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = (await response.json()) as DashboardUsageResponse;
        if (!cancelled) {
          startTransition(() => {
            setUsage(data);
            setError(false);
          });
        }
      } catch (fetchError) {
        console.error("Failed to fetch usage:", fetchError);
        if (!cancelled) {
          startTransition(() => {
            setError(true);
          });
        }
      }
    };

    void fetchUsage();
    const intervalId = window.setInterval(() => {
      void fetchUsage();
    }, refreshIntervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [refreshIntervalMs]);

  return (
    <section className="mb-8">
      <div className="mb-3 px-1">
        <h2 className="text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
          Subscription Usage
        </h2>
        <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
          Live subscription dials from active Codex and Claude Code sessions.
        </p>
      </div>

      {usage ? (
        <UsagePanels snapshots={usage.snapshots} />
      ) : (
        <div className="rounded-[14px] border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.03)] px-4 py-5 text-[13px] text-[var(--color-text-secondary)]">
          {error ? "Usage data is temporarily unavailable." : "Loading usage dials…"}
        </div>
      )}
    </section>
  );
}
