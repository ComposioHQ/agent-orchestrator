"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { type DashboardSession } from "@/lib/types";
import { WorkspaceLayout } from "@/components/workspace/WorkspaceLayout";
import { FileTree } from "@/components/workspace/FileTree";
import { FilePreview } from "@/components/workspace/FilePreview";
import { DirectTerminal } from "@/components/DirectTerminal";
import { isOrchestratorSession } from "@composio/ao-core/types";

export default function WorkspacePage() {
  const params = useParams();
  const id = params.id as string;

  const [session, setSession] = useState<DashboardSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSession = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
      if (res.status === 404) {
        setError("Session not found");
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
    const interval = setInterval(() => {
      fetchSession();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchSession]);

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}>
        <div style={{ color: "var(--color-text-secondary)", fontSize: "14px" }}>Loading workspace...</div>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}>
        <div style={{ color: "var(--color-status-error)", fontSize: "14px" }}>
          {error || "Session not found"}
        </div>
      </div>
    );
  }

  const isOrchestrator = isOrchestratorSession(session);

  return (
    <WorkspaceLayout session={session}>
      {{
        fileTree: (file) => (
          <FileTree
            sessionId={id}
            selectedFile={file}
          />
        ),
        preview: (file) => <FilePreview sessionId={id} selectedFile={file} />,
        terminal: (
          <DirectTerminal
            sessionId={id}
            variant={isOrchestrator ? "orchestrator" : "agent"}
            height="100%"
            headerLabel="TERMINAL"
            isOpenCodeSession={session.metadata["agent"] === "opencode"}
            reloadCommand={
              session.metadata["agent"] === "opencode" && session.metadata["opencodeSessionId"]
                ? `/exit\nopencode --session ${session.metadata["opencodeSessionId"]}\n`
                : undefined
            }
          />
        ),
      }}
    </WorkspaceLayout>
  );
}
