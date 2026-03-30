"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "./Modal";

type QuickStartTemplate = "empty" | "nextjs";

interface QuickStartModalProps {
  open: boolean;
  onClose: () => void;
  defaultLocation: string;
  onProjectCreated: (projectId: string) => void;
}

const TEMPLATE_OPTIONS: Array<{
  id: QuickStartTemplate;
  title: string;
  subtitle: string;
  badge?: string;
}> = [
  { id: "empty", title: "Empty", subtitle: "Start from scratch" },
  { id: "nextjs", title: "Next.js", subtitle: "TS, App Router", badge: "Default" },
];

export function QuickStartModal({
  open,
  onClose,
  defaultLocation,
  onProjectCreated,
}: QuickStartModalProps) {
  const [name, setName] = useState("");
  const [location, setLocation] = useState(defaultLocation);
  const [template, setTemplate] = useState<QuickStartTemplate>("nextjs");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) {
      setName("");
      setLocation(defaultLocation);
      setTemplate("nextjs");
      setError(null);
      setCreating(false);
    }
  }, [defaultLocation, open]);

  const disabled = useMemo(() => !name.trim() || !location.trim() || creating, [creating, location, name]);

  async function handleCreate() {
    if (disabled) return;
    setError(null);
    setCreating(true);

    try {
      const res = await fetch("/api/projects/quick-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          location: location.trim(),
          template,
        }),
      });

      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error || "Failed to create project");
      }

      const projectId = body?.project?.id;
      if (!projectId) {
        throw new Error("Project created but no project id was returned");
      }

      onProjectCreated(projectId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Quick start"
      size="lg"
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="text-[12px] text-[var(--color-text-tertiary)]">
            {creating ? "Creating project..." : "A local folder and git repo will be created for you."}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-[4px] border border-[var(--color-border-default)] px-4 py-2 text-[12px] font-medium text-[var(--color-text-secondary)]"
              style={{ minHeight: 44 }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleCreate}
              disabled={disabled}
              className="rounded-[4px] bg-[var(--color-accent)] px-4 py-2 text-[12px] font-semibold text-[var(--color-text-inverse)] disabled:opacity-50"
              style={{ minHeight: 44 }}
            >
              {creating ? "Creating..." : "Create project"}
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        <p className="text-[14px] leading-6 text-[var(--color-text-secondary)]">
          Create a new local project and register it directly into Agent Orchestrator.
        </p>

        {error ? <div className="text-[12px] text-[var(--color-status-error)]">{error}</div> : null}

        <div>
          <label className="mb-2 block text-[13px] font-medium text-[var(--color-text-primary)]">
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="test"
            className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2 text-[14px] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
            style={{ minHeight: 44 }}
          />
        </div>

        <div>
          <label className="mb-2 block text-[13px] font-medium text-[var(--color-text-primary)]">
            Location
          </label>
          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2 text-[14px] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
            style={{ minHeight: 44, fontFamily: "var(--font-mono)" }}
          />
        </div>

        <div>
          <label className="mb-2 block text-[13px] font-medium text-[var(--color-text-primary)]">
            Template
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            {TEMPLATE_OPTIONS.map((option) => {
              const active = option.id === template;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setTemplate(option.id)}
                  className="relative rounded-[2px] border px-4 py-4 text-left transition-colors"
                  style={{
                    minHeight: 136,
                    borderColor: active ? "var(--color-accent)" : "var(--color-border-subtle)",
                    background: active ? "var(--color-accent-subtle)" : "var(--color-bg-base)",
                  }}
                >
                  {option.badge ? (
                    <span className="absolute right-3 top-3 rounded-full border border-[var(--color-border-subtle)] px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                      {option.badge}
                    </span>
                  ) : null}
                  <div className="flex h-10 w-10 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] text-[var(--color-text-secondary)]">
                    {option.id === "nextjs" ? <NextIcon /> : <EmptyIcon />}
                  </div>
                  <div className="mt-8 text-[var(--font-size-xl)] font-medium tracking-[-0.025em] text-[var(--color-text-primary)]">
                    {option.title}
                  </div>
                  <div className="mt-1 text-[13px] text-[var(--color-text-secondary)]">
                    {option.subtitle}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function EmptyIcon() {
  return (
    <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" viewBox="0 0 24 24">
      <path d="M7.75 4.75h8.5a2 2 0 0 1 2 2v10.5a2 2 0 0 1-2 2h-8.5a2 2 0 0 1-2-2V6.75a2 2 0 0 1 2-2Z" />
      <path d="M9.5 9.5h5M9.5 13.5h5" />
    </svg>
  );
}

function NextIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2.75a9.25 9.25 0 1 0 0 18.5 9.25 9.25 0 0 0 0-18.5Zm3.86 13.81h-1.54L8.8 8.72v7.84H7.25V6.98h1.84l5.23 7.42V6.98h1.54v9.58Z" />
    </svg>
  );
}
