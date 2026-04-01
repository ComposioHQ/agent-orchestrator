"use client";

import { useState, useCallback, useEffect } from "react";
import { Modal } from "./Modal";

interface SubmitWorkModalProps {
  open: boolean;
  onClose: () => void;
  projects: Array<{ id: string; name: string }>;
  onSessionSpawned?: () => void;
}

export function SubmitWorkModal({ open, onClose, projects, onSessionSpawned }: SubmitWorkModalProps) {
  const [projectId, setProjectId] = useState("");
  const [issueId, setIssueId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset form when modal opens/closes
  useEffect(() => {
    if (!open) {
      setProjectId("");
      setIssueId("");
      setError(null);
      setSubmitting(false);
    } else if (projects.length === 1) {
      setProjectId(projects[0].id);
    }
  }, [open, projects]);

  const handleSubmit = useCallback(async () => {
    if (!projectId) {
      setError("Select a project");
      return;
    }

    setError(null);
    setSubmitting(true);

    try {
      const res = await fetch("/api/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          issueId: issueId.trim() || undefined,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Failed to spawn session (${res.status})`);
      }

      onSessionSpawned?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to spawn session");
    } finally {
      setSubmitting(false);
    }
  }, [projectId, issueId, onSessionSpawned, onClose]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Submit Work"
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="border border-[var(--color-border-default)] px-4 py-2 text-[12px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-elevated-hover)]"
            style={{ borderRadius: "2px", minHeight: 44 }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || !projectId}
            className="bg-[var(--color-accent)] px-4 py-2 text-[12px] font-semibold text-[var(--color-text-inverse)] transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
            style={{ borderRadius: "2px", minHeight: 44 }}
          >
            {submitting ? "Spawning..." : "Spawn Session"}
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {error && (
          <div className="text-[12px] text-[var(--color-status-error)]">{error}</div>
        )}

        <div>
          <label className="mb-1.5 block text-[12px] font-medium text-[var(--color-text-secondary)]">
            Project <span className="text-[var(--color-status-error)]">*</span>
          </label>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="w-full appearance-none border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-3 py-2 text-[13px] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
            style={{ height: 44, borderRadius: "2px" }}
          >
            <option value="">Select a project...</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1.5 block text-[12px] font-medium text-[var(--color-text-secondary)]">
            Issue ID or URL
          </label>
          <input
            type="text"
            value={issueId}
            onChange={(e) => setIssueId(e.target.value)}
            placeholder="INT-1234 or https://github.com/.../issues/42"
            className="w-full border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-3 py-2 text-[13px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-accent)] focus:outline-none"
            style={{
              fontFamily: "var(--font-mono)",
              height: 44,
              borderRadius: "2px",
            }}
          />
          <p className="mt-1.5 text-[11px] text-[var(--color-text-tertiary)]">
            GitHub issue, Linear ticket, or any issue tracker URL. Leave empty for manual work.
          </p>
        </div>
      </div>
    </Modal>
  );
}
