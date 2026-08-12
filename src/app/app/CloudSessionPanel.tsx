"use client";

import type {
  ClientEvent,
  Session,
  WorkspaceEntry,
  WorkspaceFile,
} from "@aoagents/cloud-client";
import { ChevronLeft, FileText, MessageSquare, Send, Terminal, X } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import { browserCloudClient, newIdempotencyKey } from "@/lib/cloud-client";
import { CloudTerminal } from "./CloudTerminal";

type PanelTab = "chat" | "files" | "terminal";

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
  const [tab, setTab] = useState<PanelTab>("chat");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [directory, setDirectory] = useState("");
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<WorkspaceFile | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [filesBusy, setFilesBusy] = useState(false);

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

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending || !session.runtimeConnected || session.isTerminated) {
      return;
    }
    setSending(true);
    setError("");
    try {
      await client.sendMessage(organizationId, session.id, text, {
        idempotencyKey: newIdempotencyKey("message"),
      });
      setDraft("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send message.");
    } finally {
      setSending(false);
    }
  };

  const loadDirectory = async (path: string) => {
    setFilesBusy(true);
    setError("");
    try {
      const page = await client.listWorkspaceFiles(
        organizationId,
        session.id,
        path,
        { limit: 100 },
      );
      setDirectory(page.path);
      setEntries(page.items);
      setSelectedFile(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load files.");
    } finally {
      setFilesBusy(false);
    }
  };

  const openFile = async (path: string) => {
    setFilesBusy(true);
    setError("");
    try {
      const file = await client.readWorkspaceFile(
        organizationId,
        session.id,
        path,
      );
      setSelectedFile(file);
      setFileContent(file.content);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read file.");
    } finally {
      setFilesBusy(false);
    }
  };

  const saveFile = async () => {
    if (!selectedFile || session.mode === "read-only") return;
    setFilesBusy(true);
    setError("");
    try {
      const file = await client.writeWorkspaceFile(
        organizationId,
        session.id,
        { path: selectedFile.path, content: fileContent },
      );
      setSelectedFile(file);
      setFileContent(file.content);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save file.");
    } finally {
      setFilesBusy(false);
    }
  };

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

      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--color-border-strong)] px-3">
        <TabButton active={tab === "chat"} label="Chat" onClick={() => setTab("chat")}>
          <MessageSquare className="size-3.5" />
        </TabButton>
        <TabButton
          active={tab === "files"}
          disabled={!session.runtimeConnected}
          label="Files"
          onClick={() => {
            setTab("files");
            if (entries.length === 0) void loadDirectory("");
          }}
        >
          <FileText className="size-3.5" />
        </TabButton>
        <TabButton
          active={tab === "terminal"}
          disabled={!session.runtimeConnected || session.mode !== "trusted"}
          label="Terminal"
          onClick={() => setTab("terminal")}
        >
          <Terminal className="size-3.5" />
        </TabButton>
      </div>

      {tab === "chat" ? (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {events.length === 0 ? (
            <div className="rounded-lg border border-dashed border-white/10 p-4 text-xs leading-5 text-[var(--color-text-passive)]">
              No messages yet.
            </div>
          ) : null}
          {events.map((event) => (
            <EventView event={event} key={event.sequence} />
          ))}
        </div>
      ) : tab === "files" ? (
        <FileBrowser
          busy={filesBusy}
          content={fileContent}
          directory={directory}
          entries={entries}
          file={selectedFile}
          onBack={() => {
            if (selectedFile) {
              setSelectedFile(null);
              return;
            }
            const parent = directory.split("/").slice(0, -1).join("/");
            void loadDirectory(parent);
          }}
          onChange={setFileContent}
          onOpen={(entry) =>
            entry.isDir ? void loadDirectory(entry.path) : void openFile(entry.path)
          }
          onSave={() => void saveFile()}
          readOnly={session.mode === "read-only"}
        />
      ) : (
        <CloudTerminal
          organizationId={organizationId}
          sessionId={session.id}
        />
      )}

      <div className="border-t border-[var(--color-border-strong)] p-3">
        {error ? (
          <p className="mb-2 text-[11px] text-[var(--color-error)]" role="alert">
            {error}
          </p>
        ) : null}
        {tab === "chat" ? (
          <form className="flex items-end gap-2" onSubmit={sendMessage}>
            <textarea
              aria-label="Message"
              className="min-h-10 flex-1 resize-none rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] px-3 py-2 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!session.runtimeConnected || session.isTerminated}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={
                session.runtimeConnected
                  ? "Send another turn…"
                  : "Worker is not connected"
              }
              rows={2}
              value={draft}
            />
            <button
              aria-label="Send message"
              className="grid size-10 place-items-center rounded-md bg-[var(--color-accent-strong)] text-[var(--color-accent-foreground)] disabled:cursor-not-allowed disabled:opacity-40"
              disabled={
                !draft.trim() ||
                sending ||
                !session.runtimeConnected ||
                session.isTerminated
              }
              type="submit"
            >
              <Send className="size-4" />
            </button>
          </form>
        ) : tab === "files" ? (
          <p className="text-[10px] text-[var(--color-text-passive)]">
            Files are read from the connected worker workspace.
          </p>
        ) : (
          <p className="font-mono text-[10px] text-[var(--color-text-passive)]">
            /workspace/repository · trusted session
          </p>
        )}
      </div>
    </aside>
  );
}

function TabButton({
  active,
  children,
  disabled = false,
  label,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? "bg-[var(--color-interactive-hover)] text-[var(--foreground)]"
          : "text-[var(--color-text-passive)]"
      }`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
      {label}
    </button>
  );
}

function FileBrowser({
  busy,
  content,
  directory,
  entries,
  file,
  onBack,
  onChange,
  onOpen,
  onSave,
  readOnly,
}: {
  busy: boolean;
  content: string;
  directory: string;
  entries: WorkspaceEntry[];
  file: WorkspaceFile | null;
  onBack: () => void;
  onChange: (content: string) => void;
  onOpen: (entry: WorkspaceEntry) => void;
  onSave: () => void;
  readOnly: boolean;
}) {
  if (file) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-9 items-center gap-2 border-b border-[var(--color-border-strong)] px-3">
          <button aria-label="Back to files" onClick={onBack} type="button">
            <ChevronLeft className="size-4 text-[var(--color-text-passive)]" />
          </button>
          <span className="min-w-0 flex-1 truncate font-mono text-[10px]">
            {file.path}
          </span>
          <button
            className="rounded bg-[var(--color-accent-strong)] px-2 py-1 text-[10px] text-[var(--color-accent-foreground)] disabled:opacity-40"
            disabled={busy || readOnly || content === file.content}
            onClick={onSave}
            type="button"
          >
            Save
          </button>
        </div>
        <textarea
          aria-label={`Edit ${file.path}`}
          className="min-h-0 flex-1 resize-none bg-[var(--color-bg-secondary)] p-3 font-mono text-xs leading-5 outline-none"
          onChange={(event) => onChange(event.target.value)}
          readOnly={readOnly}
          value={content}
        />
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      {directory ? (
        <button
          className="mb-1 flex h-8 w-full items-center gap-2 rounded px-2 text-left text-xs text-[var(--color-text-passive)] hover:bg-[var(--color-interactive-hover)]"
          onClick={onBack}
          type="button"
        >
          <ChevronLeft className="size-3.5" /> ..
        </button>
      ) : null}
      {busy ? (
        <p className="p-3 text-xs text-[var(--color-text-passive)]">Loading files…</p>
      ) : null}
      {!busy && entries.length === 0 ? (
        <p className="p-3 text-xs text-[var(--color-text-passive)]">No files found.</p>
      ) : null}
      {entries.map((entry) => (
        <button
          className="flex h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-[var(--color-interactive-hover)]"
          key={entry.path}
          onClick={() => onOpen(entry)}
          type="button"
        >
          <FileText className="size-3.5 text-[var(--color-text-passive)]" />
          <span className="min-w-0 flex-1 truncate text-xs">{entry.name}</span>
          <span className="font-mono text-[9px] text-[var(--color-text-passive)]">
            {entry.isDir ? "dir" : entry.size}
          </span>
        </button>
      ))}
    </div>
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
