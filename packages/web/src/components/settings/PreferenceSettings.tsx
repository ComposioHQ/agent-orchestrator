"use client";

import { useState, useCallback } from "react";

interface PreferenceSettingsProps {
  projects: Array<{ id: string; name: string }>;
  initialOrder: string[];
  initialDefaultProject: string;
}

export function PreferenceSettings({
  projects,
  initialOrder,
  initialDefaultProject,
}: PreferenceSettingsProps) {
  const [order, setOrder] = useState(initialOrder);
  const [defaultProject, setDefaultProject] = useState(initialDefaultProject);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const moveUp = useCallback((index: number) => {
    if (index === 0) return;
    setOrder((prev) => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
    setSaved(false);
  }, []);

  const moveDown = useCallback((index: number) => {
    setOrder((prev) => {
      if (index >= prev.length - 1) return prev;
      const next = [...prev];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      return next;
    });
    setSaved(false);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectOrder: order,
          defaultProject: defaultProject || undefined,
        }),
      });
      if (res.ok) setSaved(true);
    } finally {
      setSaving(false);
    }
  }, [order, defaultProject]);

  const projectNameMap = new Map(projects.map((p) => [p.id, p.name]));

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-[17px] font-semibold text-[var(--color-text-primary)]">Preferences</h1>
        <p className="mt-1 text-[14px] text-[var(--color-text-secondary)]">
          Customize how your portfolio is displayed.
        </p>
      </div>

      {/* Project ordering */}
      <section className="mb-6 rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-5 py-4">
        <h2 className="text-[14px] font-semibold text-[var(--color-text-primary)]">Project Order</h2>
        <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
          Drag or use arrows to reorder projects in the sidebar and portfolio.
        </p>
        <div className="mt-3 space-y-1">
          {order.map((id, index) => (
            <div
              key={id}
              className="flex items-center gap-2 border border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] px-3 py-2"
              style={{ borderRadius: "2px" }}
            >
              <span className="flex-1 text-[13px] text-[var(--color-text-primary)]">
                {projectNameMap.get(id) ?? id}
              </span>
              <button
                type="button"
                onClick={() => moveUp(index)}
                disabled={index === 0}
                className="p-1 text-[var(--color-text-tertiary)] disabled:opacity-30"
                aria-label="Move up"
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="m18 15-6-6-6 6" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => moveDown(index)}
                disabled={index === order.length - 1}
                className="p-1 text-[var(--color-text-tertiary)] disabled:opacity-30"
                aria-label="Move down"
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Default project */}
      <section className="mb-6 rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-5 py-4">
        <h2 className="text-[14px] font-semibold text-[var(--color-text-primary)]">Default Project</h2>
        <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
          The project selected by default when spawning new sessions.
        </p>
        <select
          value={defaultProject}
          onChange={(e) => { setDefaultProject(e.target.value); setSaved(false); }}
          className="mt-3 w-full appearance-none border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-3 py-2 text-[13px] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
          style={{ height: 44, borderRadius: "2px" }}
        >
          <option value="">None</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </section>

      {/* Save */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="bg-[var(--color-accent)] px-4 py-2 text-[12px] font-semibold text-[var(--color-text-inverse)] transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
          style={{ borderRadius: "2px", minHeight: 44 }}
        >
          {saving ? "Saving..." : "Save Preferences"}
        </button>
        {saved && <span className="text-[12px] text-[var(--color-status-ready)]">Saved</span>}
      </div>
    </div>
  );
}
