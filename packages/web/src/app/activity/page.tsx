"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { AgentMap } from "@/components/activity/AgentMap";
import { BranchTimeline } from "@/components/activity/BranchTimeline";
import { ActivityFeed } from "@/components/activity/ActivityFeed";
import type { ActivityEvent, SessionGitActivity } from "@/lib/git-activity";

interface SessionSnapshot {
  id: string;
  branch: string | null;
  status: string;
  activity: string;
  pr: {
    number: number;
    url: string;
    state: string;
    ciStatus: string;
  } | null;
}

interface ActivityState {
  sessions: SessionSnapshot[];
  gitActivity: Record<string, SessionGitActivity>;
  events: ActivityEvent[];
}

export default function ActivityPage() {
  const [state, setState] = useState<ActivityState>({
    sessions: [],
    gitActivity: {},
    events: [],
  });
  const [connected, setConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  const connectToSSE = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = new EventSource("/api/activity");
    eventSourceRef.current = es;

    es.onopen = () => {
      setConnected(true);
    };

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === "snapshot") {
          setState((prev) => ({
            ...prev,
            sessions: data.sessions,
            gitActivity: data.gitActivity ?? {},
          }));
        } else if (data.type === "activity") {
          setState((prev) => ({
            ...prev,
            events: [data.event, ...prev.events].slice(0, 100), // Keep last 100 events
          }));
        } else if (data.type === "state_update") {
          setState((prev) => ({
            ...prev,
            sessions: data.sessions,
            gitActivity: {
              ...prev.gitActivity,
              ...data.gitActivity,
            },
          }));
        }
      } catch {
        // Ignore parse errors
      }
    };

    es.onerror = () => {
      setConnected(false);
      es.close();
      // Reconnect after 3 seconds
      setTimeout(connectToSSE, 3000);
    };
  }, []);

  useEffect(() => {
    connectToSSE();
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, [connectToSSE]);

  return (
    <div className="flex h-screen flex-col bg-[var(--color-bg-primary)]">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-[var(--color-border-default)] px-6 py-4">
        <div className="flex items-center gap-4">
          <a
            href="/"
            className="text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 19l-7-7m0 0l7-7m-7 7h18"
              />
            </svg>
          </a>
          <h1 className="text-lg font-semibold tracking-tight">
            <span className="text-[#7c8aff]">Mission</span> Control
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${connected ? "bg-[var(--color-accent-green)]" : "bg-[var(--color-accent-red)]"}`}
            />
            <span className="text-xs text-[var(--color-text-muted)]">
              {connected ? "Live" : "Reconnecting..."}
            </span>
          </div>
          <span className="text-xs text-[var(--color-text-muted)]">
            {state.sessions.length} agent{state.sessions.length !== 1 ? "s" : ""} active
          </span>
        </div>
      </header>

      {/* Main content — three-panel layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel — Agent Map (Gource-inspired visualization) */}
        <div className="w-[380px] border-r border-[var(--color-border-default)] p-4">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Agent Map
          </h2>
          <AgentMap
            sessions={state.sessions}
            gitActivity={state.gitActivity}
            events={state.events}
          />
        </div>

        {/* Center panel — Branch Timeline */}
        <div className="flex-1 overflow-auto border-r border-[var(--color-border-default)] p-4">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Branch Timeline
          </h2>
          <BranchTimeline sessions={state.sessions} gitActivity={state.gitActivity} />
        </div>

        {/* Right panel — Activity Feed */}
        <div className="flex w-[360px] flex-col p-4">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Live Activity
          </h2>
          <ActivityFeed events={state.events} sessions={state.sessions} />
        </div>
      </div>
    </div>
  );
}
