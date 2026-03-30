"use client";

import { useState, useCallback } from "react";
import { useModal } from "@/hooks/useModal";
import { AddProjectModal } from "../AddProjectModal";

interface ProjectEntry {
  id: string;
  name: string;
  repoPath?: string;
  configPath?: string;
  defaultBranch?: string;
  sessionPrefix?: string;
  enabled: boolean;
  pinned: boolean;
  source: string;
}

interface ProjectSettingsProps {
  projects: ProjectEntry[];
}

export function ProjectSettings({ projects: initialProjects }: ProjectSettingsProps) {
  const [projects, setProjects] = useState(initialProjects);
  const addModal = useModal();

  const handleTogglePin = useCallback(async (id: string, pinned: boolean) => {
    const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned }),
    });
    if (res.ok) {
      setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, pinned } : p)));
    }
  }, []);

  const handleToggleEnabled = useCallback(async (id: string, enabled: boolean) => {
    const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (res.ok) {
      setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, enabled } : p)));
    }
  }, []);

  const handleRemove = useCallback(async (id: string, name: string) => {
    if (!confirm(`Remove "${name}" from portfolio? This won't delete the project.`)) return;
    const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) {
      setProjects((prev) => prev.filter((p) => p.id !== id));
    }
  }, []);

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
                  </div>
                  {project.repoPath && (
                    <p className="mt-1 truncate text-[12px] text-[var(--color-text-tertiary)]" style={{ fontFamily: "var(--font-mono)" }}>
                      {project.repoPath}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-[var(--color-text-tertiary)]">
                    {project.defaultBranch && <span>Branch: {project.defaultBranch}</span>}
                    {project.sessionPrefix && <span>Prefix: {project.sessionPrefix}</span>}
                    <span>Source: {project.source}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
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
        onProjectAdded={() => window.location.reload()}
      />
    </div>
  );
}
