"use client";

import { useState, useEffect, useMemo } from "react";

interface Project {
  id: string;
  name: string;
}

interface ParsedTask {
  type: "issue" | "prompt";
  value: string;
}

/**
 * Parse a Claude Code plan or issue list into spawnable tasks.
 *
 * Handles:
 *   - Numbered lists:  "1. Add auth", "2) Add tests"
 *   - Bullet points:   "- Add auth", "* Add auth", "• Add auth"
 *   - Checkboxes:      "- [ ] Add auth", "- [x] Done"
 *   - Markdown bold:   "1. **Add auth** — some detail"
 *   - Plain issue IDs: "INT-123", "42"
 */
function parsePlan(text: string): ParsedTask[] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  return lines.flatMap((line) => {
    const value = line
      .replace(/^\d+[.)]\s+/, "")              // "1. " or "1) "
      .replace(/^[-*•]\s+(\[[ xX]\]\s+)?/, "") // "- ", "* ", "• ", "- [ ] "
      .replace(/^\*\*(.+?)\*\*\s*[-–—:]?\s*/, "$1 ") // "**Bold** — detail" → "Bold detail"
      .trim();

    if (!value) return [];

    // If it looks like a plain identifier (e.g. INT-123, 42), treat as issue ID
    const type = /^[a-zA-Z0-9_-]+$/.test(value) ? "issue" : "prompt";
    return [{ type, value }];
  });
}

interface CreateSwarmModalProps {
  onClose: () => void;
}

export function CreateSwarmModal({ onClose }: CreateSwarmModalProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [planText, setPlanText] = useState<string>("");
  const [spawning, setSpawning] = useState(false);
  const [result, setResult] = useState<{ created: number; failed: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/config/projects")
      .then((r) => r.json())
      .then((data: { projects?: Project[]; error?: string }) => {
        const list = data.projects ?? [];
        setProjects(list);
        if (list.length === 1) {
          setSelectedProject(list[0].id);
        }
      })
      .catch(() => setError("Failed to load projects"))
      .finally(() => setProjectsLoading(false));
  }, []);

  const parsedTasks = useMemo(() => parsePlan(planText), [planText]);

  const canSpawn = selectedProject && parsedTasks.length > 0 && !spawning;

  const handleSpawn = async () => {
    if (!canSpawn) return;
    setSpawning(true);
    setError(null);

    try {
      const tasks = parsedTasks.map((task) =>
        task.type === "issue" ? { issueId: task.value } : { prompt: task.value },
      );

      const res = await fetch("/api/swarm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: selectedProject, tasks }),
      });

      const data = (await res.json()) as {
        created: unknown[];
        failed: unknown[];
        error?: string;
      };

      if (!res.ok) {
        setError(data.error ?? "Failed to spawn swarm");
        return;
      }

      setResult({ created: data.created.length, failed: data.failed.length });
    } catch {
      setError("Network error — could not reach server");
    } finally {
      setSpawning(false);
    }
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      <div className="w-full max-w-[560px] rounded-[10px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-6 shadow-2xl">
        {/* Header */}
        <div className="mb-5 flex items-start justify-between">
          <div>
            <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--color-text-primary)]">
              Create Swarm
            </h2>
            <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
              Spawn multiple agent sessions from a plan or issue list
            </p>
          </div>
          <button
            onClick={onClose}
            className="ml-4 shrink-0 rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text-primary)]"
            aria-label="Close"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {result ? (
          /* Success state */
          <div className="py-6 text-center">
            <div className="mb-3 flex items-center justify-center">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[rgba(63,185,80,0.15)] text-[var(--color-status-ready)]">
                <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </span>
            </div>
            <p className="text-[14px] font-semibold text-[var(--color-text-primary)]">
              Swarm created!
            </p>
            <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">
              {result.created} session{result.created !== 1 ? "s" : ""} started
              {result.failed > 0 && (
                <span className="ml-1 text-[var(--color-status-error)]">
                  · {result.failed} failed
                </span>
              )}
            </p>
            <button
              onClick={onClose}
              className="mt-5 rounded-[6px] bg-[var(--color-accent)] px-5 py-2 text-[12px] font-semibold text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-hover)]"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            {/* Project selector */}
            <div className="mb-4">
              <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
                Project
              </label>
              {projectsLoading ? (
                <div className="text-[12px] text-[var(--color-text-muted)]">Loading projects…</div>
              ) : projects.length === 0 ? (
                <div className="text-[12px] text-[var(--color-status-error)]">
                  No projects found in config
                </div>
              ) : (
                <select
                  value={selectedProject}
                  onChange={(e) => setSelectedProject(e.target.value)}
                  className="w-full rounded-[6px] border border-[var(--color-border-default)] bg-[var(--color-bg-subtle)] px-3 py-2 text-[12px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
                >
                  {projects.length > 1 && (
                    <option value="" disabled>
                      Select a project…
                    </option>
                  )}
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.id})
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* Plan textarea */}
            <div className="mb-4">
              <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
                Plan / Issues
              </label>
              <textarea
                value={planText}
                onChange={(e) => setPlanText(e.target.value)}
                placeholder={
                  "Paste a Claude Code plan or list of issues:\n" +
                  "\n" +
                  "1. Add user authentication\n" +
                  "2. Create REST API endpoints\n" +
                  "3. Add test coverage\n" +
                  "\n" +
                  "Or issue IDs (one per line):\n" +
                  "INT-123\n" +
                  "INT-124"
                }
                rows={8}
                className="w-full resize-none rounded-[6px] border border-[var(--color-border-default)] bg-[var(--color-bg-subtle)] px-3 py-2 font-[var(--font-mono)] text-[11px] leading-relaxed text-[var(--color-text-primary)] placeholder:font-sans placeholder:text-[var(--color-text-tertiary)] outline-none focus:border-[var(--color-accent)]"
              />
            </div>

            {/* Parsed task preview */}
            {parsedTasks.length > 0 && (
              <div className="mb-4">
                <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
                  {parsedTasks.length} task{parsedTasks.length !== 1 ? "s" : ""} to spawn
                </div>
                <div className="max-h-[160px] overflow-y-auto rounded-[6px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)]">
                  {parsedTasks.map((task, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-2.5 border-b border-[var(--color-border-subtle)] px-3 py-2 last:border-0"
                    >
                      <span
                        className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                          task.type === "issue"
                            ? "bg-[rgba(88,166,255,0.15)] text-[var(--color-accent)]"
                            : "bg-[rgba(163,113,247,0.15)] text-[var(--color-accent-violet)]"
                        }`}
                      >
                        {task.type === "issue" ? "issue" : "task"}
                      </span>
                      <span className="flex-1 truncate font-[var(--font-mono)] text-[10px] text-[var(--color-text-secondary)]">
                        {task.value}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="mb-4 rounded-[6px] border border-[rgba(248,81,73,0.3)] bg-[rgba(248,81,73,0.08)] px-3 py-2 text-[12px] text-[var(--color-status-error)]">
                {error}
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-2">
              <button
                onClick={onClose}
                className="rounded-[6px] border border-[var(--color-border-default)] px-4 py-2 text-[12px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-primary)]"
              >
                Cancel
              </button>
              <button
                onClick={handleSpawn}
                disabled={!canSpawn}
                className="rounded-[6px] bg-[var(--color-accent)] px-4 py-2 text-[12px] font-semibold text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {spawning
                  ? "Spawning…"
                  : parsedTasks.length > 0
                    ? `Spawn ${parsedTasks.length} session${parsedTasks.length !== 1 ? "s" : ""}`
                    : "Spawn sessions"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
