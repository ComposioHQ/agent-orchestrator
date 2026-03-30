"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { getProjectSessionHref } from "@/lib/project-utils";
import { Modal } from "./Modal";

type ResourceTab = "pullRequests" | "branches" | "issues";

interface WorkspaceProject {
  id: string;
  name: string;
  repo?: string;
}

interface PullRequestResource {
  id: string;
  number: number;
  title: string;
  author: string;
  branch: string;
  url: string;
  updatedAt?: string;
}

interface BranchResource {
  id: string;
  name: string;
  author?: string;
  updatedAt?: string;
}

interface IssueResource {
  id: string;
  title: string;
  url: string;
  state: string;
  assignee?: string;
}

interface WorkspaceResourcesModalProps {
  open: boolean;
  onClose: () => void;
  project: WorkspaceProject | null;
}

type SelectedResource =
  | { tab: "pullRequests"; item: PullRequestResource }
  | { tab: "branches"; item: BranchResource }
  | { tab: "issues"; item: IssueResource }
  | null;

export function WorkspaceResourcesModal({
  open,
  onClose,
  project,
}: WorkspaceResourcesModalProps) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<ResourceTab>("pullRequests");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pullRequests, setPullRequests] = useState<PullRequestResource[]>([]);
  const [branches, setBranches] = useState<BranchResource[]>([]);
  const [issues, setIssues] = useState<IssueResource[]>([]);
  const [selected, setSelected] = useState<SelectedResource>(null);
  const [submitting, setSubmitting] = useState<"thread" | "agent" | null>(null);

  useEffect(() => {
    if (!open) {
      setSearch("");
      setTab("pullRequests");
      setError(null);
      setSelected(null);
      setSubmitting(null);
      return;
    }
  }, [open]);

  useEffect(() => {
    if (!open || !project) return;

    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(project.id)}/resources?q=${encodeURIComponent(search.trim())}`,
          { signal: controller.signal },
        );
        const body = (await res.json().catch(() => null)) as
          | {
              error?: string;
              pullRequests?: PullRequestResource[];
              branches?: BranchResource[];
              issues?: IssueResource[];
            }
          | null;
        if (!res.ok) {
          throw new Error(body?.error || "Failed to load resources");
        }

        const nextPullRequests = body?.pullRequests ?? [];
        const nextBranches = body?.branches ?? [];
        const nextIssues = body?.issues ?? [];
        setPullRequests(nextPullRequests);
        setBranches(nextBranches);
        setIssues(nextIssues);

        setSelected((current) => {
          if (current && current.tab === "pullRequests") {
            const match = nextPullRequests.find((item) => item.id === current.item.id);
            if (match) return { tab: "pullRequests", item: match };
          }
          if (current && current.tab === "branches") {
            const match = nextBranches.find((item) => item.id === current.item.id);
            if (match) return { tab: "branches", item: match };
          }
          if (current && current.tab === "issues") {
            const match = nextIssues.find((item) => item.id === current.item.id);
            if (match) return { tab: "issues", item: match };
          }
          return null;
        });
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : "Failed to load resources");
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }, 180);

    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [open, project, search]);

  const resources = useMemo(() => {
    if (tab === "pullRequests") return pullRequests;
    if (tab === "branches") return branches;
    return issues;
  }, [branches, issues, pullRequests, tab]);

  async function handleCreate(mode: "thread" | "agent") {
    if (!project) return;
    setSubmitting(mode);
    setError(null);

    try {
      if (mode === "agent" && !selected) {
        const res = await fetch("/api/orchestrators", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: project.id }),
        });
        const body = (await res.json().catch(() => null)) as { error?: string; orchestrator?: { id: string } } | null;
        if (!res.ok || !body?.orchestrator?.id) {
          throw new Error(body?.error || "Failed to spawn orchestrator");
        }
        router.push(getProjectSessionHref(project.id, body.orchestrator.id));
        onClose();
        return;
      }

      const payload: Record<string, string> = { projectId: project.id };
      if (selected?.tab === "pullRequests") {
        payload.branch = selected.item.branch;
        payload.prompt = `Work from pull request #${selected.item.number}: ${selected.item.title}\nURL: ${selected.item.url}`;
      } else if (selected?.tab === "branches") {
        payload.branch = selected.item.name;
        payload.prompt = `Continue work on branch ${selected.item.name}.`;
      } else if (selected?.tab === "issues") {
        payload.issueId = selected.item.id;
        payload.prompt = `Work on issue ${selected.item.id}: ${selected.item.title}\nURL: ${selected.item.url}`;
      }

      const res = await fetch("/api/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => null)) as { error?: string; session?: { id: string } } | null;
      if (!res.ok || !body?.session?.id) {
        throw new Error(body?.error || "Failed to create thread");
      }

      if (mode === "thread") {
        router.push(getProjectSessionHref(project.id, body.session.id));
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create session");
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={project ? `Link work in ${project.name}` : "Link work"}
      size="lg"
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="text-[12px] text-[var(--color-text-tertiary)]">
            {project?.repo ?? "Select a workspace resource to reuse context."}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleCreate("thread")}
              disabled={submitting !== null || !project}
              className="rounded-[4px] border border-[var(--color-border-default)] px-4 py-2 text-[12px] font-medium text-[var(--color-text-secondary)] disabled:opacity-50"
            >
              {submitting === "thread" ? "Creating..." : "New thread"}
            </button>
            <button
              type="button"
              onClick={() => void handleCreate("agent")}
              disabled={submitting !== null || !project}
              className="rounded-[4px] bg-[var(--color-accent)] px-4 py-2 text-[12px] font-semibold text-[var(--color-text-inverse)] disabled:opacity-50"
            >
              {submitting === "agent" ? "Spawning..." : "Spawn agent"}
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by title, number, or author"
            className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-4 py-3 text-[14px] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] p-1">
            {[
              ["pullRequests", "Pull requests"],
              ["branches", "Branches"],
              ["issues", "Issues"],
            ].map(([value, label]) => {
              const active = tab === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setTab(value as ResourceTab)}
                  className={active ? "rounded-[4px] bg-[var(--color-bg-surface)] px-3 py-2 text-[13px] font-medium text-[var(--color-text-primary)]" : "rounded-[4px] px-3 py-2 text-[13px] text-[var(--color-text-secondary)]"}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div className="text-[12px] text-[var(--color-text-tertiary)]">
            {project?.repo ?? project?.name}
          </div>
        </div>

        {error ? <div className="text-[12px] text-[var(--color-status-error)]">{error}</div> : null}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.45fr)_240px]">
          <div className="max-h-[420px] overflow-y-auto rounded-[2px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)]">
            {loading ? (
              <div className="px-4 py-6 text-[13px] text-[var(--color-text-tertiary)]">
                Loading resources...
              </div>
            ) : resources.length === 0 ? (
              <div className="px-4 py-6 text-[13px] text-[var(--color-text-tertiary)]">
                No matching resources.
              </div>
            ) : (
              <div className="divide-y divide-[var(--color-border-subtle)]">
                {resources.map((item) => {
                  const itemId = "number" in item ? `pr-${item.id}` : `${tab}-${item.id}`;
                  const isSelected = selected?.item.id === item.id && selected?.tab === tab;
                  return (
                    <button
                      key={itemId}
                      type="button"
                      onClick={() => setSelected({ tab, item } as SelectedResource)}
                      className={cn(
                        "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors",
                        isSelected
                          ? "bg-[var(--color-accent-subtle)]"
                          : "hover:bg-[var(--color-bg-elevated-hover)]",
                      )}
                    >
                      <span className="mt-1 shrink-0 text-[var(--color-text-tertiary)]">
                        {tab === "pullRequests" ? <PullRequestIcon /> : tab === "branches" ? <BranchIcon /> : <IssueIcon />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[14px] font-medium text-[var(--color-text-primary)]">
                          {"number" in item ? `#${item.number} ${item.title}` : "title" in item ? `${item.id} ${item.title}` : item.name}
                        </div>
                        <div className="mt-1 truncate text-[12px] text-[var(--color-text-secondary)]">
                          {"branch" in item
                            ? `${item.author} • ${item.branch}`
                            : "state" in item
                              ? `${item.state}${item.assignee ? ` • ${item.assignee}` : ""}`
                              : item.author ?? "Branch"}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="rounded-[2px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-4 py-4">
            {selected ? (
              <div className="space-y-3">
                <div className="text-[12px] uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
                  {selected.tab === "pullRequests"
                    ? "Pull request"
                    : selected.tab === "branches"
                      ? "Branch"
                      : "Issue"}
                </div>
                <div className="text-[15px] font-medium leading-6 text-[var(--color-text-primary)]">
                  {selected.tab === "branches" ? selected.item.name : selected.item.title}
                </div>
                <div className="text-[12px] text-[var(--color-text-secondary)]">
                  {selected.tab === "pullRequests"
                    ? `#${selected.item.number} by ${selected.item.author}`
                    : selected.tab === "branches"
                      ? selected.item.author ?? "Existing branch"
                      : `${selected.item.id}${selected.item.assignee ? ` • ${selected.item.assignee}` : ""}`}
                </div>
                {selected.tab !== "branches" ? (
                  <a
                    href={selected.item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex text-[12px] text-[var(--color-accent)] hover:no-underline"
                  >
                    Open source link
                  </a>
                ) : null}
                <div className="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-3 py-2 text-[12px] text-[var(--color-text-secondary)]">
                  {selected.tab === "pullRequests"
                    ? `Use branch ${selected.item.branch} to continue this PR.`
                    : selected.tab === "branches"
                      ? `Use branch ${selected.item.name} for the next session.`
                      : `Use issue ${selected.item.id} and auto-attach tracker context.`}
                </div>
              </div>
            ) : (
              <div className="text-[13px] text-[var(--color-text-tertiary)]">
                Select a pull request, branch, or issue to reuse its context.
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function PullRequestIcon() {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <circle cx="6" cy="6" r="2.25" />
      <circle cx="18" cy="18" r="2.25" />
      <circle cx="18" cy="6" r="2.25" />
      <path d="M8.25 6h5.5M18 8.25v5.5M8.25 6a7.75 7.75 0 0 1 7.5 7.5" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <circle cx="7" cy="6" r="2.25" />
      <circle cx="17" cy="18" r="2.25" />
      <path d="M7 8.25V14a4 4 0 0 0 4 4h3.75" />
      <path d="M7 8.25V18" />
    </svg>
  );
}

function IssueIcon() {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <path d="M7 4.75h10A2.25 2.25 0 0 1 19.25 7v10A2.25 2.25 0 0 1 17 19.25H7A2.25 2.25 0 0 1 4.75 17V7A2.25 2.25 0 0 1 7 4.75Z" />
      <path d="M8.75 9h6.5M8.75 13h4.5" />
    </svg>
  );
}
