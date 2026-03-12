"use client";

import { useState } from "react";
import { type DashboardSession, getAttentionLevel, isPRRateLimited } from "@/lib/types";

interface QuickCommandDeckProps {
  session: DashboardSession;
}

interface Preset {
  id: string;
  label: string;
  message: string;
}

export function QuickCommandDeck({ session }: QuickCommandDeckProps) {
  const [status, setStatus] = useState<string | null>(null);

  const presets = buildPresets(session);

  const sendPreset = async (preset: Preset) => {
    setStatus(`sending:${preset.id}`);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: preset.message }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus(`sent:${preset.id}`);
    } catch {
      setStatus(`error:${preset.id}`);
    }
  };

  return (
    <section className="mb-6 rounded-[8px] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-4">
      <div className="mb-3">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
          Quick Commands
        </h2>
        <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
          Prebuilt operator prompts for common interventions.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {presets.map((preset) => {
          const isPending = status === `sending:${preset.id}`;
          const isSent = status === `sent:${preset.id}`;
          const isError = status === `error:${preset.id}`;
          return (
            <button
              key={preset.id}
              onClick={() => void sendPreset(preset)}
              disabled={isPending}
              className="rounded-[6px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)] px-3 py-2 text-left transition-colors hover:border-[var(--color-accent)]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-semibold text-[var(--color-text-primary)]">{preset.label}</span>
                <span className="text-[10px] text-[var(--color-text-tertiary)]">
                  {isPending ? "sending..." : isSent ? "sent" : isError ? "error" : "ready"}
                </span>
              </div>
              <p className="mt-1 line-clamp-2 text-[11px] text-[var(--color-text-secondary)]">{preset.message}</p>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function buildPresets(session: DashboardSession): Preset[] {
  const pr = session.pr;
  const prUrl = pr?.url ?? "this session";
  const level = getAttentionLevel(session);
  const presets: Preset[] = [
    {
      id: "summarize",
      label: "Summarize State",
      message: `Summarize the current state of ${prUrl} in three bullets: blocker, next action, confidence.`,
    },
  ];

  if (level === "respond") {
    presets.push({
      id: "unblock",
      label: "Unblock Session",
      message: `You are blocked on ${prUrl}. State the blocker in one sentence, choose the next smallest unblock, and continue only on that unblock.`,
    });
  }

  if (pr && !isPRRateLimited(pr) && pr.ciStatus === "failing") {
    presets.push({
      id: "fix-ci",
      label: "Fix Failing CI",
      message: `Inspect the failing CI on ${prUrl}, choose the single highest-signal failing check, fix only that failure, then report what changed.`,
    });
  } else {
    presets.push({
      id: "fix-one",
      label: "Fix Highest Blocker",
      message: `Pick the single highest-value blocker on ${prUrl}, fix only that blocker, and report the result.`,
    });
  }

  if (pr) {
    presets.push({
      id: "post-review",
      label: "Prepare Review",
      message: `Prepare ${prUrl} for review. If it is not ready, state the one thing still missing.`,
    });
  }

  if (pr && !isPRRateLimited(pr) && !pr.mergeability.noConflicts) {
    presets.push({
      id: "rebase",
      label: "Resolve Conflicts",
      message: `Rebase your branch for ${prUrl}, resolve only the merge conflicts, rerun the minimum relevant checks, and report any remaining blocker.`,
    });
  } else {
    presets.push({
      id: "rebase",
      label: "Rebase and Recheck",
      message: `Rebase your branch on the default branch, rerun the relevant checks, and report any new blocker.`,
    });
  }

  return presets;
}
