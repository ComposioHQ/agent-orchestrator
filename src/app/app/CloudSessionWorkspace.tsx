"use client";

import type {
  PullRequestSummary,
  Session,
  WorkspaceDiff,
  WorkspaceEntry,
  WorkspaceFile,
} from "@aoagents/cloud-client";
import {
  InspectorReviewsView,
  PRSummaryMeta,
  PRSummaryParts,
  type InspectorReviewGroup,
} from "@aoagents/product-ui";
import {
  ChevronLeft,
  FileCode2,
  Files,
  GitCompareArrows,
  GitPullRequest,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Share2,
  Terminal,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { browserCloudClient } from "@/lib/cloud-client";
import { CloudExternalLink } from "./CloudBoard";
import { CloudTerminal } from "./CloudTerminal";
import { OrchestratorIcon } from "./OrchestratorIcon";
import { pullRequestSummaryParts, toInspectorReviewGroups } from "./pr-display";

type InspectorTab = "changes" | "files" | "reviews" | "terminal";

const reviewLabels = {
  aoSource: "AO",
  bot: "Bot",
  earlierPass: "Earlier pass",
  githubSource: "GitHub",
  loadingReviews: "Loading reviews…",
  loadMoreReviews: (count: number) => `Show ${count} more`,
  noPastReviewSummaries: "No earlier review passes.",
  notInjected: "Not delivered",
  openComments: "Open comments",
  reviews: "Reviews",
  showLatestReviewOnly: "Show latest only",
  showLess: "Show less",
  showMore: "Show more",
  commentNumber: (number: number) => `Comment ${number}`,
  unresolvedCount: (count: number) => `${count} unresolved`,
  viewOnPR: "View on PR",
};

export function CloudSessionWorkspace({
  onClose,
  onDelete = () => {},
  onNewTask = () => {},
  onShare = () => {},
  onToggleSidebar,
  sidebarOpen = true,
  organizationId,
  session,
}: {
  onClose: () => void;
  onDelete?: () => void;
  onNewTask?: () => void;
  onShare?: () => void;
  onToggleSidebar?: () => void;
  sidebarOpen?: boolean;
  organizationId: string;
  session: Session;
}) {
  const client = useMemo(browserCloudClient, []);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [tab, setTab] = useState<InspectorTab>("terminal");
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);
  const [directory, setDirectory] = useState("");
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<WorkspaceFile | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pullRequests, setPullRequests] = useState<PullRequestSummary[]>([]);
  const [reviewGroups, setReviewGroups] = useState<InspectorReviewGroup[]>([]);
  const [reviewsLoading, setReviewsLoading] = useState(true);

  const loadReviews = async () => {
    try {
      const [pullRequestPage, reviewPage] = await Promise.all([
        client.listSessionPullRequests(organizationId, session.id),
        client.getSessionReviewState(organizationId, session.id),
      ]);
      setPullRequests(pullRequestPage.pullRequests);
      setReviewGroups(toInspectorReviewGroups(reviewPage.reviews));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load pull requests.");
    } finally {
      setReviewsLoading(false);
    }
  };

  const loadDiff = async () => {
    if (!session.runtimeConnected) return;
    try {
      const next = await client.getWorkspaceDiff(organizationId, session.id);
      setDiff(next);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load changes.");
    }
  };

  const loadDirectory = async (path: string) => {
    setBusy(true);
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
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load files.");
    } finally {
      setBusy(false);
    }
  };

  const openFile = async (path: string) => {
    setBusy(true);
    try {
      const file = await client.readWorkspaceFile(
        organizationId,
        session.id,
        path,
      );
      setSelectedFile(file);
      setFileContent(file.content);
      setTab("files");
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read file.");
    } finally {
      setBusy(false);
    }
  };

  const saveFile = async () => {
    if (!selectedFile || session.mode === "read-only") return;
    setBusy(true);
    try {
      const file = await client.writeWorkspaceFile(
        organizationId,
        session.id,
        { path: selectedFile.path, content: fileContent },
      );
      setSelectedFile(file);
      setFileContent(file.content);
      await loadDiff();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save file.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void loadDiff();
    const timer = window.setInterval(() => void loadDiff(), 2_000);
    return () => window.clearInterval(timer);
  }, [organizationId, session.id, session.runtimeConnected]);

  useEffect(() => {
    if (tab === "files") {
      if (entries.length === 0) void loadDirectory("");
      const timer = window.setInterval(() => void loadDirectory(directory), 5_000);
      return () => window.clearInterval(timer);
    }
  }, [tab, directory]);

  useEffect(() => {
    void loadReviews();
    const timer = window.setInterval(() => void loadReviews(), 8_000);
    return () => window.clearInterval(timer);
  }, [organizationId, session.id]);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-bg-terminal-opaque)]">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--color-border-strong)] bg-[var(--color-bg-primary)] pl-1.5 pr-2.5">
          {onToggleSidebar ? (
            <button
              type="button"
              aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
              className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)]"
              onClick={onToggleSidebar}
            >
              {sidebarOpen ? (
                <PanelLeftClose className="size-4" aria-hidden="true" />
              ) : (
                <PanelLeftOpen className="size-4" aria-hidden="true" />
              )}
            </button>
          ) : null}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold leading-none tracking-[-0.02em]">
              {session.kind === "orchestrator" ? "Orchestrator" : session.displayName}
            </h1>
          </div>
          <span
            className={`size-1.5 rounded-full ${
              session.runtimeConnected ? "bg-[var(--color-status-working)]" : "bg-[var(--color-status-idle)]"
            }`}
          />
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              aria-label="Share"
              className="grid size-7 cursor-pointer place-items-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)]"
              onClick={onShare}
            >
              <Share2 className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Kill session"
              className="grid size-7 cursor-pointer place-items-center rounded-md text-[var(--error)]/70 transition-colors hover:bg-[var(--error)]/10 hover:text-[var(--error)]"
              onClick={() => {
                if (window.confirm(`Terminate ${session.displayName}?`)) onDelete();
              }}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={inspectorOpen ? "Close inspector" : "Open inspector"}
              className="grid size-7 cursor-pointer place-items-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)]"
              onClick={() => setInspectorOpen((c) => !c)}
            >
              {inspectorOpen ? (
                <PanelRightClose className="size-4" aria-hidden="true" />
              ) : (
                <PanelRightOpen className="size-4" aria-hidden="true" />
              )}
            </button>
          </div>
        </header>
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] px-3">
          <Terminal className="size-3.5 text-[var(--color-accent)]" />
          <span className="text-[11px] text-[var(--foreground)]">
            {session.harness}
          </span>
          <span className="font-mono text-[9px] text-[var(--color-text-passive)]">
            /workspace/repository
          </span>
        </div>
        {session.runtimeConnected ? (
          <CloudTerminal
            kind="agent"
            organizationId={organizationId}
            sessionId={session.id}
          />
        ) : (
          <div className="grid min-h-0 flex-1 place-items-center text-xs text-[var(--color-text-passive)]">
            Waiting for the isolated worker and agent terminal…
          </div>
        )}
      </section>

      <aside
        className="flex min-h-0 flex-col overflow-hidden border-l border-[var(--color-border-strong)] bg-[var(--color-bg-primary)] transition-[width] duration-200 ease-out"
        style={{ width: inspectorOpen ? "38%" : 0, minWidth: inspectorOpen ? 320 : 0 }}
      >
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--color-border-strong)] px-3">
          <InspectorButton
            active={tab === "changes"}
            label={`Changes ${diff?.files.filter((f) => !f.path.split("/").some((s) => s.startsWith("."))).length ?? 0}`}
            onClick={() => setTab("changes")}
          >
            <GitCompareArrows className="size-3.5" />
          </InspectorButton>
          <InspectorButton
            active={tab === "files"}
            label="Files"
            onClick={() => setTab("files")}
          >
            <Files className="size-3.5" />
          </InspectorButton>
          <InspectorButton
            active={tab === "terminal"}
            label="Terminal"
            onClick={() => setTab("terminal")}
          >
            <Terminal className="size-3.5" />
          </InspectorButton>
          <InspectorButton
            active={tab === "reviews"}
            label={`Pull requests ${pullRequests.length}`}
            onClick={() => setTab("reviews")}
          >
            <GitPullRequest className="size-3.5" />
          </InspectorButton>
          {tab !== "terminal" ? (
            <button
              aria-label="Refresh inspector"
              className="ml-auto grid size-7 place-items-center rounded-md text-[var(--color-text-passive)] hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)]"
              onClick={() =>
                tab === "changes"
                  ? void loadDiff()
                  : tab === "reviews"
                    ? void loadReviews()
                    : void loadDirectory(directory)
              }
              type="button"
            >
              <RefreshCw className="size-3.5" />
            </button>
          ) : null}
        </div>
        {error ? (
          <p className="border-b border-[var(--color-error)]/20 bg-[var(--color-error)]/8 px-3 py-2 text-[10px] text-[var(--color-error)]">
            {error}
          </p>
        ) : null}
        {tab === "changes" ? (
          <ChangesView diff={diff} onOpenFile={(path) => void openFile(path)} />
        ) : tab === "files" ? (
          <FileBrowser
            busy={busy}
            content={fileContent}
            directory={directory}
            entries={entries}
            file={selectedFile}
            onBack={() => {
              if (selectedFile) {
                setSelectedFile(null);
                return;
              }
              void loadDirectory(directory.split("/").slice(0, -1).join("/"));
            }}
            onChange={setFileContent}
            onOpen={(entry) =>
              entry.isDir ? void loadDirectory(entry.path) : void openFile(entry.path)
            }
            onSave={() => void saveFile()}
            readOnly={session.mode === "read-only"}
          />
        ) : tab === "reviews" ? (
          <PullRequestsView
            isLoading={reviewsLoading}
            pullRequests={pullRequests}
            reviewGroups={reviewGroups}
          />
        ) : session.mode === "trusted" && session.runtimeConnected ? (
          <CloudTerminal
            kind="workspace"
            organizationId={organizationId}
            sessionId={session.id}
          />
        ) : (
          <div className="grid min-h-0 flex-1 place-items-center p-6 text-center text-xs leading-5 text-[var(--color-text-passive)]">
            Workspace shell access requires a connected trusted session.
          </div>
        )}
      </aside>
    </div>
  );
}

function InspectorButton({
  active,
  children,
  label,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] ${
        active
          ? "bg-[var(--color-interactive-hover)] text-[var(--foreground)]"
          : "text-[var(--color-text-passive)]"
      }`}
      onClick={onClick}
      type="button"
    >
      {children}
      {label}
    </button>
  );
}

function PullRequestsView({
  isLoading,
  pullRequests,
  reviewGroups,
}: {
  isLoading: boolean;
  pullRequests: PullRequestSummary[];
  reviewGroups: InspectorReviewGroup[];
}) {
  if (isLoading && pullRequests.length === 0) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center text-xs text-[var(--color-text-passive)]">
        Loading pull requests…
      </div>
    );
  }
  if (pullRequests.length === 0) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center p-6 text-center text-xs leading-5 text-[var(--color-text-passive)]">
        No pull requests raised from this session yet.
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="flex flex-col gap-2">
        {pullRequests.map((pr) => (
          <article
            className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] px-3 py-2.5"
            key={pr.url}
          >
            <CloudExternalLink
              className="text-sm font-semibold leading-snug tracking-tight text-[var(--foreground)] underline-offset-2 hover:underline"
              href={pr.htmlUrl || pr.url}
            >
              #{pr.number} {pr.title}
            </CloudExternalLink>
            <PRSummaryMeta className="mt-1.5" externalLink={CloudExternalLink} pr={pr} />
            <PRSummaryParts
              className="mt-2 border-t border-[var(--color-border-strong)] pt-2"
              externalLink={CloudExternalLink}
              parts={pullRequestSummaryParts(pr)}
            />
          </article>
        ))}
      </div>
      <div className="mt-3">
        <InspectorReviewsView
          externalLink={CloudExternalLink}
          groups={reviewGroups}
          isLoading={isLoading}
          labels={reviewLabels}
          renderAvatar={() => <GitPullRequest className="size-3.5" />}
          renderMarkdown={(body) => (
            <p className="whitespace-pre-wrap text-xs leading-5">{body}</p>
          )}
        />
      </div>
    </div>
  );
}

function ChangesView({
  diff,
  onOpenFile,
}: {
  diff: WorkspaceDiff | null;
  onOpenFile: (path: string) => void;
}) {
  if (!diff) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center text-xs text-[var(--color-text-passive)]">
        Loading changes…
      </div>
    );
  }
  const visibleFiles = diff.files.filter((f) => !f.path.split("/").some((seg) => seg.startsWith(".")));
  const visibleUntracked = diff.untrackedFiles.filter((p) => !p.split("/").some((seg) => seg.startsWith(".")));

  if (visibleFiles.length === 0 && visibleUntracked.length === 0) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center p-6 text-center text-xs leading-5 text-[var(--color-text-passive)]">
        No workspace changes yet.
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="max-h-44 shrink-0 overflow-y-auto border-b border-[var(--color-border-strong)] p-2">
        {visibleFiles.map((file) => (
          <button
            className="flex h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-[var(--color-interactive-hover)]"
            key={file.path}
            onClick={() => onOpenFile(file.path)}
            type="button"
          >
            <FileCode2 className="size-3.5 text-[var(--color-text-passive)]" />
            <span className="min-w-0 flex-1 truncate text-xs">{file.path}</span>
            <span className="font-mono text-[9px] text-[#4ade80]">
              +{file.additions}
            </span>
            <span className="font-mono text-[9px] text-[#f87171]">
              -{file.deletions}
            </span>
          </button>
        ))}
        {visibleUntracked.map((path) => (
          <button
            className="flex h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-[var(--color-interactive-hover)]"
            key={path}
            onClick={() => onOpenFile(path)}
            type="button"
          >
            <FileCode2 className="size-3.5 text-[var(--color-text-passive)]" />
            <span className="min-w-0 flex-1 truncate text-xs">{path}</span>
            <span className="font-mono text-[9px] text-[#4ade80]">new</span>
          </button>
        ))}
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre p-3 font-mono text-[10px] leading-4 text-[#c8ccd2]">
        {diff.combined || "Untracked files have no diff yet."}
      </pre>
    </div>
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
      {entries.filter((entry) => !entry.name.startsWith(".")).map((entry) => (
        <button
          className="flex h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-[var(--color-interactive-hover)]"
          key={entry.path}
          onClick={() => onOpen(entry)}
          type="button"
        >
          <FileCode2 className="size-3.5 text-[var(--color-text-passive)]" />
          <span className="min-w-0 flex-1 truncate text-xs">{entry.name}</span>
          <span className="font-mono text-[9px] text-[var(--color-text-passive)]">
            {entry.isDir ? "dir" : entry.size}
          </span>
        </button>
      ))}
    </div>
  );
}
