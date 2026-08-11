"use client";

import type { ClientEvent, Session } from "@aoagents/cloud-client";
import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { browserCloudClient } from "@/lib/cloud-client";

export function CloudSessionPanel({
  onClose,
  organizationId,
  session,
}: {
  onClose: () => void;
  organizationId: string;
  session: Session;
}) {
  const client = useMemo(browserCloudClient, []);
  const [events, setEvents] = useState<ClientEvent[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    const load = async () => {
      try {
        const replay = await client.replayEvents(
          organizationId,
          session.id,
          { signal: controller.signal },
        );
        if (!active) return;
        setEvents(replay.events);
        for await (const event of client.streamEvents(
          organizationId,
          session.id,
          { after: replay.nextAfter, signal: controller.signal },
        )) {
          if (!active) break;
          setEvents((current) =>
            current.some(({ sequence }) => sequence === event.sequence)
              ? current
              : [...current, event],
          );
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof Error ? cause.message : "Could not load chat.",
          );
        }
      }
    };

    void load();
    return () => {
      active = false;
      controller.abort();
    };
  }, [client, organizationId, session.id]);

  return (
    <aside className="absolute inset-y-0 right-0 z-30 flex w-[min(430px,calc(100%-2rem))] flex-col border-l border-[var(--color-border-strong)] bg-[var(--color-bg-primary)] shadow-[-18px_0_48px_rgba(0,0,0,0.28)]">
      <header className="flex min-h-14 items-start gap-3 border-b border-[var(--color-border-strong)] px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-[var(--foreground)]">
            {session.displayName}
          </h2>
          <p className="mt-1 truncate font-mono text-[10px] text-[var(--color-text-passive)]">
            {session.branch} · {session.mode}
          </p>
        </div>
        <button
          aria-label="Close session"
          className="grid size-7 place-items-center rounded-md text-[var(--color-text-passive)] hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)]"
          onClick={onClose}
          type="button"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {events.length === 0 ? (
          <div className="rounded-lg border border-dashed border-white/10 p-4 text-xs leading-5 text-[var(--color-text-passive)]">
            No messages yet. Messages are stored and replayed durably even
            though no worker is connected.
          </div>
        ) : null}
        {events.map((event) => (
          <EventView event={event} key={event.sequence} />
        ))}
      </div>

      <div className="border-t border-[var(--color-border-strong)] p-3">
        {error ? (
          <p className="mb-2 text-[11px] text-[var(--color-error)]" role="alert">
            {error}
          </p>
        ) : null}
        <div className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] px-3 py-2 text-[11px] leading-5 text-[var(--color-text-passive)]">
          Chat history and live replay are available. Sending another turn stays
          disabled until worker execution is implemented.
        </div>
      </div>
    </aside>
  );
}

function EventView({ event }: { event: ClientEvent }) {
  const text =
    "text" in event.payload
      ? event.payload.text
      : "error" in event.payload && event.payload.error
        ? event.payload.error
        : event.type.replace("chat.", "").replaceAll("_", " ");
  const user = event.type === "chat.user_message";
  return (
    <div className={`flex ${user ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[88%] rounded-lg px-3 py-2 text-sm leading-5 ${
          user
            ? "bg-[#4d8dff] text-white"
            : "border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] text-[var(--foreground)]"
        }`}
      >
        {text}
        <div
          className={`mt-1 font-mono text-[9px] ${
            user ? "text-white/60" : "text-[var(--color-text-passive)]"
          }`}
        >
          #{event.sequence}
        </div>
      </div>
    </div>
  );
}
