"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ToastProvider, useToast } from "@/components/Toast";

const IDENTITY_FIELD_TOOLTIP =
  "These describe which repo this is. Change them via `ao project relink`.";

interface ProjectSettingsFormProps {
  projectId: string;
  initialValues: {
    agent: string;
    runtime: string;
    trackerPlugin: string;
    scmPlugin: string;
    reactions: string;
    identity: {
      projectId: string;
      path: string;
      storageKey: string;
      repo: string;
      defaultBranch: string;
    };
  };
}

function ProjectSettingsFormInner({ projectId, initialValues }: ProjectSettingsFormProps) {
  const router = useRouter();
  const { showToast } = useToast();
  const [agent, setAgent] = useState(initialValues.agent);
  const [runtime, setRuntime] = useState(initialValues.runtime);
  const [trackerPlugin, setTrackerPlugin] = useState(initialValues.trackerPlugin);
  const [scmPlugin, setScmPlugin] = useState(initialValues.scmPlugin);
  const [reactions, setReactions] = useState(initialValues.reactions);
  const [submitting, setSubmitting] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);

  const behaviorPayload = useMemo(
    () => ({
      agent: agent.trim() || undefined,
      runtime: runtime.trim() || undefined,
      tracker: trackerPlugin.trim() ? { plugin: trackerPlugin.trim() } : undefined,
      scm: scmPlugin.trim() ? { plugin: scmPlugin.trim() } : undefined,
      reactions,
    }),
    [agent, runtime, trackerPlugin, scmPlugin, reactions],
  );

  const submit = async () => {
    setInlineError(null);
    setNetworkError(null);

    let parsedReactions: Record<string, unknown> | undefined;
    try {
      const trimmed = reactions.trim();
      parsedReactions = trimmed ? (JSON.parse(trimmed) as Record<string, unknown>) : undefined;
    } catch {
      setInlineError("Reactions must be valid JSON.");
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: behaviorPayload.agent,
          runtime: behaviorPayload.runtime,
          tracker: behaviorPayload.tracker,
          scm: behaviorPayload.scm,
          reactions: parsedReactions,
        }),
      });

      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        const errorMessage = body?.error ?? "Failed to save project settings.";
        if (response.status === 400) {
          setInlineError(errorMessage);
        } else {
          setNetworkError(errorMessage);
        }
        return;
      }

      showToast("Project settings updated.", "success");
      router.refresh();
    } catch {
      setNetworkError("Network error while saving project settings.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-8">
      <section className="rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
              Behavior
            </p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--color-text-primary)]">Runtime configuration</h2>
            <p className="mt-2 max-w-2xl text-sm text-[var(--color-text-secondary)]">
              These values change how AO runs this project without changing which repository the project points at.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting}
            className="rounded-lg border border-[var(--color-accent)] bg-[var(--color-tint-blue)] px-4 py-2 text-sm font-semibold text-[var(--color-accent)] transition-colors hover:bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? "Saving..." : "Save changes"}
          </button>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <EditableField
            id="agent"
            label="Agent"
            value={agent}
            onChange={setAgent}
            placeholder="claude-code"
          />
          <EditableField
            id="runtime"
            label="Runtime"
            value={runtime}
            onChange={setRuntime}
            placeholder="tmux"
          />
          <EditableField
            id="tracker-plugin"
            label="Tracker plugin"
            value={trackerPlugin}
            onChange={setTrackerPlugin}
            placeholder="github"
          />
          <EditableField
            id="scm-plugin"
            label="SCM plugin"
            value={scmPlugin}
            onChange={setScmPlugin}
            placeholder="github"
          />
        </div>

        <div className="mt-4">
          <label htmlFor="reactions" className="block text-sm font-medium text-[var(--color-text-primary)]">
            Reactions
          </label>
          <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">
            JSON object keyed by reaction name. This PATCH only sends behavior fields.
          </p>
          <textarea
            id="reactions"
            value={reactions}
            onChange={(event) => setReactions(event.target.value)}
            spellCheck={false}
            rows={12}
            className="mt-2 w-full rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-3 py-3 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
            style={{ fontFamily: "var(--font-mono)" }}
          />
        </div>

        {inlineError ? (
          <div
            role="alert"
            className="mt-4 rounded-xl border border-[color-mix(in_srgb,var(--color-status-error)_22%,transparent)] bg-[var(--color-tint-red)] px-4 py-3 text-sm text-[var(--color-status-error)]"
          >
            {inlineError}
          </div>
        ) : null}

        {networkError ? (
          <div className="mt-4 rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-4 py-3">
            <p className="text-sm text-[var(--color-status-error)]">{networkError}</p>
            <button
              type="button"
              onClick={() => void submit()}
              className="mt-3 rounded-lg border border-[var(--color-border-default)] px-3 py-1.5 text-sm font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-elevated-hover)]"
            >
              Retry
            </button>
          </div>
        ) : null}
      </section>

      <section className="rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-6 shadow-sm">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
          Identity
        </p>
        <h2 className="mt-2 text-xl font-semibold text-[var(--color-text-primary)]">Repository identity</h2>
        <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
          These fields are read-only because they define which repository AO considers this project to be.
        </p>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <ReadonlyField id="identity-project-id" label="Project ID" value={initialValues.identity.projectId} />
          <ReadonlyField id="identity-path" label="Path" value={initialValues.identity.path} />
          <ReadonlyField id="identity-storage-key" label="Storage key" value={initialValues.identity.storageKey} />
          <ReadonlyField id="identity-repo" label="Repo" value={initialValues.identity.repo} />
          <ReadonlyField
            id="identity-default-branch"
            label="Default branch"
            value={initialValues.identity.defaultBranch}
          />
        </div>
      </section>
    </div>
  );
}

function EditableField({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label htmlFor={id} className="block">
      <span className="block text-sm font-medium text-[var(--color-text-primary)]">{label}</span>
      <input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="mt-2 w-full rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
      />
    </label>
  );
}

function ReadonlyField({
  id,
  label,
  value,
}: {
  id: string;
  label: string;
  value: string;
}) {
  return (
    <label htmlFor={id} className="block">
      <span className="block text-sm font-medium text-[var(--color-text-primary)]">{label}</span>
      <input
        id={id}
        value={value}
        disabled
        readOnly
        title={IDENTITY_FIELD_TOOLTIP}
        aria-describedby={`${id}-tooltip`}
        className="mt-2 w-full cursor-not-allowed rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-canvas)] px-3 py-2 text-sm text-[var(--color-text-tertiary)]"
      />
      <span id={`${id}-tooltip`} className="mt-1 block text-xs text-[var(--color-text-tertiary)]">
        {IDENTITY_FIELD_TOOLTIP}
      </span>
    </label>
  );
}

export function ProjectSettingsForm(props: ProjectSettingsFormProps) {
  return (
    <ToastProvider>
      <ProjectSettingsFormInner {...props} />
    </ToastProvider>
  );
}
