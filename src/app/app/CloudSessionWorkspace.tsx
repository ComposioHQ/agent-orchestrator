"use client";

import type {
  PullRequestSummary,
  Session,
  WorkspaceDiff,
  WorkspaceEntry,
  WorkspaceFile,
} from "@aoagents/cloud-client";
import {
  AgentAvatar,
  InspectorReviewsView,
  PRSummaryMeta,
  PRSummaryParts,
  SessionInspectorShellView,
  SessionWorkspaceTopbarView,
  TransientToastView,
  type InspectorTab,
  type InspectorReviewGroup,
} from "@aoagents/product-ui";
import {
  ChevronLeft,
  FileCode2,
  Files,
  GitPullRequest,
  CircleAlert,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Share2,
  Terminal,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { browserCloudClient } from "@/lib/cloud-client";
import { CloudExternalLink } from "./CloudBoard";
import { CloudTerminal } from "./CloudTerminal";
import { harnessLogoSource } from "./harness-logo";
import { OrchestratorIcon } from "./OrchestratorIcon";
import { pullRequestSummaryParts, toInspectorReviewGroups } from "./pr-display";

type CloudInspectorTab = "summary" | "files" | "terminal";

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
  organizationId,
  projectSessions = [],
  session,
}: {
  onClose: () => void;
  onDelete?: () => void;
  onNewTask?: () => void;
  onShare?: () => void;
  organizationId: string;
  projectSessions?: Session[];
  session: Session;
}) {
  const client = useMemo(browserCloudClient, []);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [tab, setTab] = useState<CloudInspectorTab>("terminal");
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);
  const [projectDiffs, setProjectDiffs] = useState<Array<{ session: Session; diff: WorkspaceDiff }>>([]);
  const [directory, setDirectory] = useState("");
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<WorkspaceFile | null>(null);
  const [selectedFileSessionId, setSelectedFileSessionId] = useState(session.id);
  const [fileContent, setFileContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toastError, setToastError] = useState("");
  const [pullRequests, setPullRequests] = useState<PullRequestSummary[]>([]);
  const [reviewGroups, setReviewGroups] = useState<InspectorReviewGroup[]>([]);
  const [reviewsLoading, setReviewsLoading] = useState(true);
  const diffInFlight = useRef(false);
  const shownErrors = useRef(new Set<string>());
  const projectRuntimeKey = projectSessions
    .map((candidate) => `${candidate.id}:${candidate.runtimeConnected}:${candidate.isTerminated}`)
    .join("|");

  useEffect(() => {
    if (!error || error === "Too many workspace operations are already in progress." || shownErrors.current.has(error)) return;
    shownErrors.current.add(error);
    setToastError(error);
    const timer = window.setTimeout(() => setToastError(""), 2_000);
    return () => window.clearTimeout(timer);
  }, [error]);

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
    if (!session.runtimeConnected || diffInFlight.current) return;
    diffInFlight.current = true;
    try {
      if (session.kind === "orchestrator") {
        const projectRepositories = Array.from(
          new Map(
            [session, ...projectSessions]
              .filter((candidate) => (
                candidate.id === session.id || candidate.kind !== "orchestrator"
              ) && candidate.runtimeConnected && !candidate.isTerminated)
              .map((candidate) => [candidate.id, candidate]),
          ).values(),
        );
        const results = await Promise.allSettled(
          projectRepositories.map(async (projectSession) => ({
            session: projectSession,
            diff: await client.getWorkspaceDiff(organizationId, projectSession.id),
          })),
        );
        setProjectDiffs(results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []));
        setDiff(null);
      } else {
        const next = await client.getWorkspaceDiff(organizationId, session.id);
        setDiff(next);
        setProjectDiffs([]);
      }
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load changes.");
    } finally {
      diffInFlight.current = false;
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

  const openFile = async (path: string, sourceSessionId = session.id) => {
    setBusy(true);
    try {
      const file = await client.readWorkspaceFile(
        organizationId,
        sourceSessionId,
        path,
      );
      setSelectedFile(file);
      setSelectedFileSessionId(sourceSessionId);
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
        selectedFileSessionId,
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
  }, [organizationId, session.id, session.runtimeConnected, projectRuntimeKey]);

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

  const inspectorTabs: InspectorTab<CloudInspectorTab>[] = [
    {
      id: "summary",
      label: "Summary",
      displayLabel: `Summary ${session.kind === "orchestrator"
        ? projectDiffs.reduce((count, item) => count + item.diff.files.length + item.diff.untrackedFiles.length, 0)
        : (diff?.files.length ?? 0) + (diff?.untrackedFiles.length ?? 0)}`,
      icon: <SummaryIcon />,
    },
    {
      id: "terminal",
      label: "Terminal",
      icon: <Terminal aria-hidden="true" />,
    },
    {
      id: "files",
      label: "Files",
      icon: <Files aria-hidden="true" />,
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-[var(--color-bg-primary)]">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-bg-terminal-opaque)]">
        <SessionWorkspaceTopbarView
          terminalTabs={(
            <div className="group relative inline-flex min-w-36 self-stretch items-center gap-1.5 border-r border-[var(--border)] bg-[var(--color-bg-secondary)] px-3 text-[var(--foreground)] after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-[var(--foreground)]/80">
              {session.kind === "orchestrator" ? (
                <OrchestratorIcon className="size-4 shrink-0" aria-hidden="true" />
              ) : (
                <AgentAvatar
                  className="size-4 shrink-0"
                  decorative
                  logoSrc={harnessLogoSource(session.harness)}
                  provider={session.harness}
                />
              )}
              <span className="min-w-0 truncate text-xs font-medium leading-none">
                {session.kind === "orchestrator" ? "Orchestrator" : session.displayName}
              </span>
              <span
                aria-hidden="true"
                className={`size-1.5 shrink-0 rounded-full ${
                  session.runtimeConnected ? "bg-[var(--color-status-working)]" : "bg-[var(--color-status-idle)]"
                }`}
              />
            </div>
          )}
          actions={(
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
          )}
        />
        {session.runtimeConnected ? (
          <CloudTerminal
            kind="agent"
            layoutKey={inspectorOpen ? "inspector-open" : "inspector-closed"}
            organizationId={organizationId}
            sessionId={session.id}
          />
        ) : (
          <ProvisioningState session={session} terminal="agent" />
        )}
      </section>

      <aside
        className="flex min-h-0 flex-col overflow-hidden border-l border-[var(--color-border-strong)] bg-[var(--color-bg-primary)] transition-[width] duration-200 ease-out"
        style={{ width: inspectorOpen ? "38%" : 0, minWidth: inspectorOpen ? 320 : 0 }}
      >
        <SessionInspectorShellView<CloudInspectorTab>
          activeView={tab}
          ariaLabel="Session inspector"
          browserPoppedOut={false}
          compactTabs
          onViewChange={setTab}
          tabs={inspectorTabs}
          summaryView={(
            <div className="space-y-5">
              <InspectorSectionHeader label="Changes" onRefresh={() => void loadDiff()} />
              {session.kind === "orchestrator" ? (
                <ProjectChangesView
                  projectDiffs={projectDiffs}
                  onOpenFile={(sessionId, path) => void openFile(path, sessionId)}
                />
              ) : (
                <ChangesView diff={diff} onOpenFile={(path) => void openFile(path)} />
              )}
              <InspectorSectionHeader label="Pull requests" onRefresh={() => void loadReviews()} />
              <PullRequestsView isLoading={reviewsLoading} pullRequests={pullRequests} reviewGroups={reviewGroups} />
            </div>
          )}
          filesView={<FileBrowser
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
          />}
          terminalView={session.runtimeConnected ? <CloudTerminal
            kind="workspace"
            layoutKey={`${inspectorOpen ? "inspector-open" : "inspector-closed"}:${tab}`}
            organizationId={organizationId}
            sessionId={session.id}
          /> : <ProvisioningState session={session} terminal="workspace" />}
        />
      </aside>
      {toastError ? (
        <TransientToastView>{toastError}</TransientToastView>
      ) : null}
    </div>
  );
}

function ProvisioningState({
  session,
  terminal,
}: {
  session: Session;
  terminal: "agent" | "workspace";
}) {
  const failed = session.runtimeState === "failed" || Boolean(session.runtimeError);
  const label = failed
    ? session.runtimeError || "The isolated worker could not start."
    : provisioningLabel(session.runtimeState, terminal);

  return (
    <div className="grid min-h-0 flex-1 place-items-center p-6 text-center">
      <div className="flex max-w-sm flex-col items-center gap-3">
        {failed ? (
          <CircleAlert className="size-5 text-[var(--color-error)]" aria-hidden="true" />
        ) : (
          <Loader2 className="size-5 animate-spin text-[var(--color-accent)]" aria-hidden="true" />
        )}
        <p
          className={`text-xs leading-5 ${
            failed ? "text-[var(--color-error)]" : "text-[var(--color-text-passive)]"
          }`}
        >
          {label}
        </p>
      </div>
    </div>
  );
}

function provisioningLabel(
  runtimeState: string | undefined,
  terminal: "agent" | "workspace",
): string {
  switch (runtimeState) {
    case "provisioning":
      return "Provisioning the NodeOps VM…";
    case "bootstrapping":
      return "Starting the AO worker and coding-agent harness…";
    case "ready":
      return terminal === "workspace"
        ? "Connecting the workspace shell…"
        : "Connecting the coding-agent terminal…";
    case "disconnected":
      return "Reconnecting to the isolated worker…";
    default:
      return "Preparing the isolated worker…";
  }
}

function SummaryIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <line x1="8" y1="7" x2="20" y2="7" />
      <line x1="8" y1="12" x2="20" y2="12" />
      <line x1="8" y1="17" x2="16" y2="17" />
      <circle cx="4" cy="7" r="1" />
      <circle cx="4" cy="12" r="1" />
      <circle cx="4" cy="17" r="1" />
    </svg>
  );
}

function InspectorSectionHeader({ label, onRefresh }: { label: string; onRefresh: () => void }) {
  return (
    <div className="flex items-center justify-between text-[10px] font-bold uppercase text-[var(--color-text-passive)]">
      <span>{label}</span>
      <button type="button" aria-label={`Refresh ${label.toLowerCase()}`} className="grid size-7 place-items-center rounded-md hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)]" onClick={onRefresh}>
        <RefreshCw className="size-3.5" aria-hidden="true" />
      </button>
    </div>
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

function ProjectChangesView({
  onOpenFile,
  projectDiffs,
}: {
  onOpenFile: (sessionId: string, path: string) => void;
  projectDiffs: Array<{ session: Session; diff: WorkspaceDiff }>;
}) {
  const changedRepositories = projectDiffs.filter(({ diff }) => {
    const visibleFiles = diff.files.filter((file) => !isHiddenPath(file.path));
    const visibleUntracked = diff.untrackedFiles.filter((path) => !isHiddenPath(path));
    return visibleFiles.length > 0 || visibleUntracked.length > 0;
  });

  if (changedRepositories.length === 0) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center p-6 text-center text-xs leading-5 text-[var(--color-text-passive)]">
        No project changes yet.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {changedRepositories.map(({ session: projectSession, diff }) => {
        const visibleFiles = diff.files.filter((file) => !isHiddenPath(file.path));
        const visibleUntracked = diff.untrackedFiles.filter((path) => !isHiddenPath(path));
        return (
          <section key={projectSession.id} className="overflow-hidden rounded-md border border-[var(--color-border-strong)]">
            <div className="border-b border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] px-3 py-2 text-xs font-medium text-[var(--foreground)]">
              {projectSession.kind === "orchestrator" ? "Orchestrator" : projectSession.displayName}
            </div>
            <div className="p-1">
              {visibleFiles.map((file) => (
                <button
                  className="flex h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-[var(--color-interactive-hover)]"
                  key={file.path}
                  onClick={() => onOpenFile(projectSession.id, file.path)}
                  type="button"
                >
                  <FileCode2 className="size-3.5 text-[var(--color-text-passive)]" />
                  <span className="min-w-0 flex-1 truncate text-xs">{file.path}</span>
                  <span className="font-mono text-[9px] text-[#4ade80]">+{file.additions}</span>
                  <span className="font-mono text-[9px] text-[#f87171]">-{file.deletions}</span>
                </button>
              ))}
              {visibleUntracked.map((path) => (
                <button
                  className="flex h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-[var(--color-interactive-hover)]"
                  key={path}
                  onClick={() => onOpenFile(projectSession.id, path)}
                  type="button"
                >
                  <FileCode2 className="size-3.5 text-[var(--color-text-passive)]" />
                  <span className="min-w-0 flex-1 truncate text-xs">{path}</span>
                  <span className="font-mono text-[9px] text-[#4ade80]">new</span>
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function isHiddenPath(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("."));
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
