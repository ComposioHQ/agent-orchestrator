"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "./Modal";

interface CloneFromUrlModalProps {
  open: boolean;
  onClose: () => void;
  defaultLocation: string;
  onProjectCreated: (projectId: string) => void;
}

export function CloneFromUrlModal({
  open,
  onClose,
  defaultLocation,
  onProjectCreated,
}: CloneFromUrlModalProps) {
  const [url, setUrl] = useState("");
  const [location, setLocation] = useState(defaultLocation);
  const [error, setError] = useState<string | null>(null);
  const [cloning, setCloning] = useState(false);

  useEffect(() => {
    if (!open) {
      setUrl("");
      setLocation(defaultLocation);
      setError(null);
      setCloning(false);
    }
  }, [defaultLocation, open]);

  const disabled = useMemo(() => !url.trim() || !location.trim() || cloning, [cloning, location, url]);

  async function handleClone() {
    if (disabled) return;
    setError(null);
    setCloning(true);

    try {
      const res = await fetch("/api/projects/clone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          location: location.trim(),
        }),
      });

      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error || "Failed to clone repository");
      }

      const projectId = body?.project?.id;
      if (!projectId) {
        throw new Error("Repository cloned but no project id was returned");
      }

      onProjectCreated(projectId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clone repository");
    } finally {
      setCloning(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Clone from URL"
      size="lg"
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="text-[12px] text-[var(--color-text-tertiary)]">
            {cloning ? "Cloning repository..." : "Clone a git repository and register it into Agent Orchestrator."}
          </div>
          <button
            type="button"
            onClick={handleClone}
            disabled={disabled}
            className="rounded-[var(--radius-sm)] bg-[var(--color-accent)] px-5 py-2 text-[12px] font-semibold text-[var(--color-text-inverse)] disabled:opacity-50"
            style={{ minHeight: 44 }}
          >
            {cloning ? "Cloning..." : "Clone repository"}
          </button>
        </div>
      }
    >
      <div className="space-y-6">
        {error ? <div className="text-[12px] text-[var(--color-status-error)]">{error}</div> : null}

        <div>
          <label className="mb-2 block text-[13px] font-medium text-[var(--color-text-primary)]">
            Git URL
          </label>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/user/repo.git"
            className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2 text-[14px] text-[var(--color-text-primary)] focus:border-[var(--color-status-error)] focus:outline-none"
            style={{ minHeight: 44 }}
          />
        </div>

        <div>
          <label className="mb-2 block text-[13px] font-medium text-[var(--color-text-primary)]">
            Clone location
          </label>
          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2 text-[14px] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
            style={{ minHeight: 44, fontFamily: "var(--font-mono)" }}
          />
        </div>
      </div>
    </Modal>
  );
}
