"use client";

import { useState, useEffect, useCallback } from "react";

interface RouteStats {
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  errors: number;
}

interface SlowRequest {
  ts: string;
  method: string;
  path: string;
  durationMs: number;
  timings?: Record<string, number>;
}

interface PerfData {
  routes: Record<string, RouteStats>;
  slowest: SlowRequest[];
  cacheStats: { hits: number; misses: number; hitRate: number; size: number } | null;
  totalRequests: number;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function PerfDashboard() {
  const [data, setData] = useState<PerfData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchPerf = useCallback(async () => {
    try {
      const res = await fetch("/api/perf");
      if (!res.ok) return;
      setData((await res.json()) as PerfData);
    } catch {
      // Transient error
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPerf();
    const interval = setInterval(() => void fetchPerf(), 30_000);
    return () => clearInterval(interval);
  }, [fetchPerf]);

  if (loading) {
    return <div className="py-8 text-center text-[var(--color-text-muted)]">Loading performance data...</div>;
  }

  if (!data || Object.keys(data.routes).length === 0) {
    return (
      <div className="py-8 text-center text-[var(--color-text-muted)]">
        No performance data yet. Hit the dashboard a few times to generate API request logs.
      </div>
    );
  }

  const sortedRoutes = Object.entries(data.routes).sort(
    ([, a], [, b]) => b.p95Ms - a.p95Ms,
  );

  return (
    <div className="space-y-8">
      {/* Route Performance Table */}
      <section>
        <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-widest text-[var(--color-text-muted)]">
          Route Performance
        </h2>
        <div className="overflow-hidden rounded-lg border border-[var(--color-border-default)]">
          <table className="w-full border-collapse font-mono text-xs">
            <thead>
              <tr className="border-b border-[var(--color-border-muted)] bg-[var(--color-bg-secondary)]">
                <th className="px-3 py-2 text-left font-semibold text-[var(--color-text-muted)]">Route</th>
                <th className="px-3 py-2 text-right font-semibold text-[var(--color-text-muted)]">Count</th>
                <th className="px-3 py-2 text-right font-semibold text-[var(--color-text-muted)]">p50</th>
                <th className="px-3 py-2 text-right font-semibold text-[var(--color-text-muted)]">p95</th>
                <th className="px-3 py-2 text-right font-semibold text-[var(--color-text-muted)]">p99</th>
                <th className="px-3 py-2 text-right font-semibold text-[var(--color-text-muted)]">Errors</th>
              </tr>
            </thead>
            <tbody>
              {sortedRoutes.map(([route, stats]) => (
                <tr
                  key={route}
                  className="border-b border-[var(--color-border-muted)] last:border-0 hover:bg-[var(--color-bg-secondary)]"
                >
                  <td className="px-3 py-1.5 text-[var(--color-accent-blue)]">{route}</td>
                  <td className="px-3 py-1.5 text-right text-[var(--color-text-secondary)]">{stats.count}</td>
                  <td className="px-3 py-1.5 text-right">{formatMs(stats.p50Ms)}</td>
                  <td className={`px-3 py-1.5 text-right ${stats.p95Ms > 1000 ? "text-yellow-400" : ""}`}>
                    {formatMs(stats.p95Ms)}
                  </td>
                  <td className={`px-3 py-1.5 text-right ${stats.p99Ms > 2000 ? "text-red-400" : ""}`}>
                    {formatMs(stats.p99Ms)}
                  </td>
                  <td className={`px-3 py-1.5 text-right ${stats.errors > 0 ? "text-red-400" : "text-[var(--color-text-muted)]"}`}>
                    {stats.errors}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Slowest Requests */}
      {data.slowest.length > 0 && (
        <section>
          <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-widest text-[var(--color-text-muted)]">
            Slowest Requests
          </h2>
          <div className="overflow-hidden rounded-lg border border-[var(--color-border-default)]">
            <table className="w-full border-collapse font-mono text-xs">
              <thead>
                <tr className="border-b border-[var(--color-border-muted)] bg-[var(--color-bg-secondary)]">
                  <th className="px-3 py-2 text-right font-semibold text-[var(--color-text-muted)]">Duration</th>
                  <th className="px-3 py-2 text-left font-semibold text-[var(--color-text-muted)]">Request</th>
                  <th className="px-3 py-2 text-left font-semibold text-[var(--color-text-muted)]">Time</th>
                  <th className="px-3 py-2 text-left font-semibold text-[var(--color-text-muted)]">Breakdown</th>
                </tr>
              </thead>
              <tbody>
                {data.slowest.map((req, i) => (
                  <tr
                    key={`${req.ts}-${i}`}
                    className="border-b border-[var(--color-border-muted)] last:border-0 hover:bg-[var(--color-bg-secondary)]"
                  >
                    <td className="whitespace-nowrap px-3 py-1.5 text-right text-yellow-400">
                      {formatMs(req.durationMs)}
                    </td>
                    <td className="px-3 py-1.5 text-[var(--color-accent-blue)]">
                      {req.method} {req.path}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-[var(--color-text-muted)]">
                      {new Date(req.ts).toLocaleTimeString()}
                    </td>
                    <td className="px-3 py-1.5 text-[var(--color-text-muted)]">
                      {req.timings
                        ? Object.entries(req.timings)
                            .map(([k, v]) => `${k}: ${formatMs(v)}`)
                            .join(", ")
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Cache Stats */}
      {data.cacheStats && (
        <section>
          <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-widest text-[var(--color-text-muted)]">
            Cache
          </h2>
          <div className="flex gap-8 rounded-lg border border-[var(--color-border-default)] px-4 py-3">
            <div>
              <div className="text-2xl font-bold text-[var(--color-accent-green)]">
                {(data.cacheStats.hitRate * 100).toFixed(1)}%
              </div>
              <div className="text-xs text-[var(--color-text-muted)]">hit rate</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-[var(--color-text-primary)]">
                {data.cacheStats.hits}
              </div>
              <div className="text-xs text-[var(--color-text-muted)]">hits</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-[var(--color-text-primary)]">
                {data.cacheStats.misses}
              </div>
              <div className="text-xs text-[var(--color-text-muted)]">misses</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-[var(--color-text-primary)]">
                {data.cacheStats.size}
              </div>
              <div className="text-xs text-[var(--color-text-muted)]">entries</div>
            </div>
          </div>
        </section>
      )}

      <div className="text-xs text-[var(--color-text-muted)]">
        {data.totalRequests} total requests logged
      </div>
    </div>
  );
}
