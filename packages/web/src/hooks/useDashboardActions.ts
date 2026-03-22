"use client";

import { useState } from "react";
import type { DashboardOrchestratorLink } from "@/lib/types";
import type { ProjectInfo } from "@/lib/project-name";

export function useDashboardActions(
  setActiveOrchestrators: React.Dispatch<React.SetStateAction<DashboardOrchestratorLink[]>>,
) {
  const [spawningProjectIds, setSpawningProjectIds] = useState<string[]>([]);
  const [spawnErrors, setSpawnErrors] = useState<Record<string, string>>({});

  const handleSend = async (sessionId: string, message: string) => {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      console.error(`Failed to send message to ${sessionId}:`, await res.text());
    }
  };

  const handleKill = async (sessionId: string) => {
    if (!confirm(`Kill session ${sessionId}?`)) return;
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/kill`, {
      method: "POST",
    });
    if (!res.ok) {
      console.error(`Failed to kill ${sessionId}:`, await res.text());
    }
  };

  const handleMerge = async (prNumber: number) => {
    const res = await fetch(`/api/prs/${prNumber}/merge`, { method: "POST" });
    if (!res.ok) {
      console.error(`Failed to merge PR #${prNumber}:`, await res.text());
    }
  };

  const handleRestore = async (sessionId: string) => {
    if (!confirm(`Restore session ${sessionId}?`)) return;
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/restore`, {
      method: "POST",
    });
    if (!res.ok) {
      console.error(`Failed to restore ${sessionId}:`, await res.text());
    }
  };

  const handleSpawnOrchestrator = async (project: ProjectInfo) => {
    setSpawningProjectIds((current) =>
      current.includes(project.id) ? current : [...current, project.id],
    );
    setSpawnErrors(({ [project.id]: _ignored, ...current }) => current);

    try {
      const res = await fetch("/api/orchestrators", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });

      const data = (await res.json().catch(() => null)) as {
        orchestrator?: DashboardOrchestratorLink;
        error?: string;
      } | null;

      if (!res.ok || !data?.orchestrator) {
        throw new Error(data?.error ?? `Failed to spawn orchestrator for ${project.name}`);
      }

      const orchestrator = data.orchestrator;

      setActiveOrchestrators((current) => {
        const next = current.filter((o) => o.projectId !== project.id);
        next.push(orchestrator);
        return next;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to spawn orchestrator";
      setSpawnErrors((current) => ({ ...current, [project.id]: message }));
      console.error(`Failed to spawn orchestrator for ${project.id}:`, error);
    } finally {
      setSpawningProjectIds((current) => current.filter((id) => id !== project.id));
    }
  };

  return {
    spawningProjectIds,
    spawnErrors,
    handleSend,
    handleKill,
    handleMerge,
    handleRestore,
    handleSpawnOrchestrator,
  };
}
