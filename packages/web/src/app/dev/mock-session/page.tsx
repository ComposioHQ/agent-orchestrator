"use client";

import { Suspense, useMemo } from "react";
import { SessionDetail } from "@/components/SessionDetail";
import type { DashboardSession } from "@/lib/types";

export const dynamic = "force-dynamic";

function buildMockSession(): DashboardSession {
  const now = new Date().toISOString();
  return {
    id: "mock-session-001",
    projectId: "mock-project",
    status: "working",
    activity: "active",
    branch: "feat/mock-session-ui",
    issueId: "MOCK-42",
    issueUrl: "https://example.com/issues/MOCK-42",
    issueLabel: "MOCK-42",
    issueTitle: "Mock terminal and sidebar UX preview",
    summary: "This is a local mock page for UI development without backend sessions.",
    summaryIsFallback: false,
    createdAt: now,
    lastActivityAt: now,
    pr: null,
    metadata: {
      role: "agent",
      agent: "mock",
    },
  };
}

function MockSessionPageContent() {
  const mockSession = useMemo(() => buildMockSession(), []);

  return (
    <div className="min-h-screen bg-[var(--color-bg-base)]">
      <div className="mx-auto max-w-[1180px] px-5 py-4 lg:px-8">
        <div className="mb-3 border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-3 py-2 text-[12px] text-[var(--color-text-secondary)]">
          Mock mode: this page uses static session data and does not call `/api/sessions/[id]`.
        </div>
      </div>
      <SessionDetail session={mockSession} />
    </div>
  );
}

export default function MockSessionPage() {
  return (
    <Suspense
      fallback={<div className="flex min-h-screen items-center justify-center">Loading mock…</div>}
    >
      <MockSessionPageContent />
    </Suspense>
  );
}
