"use client";

import { useCallback, useEffect, useState } from "react";
import type { SSEDispatcherState } from "@/lib/types";
import type { DispatcherProjectConfig } from "@composio/ao-core/types";

interface ScoredIssue {
  issue: { id: string; title: string; url: string };
  projectId: string;
  totalScore: number;
  reason: string;
  isBlocked: boolean;
}

interface DispatcherPanelProps {
  projectId?: string;
  dispatcherState: SSEDispatcherState | null;
  onClose: () => void;
}

interface FullDispatcherState {
  status: "running" | "stopped" | "paused";
  lastCycleAt: string | null;
  nextCycleAt: string | null;
  activeDispatches: number;
  eligibleCount: number;
  scoreboard: ScoredIssue[];
  cycleCount: number;
  excludeLabels: string[];
  projectConfig?: DispatcherProjectConfig;
}

export function DispatcherPanel({ projectId, dispatcherState, onClose }: DispatcherPanelProps) {
  const [fullState, setFullState] = useState<FullDispatcherState | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [configDirty, setConfigDirty] = useState(false);
  const [editConfig, setEditConfig] = useState<Partial<DispatcherProjectConfig>>({});

  const fetchFullState = useCallback(async () => {
    try {
      const url = projectId
        ? `/api/dispatcher?project=${encodeURIComponent(projectId)}`
        : "/api/dispatcher";
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json() as FullDispatcherState;
        setFullState(data);
        if (!configDirty && data.projectConfig) {
          setEditConfig(data.projectConfig);
        }
      }
    } catch {
      // Transient failure
    } finally {
      setLoading(false);
    }
  }, [projectId, configDirty]);

  // Initial fetch + refresh when SSE state changes
  useEffect(() => {
    void fetchFullState();
  }, [fetchFullState, dispatcherState?.cycleCount]);

  // Poll for full state every 10s while panel is open
  useEffect(() => {
    const timer = setInterval(() => void fetchFullState(), 10_000);
    return () => clearInterval(timer);
  }, [fetchFullState]);

  const dispatchAction = async (action: string) => {
    setActionLoading(true);
    try {
      const res = await fetch("/api/dispatcher", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        const data = await res.json() as FullDispatcherState;
        setFullState(data);
      }
    } catch {
      // Action failed
    } finally {
      setActionLoading(false);
    }
  };

  const saveConfig = async () => {
    if (!projectId) return;
    try {
      const res = await fetch("/api/dispatcher/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, config: editConfig }),
      });
      if (res.ok) {
        setConfigDirty(false);
        void fetchFullState();
      }
    } catch {
      // Save failed
    }
  };

  const updateField = <K extends keyof DispatcherProjectConfig>(
    key: K,
    value: DispatcherProjectConfig[K],
  ) => {
    setEditConfig((prev) => ({ ...prev, [key]: value }));
    setConfigDirty(true);
  };

  const updateScoring = (key: string, value: number) => {
    setEditConfig((prev) => ({
      ...prev,
      scoring: { ...(prev.scoring || { severity: 40, quickWin: 25, staleness: 15, dependencies: 20 }), [key]: value },
    }));
    setConfigDirty(true);
  };

  const status = fullState?.status ?? dispatcherState?.status ?? "stopped";
  const statusColor =
    status === "running"
      ? "var(--color-status-ready)"
      : status === "paused"
        ? "var(--color-status-attention)"
        : "var(--color-text-secondary)";

  return (
    <div className="fixed inset-y-0 left-0 z-50 flex">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="relative z-10 flex h-full w-[460px] flex-col border-r border-[var(--color-border-default)] bg-[var(--color-bg-primary)]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-4 py-3">
          <div className="flex items-center gap-3">
            <h2 className="text-[14px] font-semibold text-[var(--color-text-primary)]">
              Dispatcher
            </h2>
            <span
              className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider"
              style={{ color: statusColor }}
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: statusColor }}
              />
              {status}
            </span>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-4 py-2.5">
          {status === "stopped" ? (
            <button
              onClick={() => void dispatchAction("start")}
              disabled={actionLoading}
              className="rounded-[6px] bg-[var(--color-accent)] px-3 py-1.5 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              Start
            </button>
          ) : status === "running" ? (
            <>
              <button
                onClick={() => void dispatchAction("pause")}
                disabled={actionLoading}
                className="rounded-[6px] border border-[var(--color-border-default)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50"
              >
                Pause
              </button>
              <button
                onClick={() => void dispatchAction("stop")}
                disabled={actionLoading}
                className="rounded-[6px] border border-[var(--color-status-error)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-status-error)] hover:bg-[rgba(239,68,68,0.08)] disabled:opacity-50"
              >
                Stop
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => void dispatchAction("resume")}
                disabled={actionLoading}
                className="rounded-[6px] bg-[var(--color-accent)] px-3 py-1.5 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                Resume
              </button>
              <button
                onClick={() => void dispatchAction("stop")}
                disabled={actionLoading}
                className="rounded-[6px] border border-[var(--color-border-default)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50"
              >
                Stop
              </button>
            </>
          )}
          <button
            onClick={() => void dispatchAction("cycle")}
            disabled={actionLoading || status === "stopped"}
            className="rounded-[6px] border border-[var(--color-border-default)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50"
            title="Run one dispatch cycle now"
          >
            Run Cycle
          </button>

          {/* Stats */}
          <div className="ml-auto flex gap-3 text-[11px] text-[var(--color-text-secondary)]">
            <span>{fullState?.activeDispatches ?? dispatcherState?.activeDispatches ?? 0} active</span>
            <span>{fullState?.eligibleCount ?? dispatcherState?.eligibleCount ?? 0} eligible</span>
            <span>#{fullState?.cycleCount ?? dispatcherState?.cycleCount ?? 0}</span>
          </div>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-[12px] text-[var(--color-text-secondary)]">
              Loading...
            </div>
          ) : (
            <>
              {/* Scoreboard */}
              <div className="border-b border-[var(--color-border-subtle)] px-4 py-3">
                <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-secondary)]">
                  Issue Scoreboard
                </h3>
                {(fullState?.scoreboard?.length ?? 0) === 0 ? (
                  <p className="py-4 text-center text-[11px] text-[var(--color-text-secondary)]">
                    {status === "stopped"
                      ? "Start the dispatcher to see scored issues"
                      : "No eligible issues found"}
                  </p>
                ) : (
                  <div className="overflow-hidden rounded-[6px] border border-[var(--color-border-default)]">
                    <table className="w-full border-collapse text-[11px]">
                      <thead>
                        <tr className="border-b border-[var(--color-border-muted)] bg-[var(--color-bg-surface)]">
                          <th className="px-2 py-1.5 text-left font-semibold text-[var(--color-text-secondary)]">#</th>
                          <th className="px-2 py-1.5 text-left font-semibold text-[var(--color-text-secondary)]">Score</th>
                          <th className="px-2 py-1.5 text-left font-semibold text-[var(--color-text-secondary)]">Title</th>
                          <th className="px-2 py-1.5 text-left font-semibold text-[var(--color-text-secondary)]">Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fullState?.scoreboard?.slice(0, 20).map((si) => (
                          <tr
                            key={`${si.projectId}-${si.issue.id}`}
                            className="border-b border-[var(--color-border-subtle)] last:border-0"
                          >
                            <td className="px-2 py-1.5 text-[var(--color-text-primary)]">
                              {si.issue.url ? (
                                <a
                                  href={si.issue.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-[var(--color-accent)] hover:underline"
                                >
                                  {si.issue.id}
                                </a>
                              ) : (
                                si.issue.id
                              )}
                            </td>
                            <td className="px-2 py-1.5 tabular-nums font-medium text-[var(--color-text-primary)]">
                              {si.totalScore.toFixed(1)}
                            </td>
                            <td className="max-w-[180px] truncate px-2 py-1.5 text-[var(--color-text-primary)]" title={si.issue.title}>
                              {si.isBlocked && (
                                <span className="mr-1 text-[var(--color-status-error)]" title="Blocked">
                                  !
                                </span>
                              )}
                              {si.issue.title}
                            </td>
                            <td className="max-w-[120px] truncate px-2 py-1.5 text-[var(--color-text-secondary)]" title={si.reason}>
                              {si.reason}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Settings */}
              {projectId && (
                <div className="px-4 py-3">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-secondary)]">
                      Settings
                    </h3>
                    {configDirty && (
                      <button
                        onClick={() => void saveConfig()}
                        className="rounded-[6px] bg-[var(--color-accent)] px-2.5 py-1 text-[10px] font-semibold text-white hover:opacity-90"
                      >
                        Save Changes
                      </button>
                    )}
                  </div>

                  <div className="space-y-3">
                    {/* Enabled toggle */}
                    <label className="flex items-center justify-between">
                      <span className="text-[11px] text-[var(--color-text-primary)]">Enabled</span>
                      <input
                        type="checkbox"
                        checked={editConfig.enabled ?? false}
                        onChange={(e) => updateField("enabled", e.target.checked)}
                        className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                      />
                    </label>

                    {/* Concurrency */}
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-[var(--color-text-primary)]">
                          Max concurrent
                        </span>
                        <span className="text-[11px] tabular-nums text-[var(--color-text-primary)]">
                          {editConfig.maxConcurrent ?? 3}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={1}
                        max={5}
                        step={1}
                        value={editConfig.maxConcurrent ?? 3}
                        onChange={(e) => updateField("maxConcurrent", Number(e.target.value))}
                        className="mt-1 w-full accent-[var(--color-accent)]"
                      />
                    </div>

                    {/* Poll interval */}
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-[var(--color-text-primary)]">
                          Poll interval (sec)
                        </span>
                        <span className="text-[11px] tabular-nums text-[var(--color-text-primary)]">
                          {editConfig.pollInterval ?? 120}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={30}
                        max={600}
                        step={30}
                        value={editConfig.pollInterval ?? 120}
                        onChange={(e) => updateField("pollInterval", Number(e.target.value))}
                        className="mt-1 w-full accent-[var(--color-accent)]"
                      />
                    </div>

                    {/* Spawns per cycle */}
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-[var(--color-text-primary)]">
                          Max spawns per cycle
                        </span>
                        <span className="text-[11px] tabular-nums text-[var(--color-text-primary)]">
                          {editConfig.maxSpawnsPerCycle ?? 2}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={1}
                        max={5}
                        step={1}
                        value={editConfig.maxSpawnsPerCycle ?? 2}
                        onChange={(e) => updateField("maxSpawnsPerCycle", Number(e.target.value))}
                        className="mt-1 w-full accent-[var(--color-accent)]"
                      />
                    </div>

                    {/* Backlog boost */}
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-[var(--color-text-primary)]">
                          Backlog label boost
                        </span>
                        <span className="text-[11px] tabular-nums text-[var(--color-text-primary)]">
                          {editConfig.backlogBoost ?? 30}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={60}
                        step={5}
                        value={editConfig.backlogBoost ?? 30}
                        onChange={(e) => updateField("backlogBoost", Number(e.target.value))}
                        className="mt-1 w-full accent-[var(--color-accent)]"
                      />
                    </div>

                    {/* Comment on dispatch */}
                    <label className="flex items-center justify-between">
                      <span className="text-[11px] text-[var(--color-text-primary)]">Comment on dispatch</span>
                      <input
                        type="checkbox"
                        checked={editConfig.commentOnDispatch ?? true}
                        onChange={(e) => updateField("commentOnDispatch", e.target.checked)}
                        className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                      />
                    </label>

                    {/* Scoring weights */}
                    <div className="rounded-[6px] border border-[var(--color-border-subtle)] p-2.5">
                      <h4 className="mb-2 text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-secondary)]">
                        Scoring Weights
                      </h4>
                      {(["severity", "quickWin", "staleness", "dependencies"] as const).map((key) => (
                        <div key={key} className="mb-1.5 last:mb-0">
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] text-[var(--color-text-primary)]">
                              {key === "quickWin" ? "Quick Win" : key.charAt(0).toUpperCase() + key.slice(1)}
                            </span>
                            <span className="text-[11px] tabular-nums text-[var(--color-text-primary)]">
                              {editConfig.scoring?.[key] ?? { severity: 40, quickWin: 25, staleness: 15, dependencies: 20 }[key]}
                            </span>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={60}
                            step={5}
                            value={editConfig.scoring?.[key] ?? { severity: 40, quickWin: 25, staleness: 15, dependencies: 20 }[key]}
                            onChange={(e) => updateScoring(key, Number(e.target.value))}
                            className="mt-0.5 w-full accent-[var(--color-accent)]"
                          />
                        </div>
                      ))}
                    </div>

                    {/* Exclusion labels */}
                    {(fullState?.excludeLabels?.length ?? 0) > 0 && (
                      <div>
                        <h4 className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-secondary)]">
                          Exclusion Patterns
                        </h4>
                        <div className="flex flex-wrap gap-1">
                          {fullState?.excludeLabels?.map((label) => (
                            <span
                              key={label}
                              className="rounded-full bg-[var(--color-bg-surface)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)] ring-1 ring-[var(--color-border-default)]"
                            >
                              {label}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer: last cycle info */}
        {fullState?.lastCycleAt && (
          <div className="border-t border-[var(--color-border-subtle)] px-4 py-2 text-[11px] text-[var(--color-text-secondary)]">
            Last cycle: {new Date(fullState.lastCycleAt).toLocaleTimeString()}
            {fullState.nextCycleAt && (
              <span className="ml-2">
                Next: {new Date(fullState.nextCycleAt).toLocaleTimeString()}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
