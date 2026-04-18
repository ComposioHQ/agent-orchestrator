"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useModal } from "@/hooks/useModal";
import { AddProjectModal } from "../AddProjectModal";
import { refreshProjectsView } from "@/lib/client-project-reload";

interface ProjectEntry {
  id: string;
  name: string;
  repo?: string;
  repoPath?: string;
  configPath?: string;
  defaultBranch?: string;
  sessionPrefix?: string;
  enabled: boolean;
  pinned: boolean;
  source: string;
  degraded?: boolean;
  degradedReason?: string;
}

interface ProjectSettingsProps {
  projects: ProjectEntry[];
}

export function ProjectSettings({ projects: initialProjects }: ProjectSettingsProps) {
  const router = useRouter();
  const [projects, setProjects] = useState(initialProjects);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [behaviorDraft, setBehaviorDraft] = useState({ repo: "", defaultBranch: "" });
  const [isSavingBehavior, setIsSavingBehavior] = useState(false);
  const addModal = useModal();

  const handleTogglePin = useCallback(async (id: string, pinned: boolean) => {
    const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned }),
    });
    if (res.ok) {
      setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, pinned } : p)));
      await refreshProjectsView(router);
    }
  }, [router]);

  const handleToggleEnabled = useCallback(async (id: string, enabled: boolean) => {
    const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (res.ok) {
      setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, enabled } : p)));
      await refreshProjectsView(router);
    }
  }, [router]);

  const handleRemove = useCallback(async (id: string, name: string) => {
    if (!confirm(`Remove "${name}" from portfolio? This won't delete the project.`)) return;
    const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) {
      setProjects((prev) => prev.filter((p) => p.id !== id));
      await refreshProjectsView(router);
    }
  }, [router]);

  const handleStartEdit = useCallback((project: ProjectEntry) => {
    setEditingProjectId(project.id);
    setBehaviorDraft({
      repo: project.repo ?? "",
      defaultBranch: project.defaultBranch ?? "",
    });
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingProjectId(null);
    setBehaviorDraft({ repo: "", defaultBranch: "" });
  }, []);

  const handleSaveBehavior = useCallback(async (id: string) => {
    setIsSavingBehavior(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: behaviorDraft.repo.trim(),
          defaultBranch: behaviorDraft.defaultBranch.trim(),
        }),
      });
      if (!res.ok) return;

      setProjects((prev) =>
        prev.map((project) =>
          project.id === id
            ? {
                ...project,
                repo: behaviorDraft.repo.trim() || undefined,
                defaultBranch: behaviorDraft.defaultBranch.trim() || undefined,
              }
            : project,
        ),
      );
      handleCancelEdit();
      await refreshProjectsView(router);
    } finally {
      setIsSavingBehavior(false);
    }
  }, [behaviorDraft.defaultBranch, behaviorDraft.repo, handleCancelEdit, router]);

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[17px] font-semibold text-[var(--color-text-primary)]">Projects & Repos</h1>
          <p className="mt-1 text-[14px] text-[var(--color-text-secondary)]">
            Manage which projects appear in your portfolio.
          </p>
        </div>
        <button
          type="button"
          onClick={addModal.open}
          className="bg-[var(--color-accent)] px-4 py-2 text-[12px] font-semibold text-[var(--color-text-inverse)] transition-colors hover:bg-[var(--color-accent-hover)]"
          style={{ borderRadius: "2px", minHeight: 44 }}
        >
          + Add Project
        </button>
      </div>

      {projects.length === 0 ? (
        <div className="rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-5 py-8 text-center">
          <p className="text-[14px] text-[var(--color-text-secondary)]">No projects registered yet.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {projects.map((project) => (
            <div
              key={project.id}
              className="rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-5 py-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-[14px] font-semibold text-[var(--color-text-primary)]">{project.name}</h3>
                    {project.pinned && (
                      <span className="text-[10px] font-medium text-[var(--color-accent)]">PINNED</span>
                    )}
                    {!project.enabled && (
                      <span className="text-[10px] font-medium text-[var(--color-text-tertiary)]">DISABLED</span>
                    )}
                    {project.degraded && (
                      <span className="text-[10px] font-medium text-[var(--color-status-error)]">DEGRADED</span>
                    )}
                  </div>
                  {project.repo && (
                    <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">{project.repo}</p>
                  )}
                  {project.repoPath && (
                    <p className="mt-1 truncate text-[12px] text-[var(--color-text-tertiary)]" style={{ fontFamily: "var(--font-mono)" }}>
                      {project.repoPath}
                    </p>
                  )}
                  {project.degradedReason && (
                    <p className="mt-2 text-[12px] text-[var(--color-status-error)]">{project.degradedReason}</p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-[var(--color-text-tertiary)]">
                    {project.defaultBranch && <span>Branch: {project.defaultBranch}</span>}
                    {project.sessionPrefix && <span>Prefix: {project.sessionPrefix}</span>}
                    <span>Source: {project.source}</span>
                  </div>
                  {editingProjectId === project.id && (
                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      <label className="block">
                        <span className="mb-1 block text-[11px] font-medium text-[var(--color-text-secondary)]">Repo</span>
                        <input
                          type="text"
                          value={behaviorDraft.repo}
                          onChange={(event) =>
                            setBehaviorDraft((prev) => ({ ...prev, repo: event.target.value }))
                          }
                          placeholder="owner/repo"
                          className="w-full border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2 text-[12px] text-[var(--color-text-primary)] outline-none transition-colors focus:border-[var(--color-accent)]"
                          style={{ borderRadius: "2px" }}
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[11px] font-medium text-[var(--color-text-secondary)]">Default Branch</span>
                        <input
                          type="text"
                          value={behaviorDraft.defaultBranch}
                          onChange={(event) =>
                            setBehaviorDraft((prev) => ({ ...prev, defaultBranch: event.target.value }))
                          }
                          placeholder="main"
                          className="w-full border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2 text-[12px] text-[var(--color-text-primary)] outline-none transition-colors focus:border-[var(--color-accent)]"
                          style={{ borderRadius: "2px" }}
                        />
                      </label>
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {editingProjectId === project.id ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void handleSaveBehavior(project.id)}
                        disabled={isSavingBehavior}
                        className="border border-[var(--color-accent)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-bg-elevated-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                        style={{ borderRadius: "2px" }}
                      >
                        {isSavingBehavior ? "Saving..." : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={handleCancelEdit}
                        disabled={isSavingBehavior}
                        className="border border-[var(--color-border-default)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-elevated-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                        style={{ borderRadius: "2px" }}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleStartEdit(project)}
                      className="border border-[var(--color-border-default)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-elevated-hover)]"
                      style={{ borderRadius: "2px" }}
                    >
                      Edit Behavior
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleTogglePin(project.id, !project.pinned)}
                    className="border border-[var(--color-border-default)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-elevated-hover)]"
                    style={{ borderRadius: "2px" }}
                  >
                    {project.pinned ? "Unpin" : "Pin"}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleToggleEnabled(project.id, !project.enabled)}
                    className="border border-[var(--color-border-default)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-elevated-hover)]"
                    style={{ borderRadius: "2px" }}
                  >
                    {project.enabled ? "Disable" : "Enable"}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemove(project.id, project.name)}
                    className="border border-[color-mix(in_srgb,var(--color-status-error)_25%,transparent)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-status-error)] transition-colors hover:bg-[var(--color-tint-red)]"
                    style={{ borderRadius: "2px" }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <AddProjectModal
        open={addModal.isOpen}
        onClose={addModal.close}
        onProjectAdded={() => {
          void refreshProjectsView(router);
        }}
      />
    </div>
  );
}
