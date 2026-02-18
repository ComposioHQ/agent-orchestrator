"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { SessionDetail } from "@/components/SessionDetail";
import type { DashboardSession } from "@/lib/types";

/** Build a descriptive tab title from session data. */
function buildSessionTitle(session: DashboardSession): string {
  const id = session.id;

  if (session.pr) {
    const prNum = `#${session.pr.number}`;
    const branch = session.pr.branch;
    // Truncate branch to keep title readable
    const maxBranch = 30;
    const truncated = branch.length > maxBranch ? branch.slice(0, maxBranch) + "..." : branch;
    return `${id} | ${prNum} ${truncated}`;
  }

  if (session.branch) {
    const maxBranch = 30;
    const truncated =
      session.branch.length > maxBranch
        ? session.branch.slice(0, maxBranch) + "..."
        : session.branch;
    return `${id} | ${truncated}`;
  }

  return `${id} | Session Detail`;
}

export default function SessionPage() {
  const params = useParams();
  const id = params.id as string;

  const [session, setSession] = useState<DashboardSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Update document title based on session data
  useEffect(() => {
    if (session) {
      document.title = buildSessionTitle(session);
    } else {
      document.title = `${id} | Session Detail`;
    }
  }, [session, id]);

  // Fetch session data (memoized to avoid recreating on every render)
  const fetchSession = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
      if (res.status === 404) {
        setError("Session not found");
        setLoading(false);
        return;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as DashboardSession;
      setSession(data);
      setError(null);
    } catch (err) {
      console.error("Failed to fetch session:", err);
      setError("Failed to load session");
    } finally {
      setLoading(false);
    }
  }, [id]);

  // Initial fetch
  useEffect(() => {
    fetchSession();
  }, [fetchSession]);

  // Poll for updates every 5 seconds
  useEffect(() => {
    const interval = setInterval(fetchSession, 5000);
    return () => clearInterval(interval);
  }, [fetchSession]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-sm text-[var(--color-text-muted)]">Loading session...</div>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-sm text-[var(--color-accent-red)]">{error || "Session not found"}</div>
      </div>
    );
  }

  return <SessionDetail session={session} />;
}
