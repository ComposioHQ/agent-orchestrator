"use client";

import { useState, useEffect } from "react";

export interface OrchestratorZones {
  merge: number;
  respond: number;
  review: number;
  pending: number;
  working: number;
  done: number;
}

interface OrchestratorZoneProps {
  zones: OrchestratorZones;
  createdAt: string;
}

export function OrchestratorZone({ zones, createdAt }: OrchestratorZoneProps) {
  const [uptime, setUptime] = useState<string>("");

  useEffect(() => {
    const compute = () => {
      const diff = Date.now() - new Date(createdAt).getTime();
      const h = Math.floor(diff / 3_600_000);
      const m = Math.floor((diff % 3_600_000) / 60_000);
      setUptime(h > 0 ? `${h}h ${m}m` : `${m}m`);
    };
    compute();
    const id = setInterval(compute, 30_000);
    return () => clearInterval(id);
  }, [createdAt]);

  const stats: Array<{ value: number; label: string; color: string; bg: string }> = [
    { value: zones.merge, label: "merge-ready", color: "var(--color-status-ready)", bg: "rgba(63,185,80,0.1)" },
    { value: zones.respond, label: "responding", color: "var(--color-status-error)", bg: "rgba(248,81,73,0.1)" },
    { value: zones.review, label: "review", color: "var(--color-status-attention)", bg: "rgba(209,134,22,0.1)" },
    { value: zones.working, label: "working", color: "var(--color-status-working)", bg: "rgba(88,166,255,0.1)" },
    { value: zones.pending, label: "pending", color: "var(--color-accent-yellow)", bg: "rgba(210,153,34,0.1)" },
    { value: zones.done, label: "done", color: "var(--color-text-muted)", bg: "rgba(72,79,88,0.15)" },
  ].filter((s) => s.value > 0);

  const total =
    zones.merge + zones.respond + zones.review + zones.working + zones.pending + zones.done;

  return (
    <div
      className="border-b border-[var(--color-border-subtle)] bg-[linear-gradient(to_bottom,rgba(88,166,255,0.04)_0%,transparent_100%)] px-8 py-4"
    >
      <div className="mx-auto flex max-w-[900px] flex-wrap items-center gap-3">
        {/* Total count */}
        <div className="mr-2 flex items-baseline gap-1.5">
          <span className="text-[22px] font-bold leading-none tabular-nums text-[var(--color-text-primary)]">
            {total}
          </span>
          <span className="text-[11px] text-[var(--color-text-tertiary)]">agents</span>
        </div>

        <div className="h-5 w-px bg-[var(--color-border-subtle)] mr-1" />

        {/* Per-zone pills */}
        {stats.length > 0 ? (
          stats.map((s) => (
            <div
              key={s.label}
              className="flex items-center gap-1.5 rounded-full px-2.5 py-1"
              style={{ background: s.bg }}
            >
              <span
                className="text-[15px] font-bold leading-none tabular-nums"
                style={{ color: s.color }}
              >
                {s.value}
              </span>
              <span className="text-[10px] font-medium opacity-80" style={{ color: s.color }}>
                {s.label}
              </span>
            </div>
          ))
        ) : (
          <span className="text-[12px] text-[var(--color-text-tertiary)]">no active agents</span>
        )}

        {uptime && (
          <span className="ml-auto font-[var(--font-mono)] text-[11px] text-[var(--color-text-tertiary)]">
            up {uptime}
          </span>
        )}
      </div>
    </div>
  );
}
