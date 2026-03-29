"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { isOrchestratorSession } from "@composio/ao-core/types";
import { WorkspaceLayout } from "@/components/workspace/WorkspaceLayout";
import { FileTree } from "@/components/workspace/FileTree";
import { FilePreview } from "@/components/workspace/FilePreview";
import { DiffViewer } from "@/components/workspace/DiffViewer";
import { SessionTerminalTabs } from "@/components/SessionTerminalTabs";
import { type DashboardSession } from "@/lib/types";
import { activityIcon } from "@/lib/activity-icons";

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

function buildSessionTitle(session: DashboardSession): string {
  const id = session.id;
  const emoji = session.activity ? (activityIcon[session.activity] ?? "") : "";
  const isOrchestrator = isOrchestratorSession(session);

  let detail: string;
  if (isOrchestrator) {
    detail = "Orchestrator Terminal";
  } else if (session.pr) {
    detail = `#${session.pr.number} ${truncate(session.pr.branch, 30)}`;
  } else if (session.branch) {
    detail = truncate(session.branch, 30);
  } else {
    detail = "Session Detail";
  }

  return emoji ? `${emoji} ${id} | ${detail}` : `${id} | ${detail}`;
}

function createStubSession(id: string, projectId: string): DashboardSession {
  return {
    id,
    projectId,
    status: "working",
    activity: null,
    branch: null,
    issueId: null,
    issueUrl: null,
    issueLabel: null,
    issueTitle: null,
    summary: null,
    summaryIsFallback: false,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    pr: null,
    metadata: {},
  };
}

export default function SessionPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const id = params.id as string;
  const projectId = searchParams.get("project") ?? "";

  const [session, setSession] = useState<DashboardSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Stub session for immediate render
  const stubSession = createStubSession(id, projectId);
  const displaySession = session ?? stubSession;
  const sessionIsOrchestrator = session ? isOrchestratorSession(session) : false;

  useEffect(() => {
    if (session) {
      document.title = buildSessionTitle(session);
    } else {
      document.title = `${id} | Session`;
    }
  }, [session, id]);

  const fetchSession = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
      if (res.status === 404) {
        setError("Session not found");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as DashboardSession;
      setSession(data);
      setError(null);
    } catch (err) {
      console.error("Failed to fetch session:", err);
      setError("Failed to load session");
    }
  }, [id]);


  useEffect(() => {
    void fetchSession();
    const interval = setInterval(() => {
      void fetchSession();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchSession]);

  const isOpenCodeSession = session?.metadata["agent"] === "opencode";
  const reloadCommand =
    isOpenCodeSession && session?.metadata["opencodeSessionId"]
      ? `/exit\nopencode --session ${session.metadata["opencodeSessionId"]}\n`
      : undefined;

  return (
    <>
      <WorkspaceLayout session={displaySession}>
        {{
          fileTree: (file, { showChangedOnly, onFileSelected }) => (
            <FileTree
              sessionId={id}
              selectedFile={file}
              showChangedOnly={showChangedOnly}
              onFileSelected={onFileSelected}
            />
          ),
          preview: (file, { diffMode }) =>
            diffMode ? (
              <DiffViewer sessionId={id} selectedFile={file} />
            ) : (
              <FilePreview sessionId={id} selectedFile={file} />
            ),
          terminal: (
            <SessionTerminalTabs
              sessionId={id}
              variant={sessionIsOrchestrator ? "orchestrator" : "agent"}
              isOpenCodeSession={isOpenCodeSession}
              reloadCommand={reloadCommand}
            />
          ),
        }}
      </WorkspaceLayout>
      {error && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-[rgba(0,0,0,0.9)]">
          <div className="text-[13px] text-[var(--color-status-error)]">{error}</div>
          <a href="/" className="mt-4 text-[12px] text-[var(--color-accent)] hover:underline">
            ← Back to dashboard
          </a>
        </div>
      )}
    </>
  );
}
