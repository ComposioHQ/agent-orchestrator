"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { getProjectSessionHref } from "@/lib/project-utils";
import {
  getAttentionLevel,
  type PortfolioActivityItem,
  type PortfolioProjectSummary,
} from "@/lib/types";

interface ActivityFeedPageProps {
  projectSummaries: PortfolioProjectSummary[];
  activityItems: PortfolioActivityItem[];
}

interface ActivityGroup {
  key: string;
  label: string;
  items: PortfolioActivityItem[];
}

export function ActivityFeedPage({
  projectSummaries,
  activityItems,
}: ActivityFeedPageProps) {
  const pathname = usePathname() ?? "/activity";
  const [query, setQuery] = useState("");
  const workspaceCount = projectSummaries.length;
  const normalizedQuery = query.trim().toLowerCase();

  const filteredItems = useMemo(() => {
    if (!normalizedQuery) return activityItems;

    return activityItems.filter((item) => {
      const { session, projectName } = item;
      const haystack = [
        projectName,
        session.id,
        getPrimaryLabel(session),
        getSecondaryLabel(session),
        session.branch ?? "",
        session.issueLabel ?? "",
        session.issueTitle ?? "",
        session.pr?.title ?? "",
        session.pr?.branch ?? "",
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    });
  }, [activityItems, normalizedQuery]);

  const groups = useMemo(() => groupActivityItems(filteredItems), [filteredItems]);

  return (
    <main className="min-h-screen bg-[var(--color-bg-base)] text-[var(--color-text-primary)]">
      <div className="mx-auto flex w-full max-w-[1360px] flex-col px-5 pb-10 pt-4 sm:px-7 lg:px-9">
        <div className="sticky top-0 z-[5] border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-base)]/90 py-3 backdrop-blur">
          <label className="flex h-12 items-center gap-3 rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-4 text-[var(--color-text-secondary)] shadow-[var(--card-shadow)]">
            <SearchIcon />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter workspaces..."
              aria-label="Filter workspaces"
              className="w-full bg-transparent text-[var(--font-size-base)] outline-none placeholder:text-[var(--color-text-tertiary)]"
            />
          </label>
        </div>

        {groups.length > 0 ? (
          <div className="pt-4">
            {groups.map((group) => (
              <section key={group.key} className="pb-8">
                <div className="mb-3 flex items-center gap-2 px-1 text-[13px] font-medium text-[var(--color-text-secondary)]">
                  <span>{group.label}</span>
                  <span className="text-[var(--color-text-tertiary)]">{group.items.length}</span>
                </div>
                <div className="space-y-0.5">
                  {group.items.map((item) => {
                    const href = getProjectSessionHref(item.projectId, item.session.id);
                    const isSelected = pathname === href;
                    const level = getAttentionLevel(item.session);
                    const isMuted = level === "done";

                    return (
                      <Link
                        key={`${item.projectId}:${item.session.id}`}
                        href={href}
                        className={cn(
                          "grid min-h-[46px] grid-cols-[minmax(0,160px)_16px_minmax(0,1fr)_auto] items-center gap-3 rounded-[4px] px-3 py-2 text-[13px] transition-colors hover:bg-[var(--color-bg-elevated-hover)] hover:no-underline",
                          isSelected && "bg-[var(--color-accent-subtle)]",
                          isMuted && "opacity-70",
                        )}
                      >
                        <div className="min-w-0">
                          <span className="block truncate font-medium text-[var(--color-text-secondary)]">
                            {item.projectName}
                          </span>
                        </div>
                        <div className="flex justify-center text-[var(--color-text-tertiary)]">
                          <ChevronRightIcon />
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-[var(--color-text-primary)]">
                            {getPrimaryLabel(item.session)}
                            {getSecondaryLabel(item.session) ? (
                              <span className="ml-2 text-[var(--color-text-tertiary)]">
                                · {getSecondaryLabel(item.session)}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <div className="pl-3 text-right text-[12px] tabular-nums text-[var(--color-text-tertiary)]">
                          {formatAbsoluteDate(item.session.lastActivityAt)}
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="flex min-h-[55vh] flex-col items-center justify-center px-6 text-center">
            <div className="text-[var(--font-size-xl)] font-medium tracking-[-0.025em] text-[var(--color-text-primary)]">
              {workspaceCount > 0 ? "No matching activity" : "No activity yet"}
            </div>
            <p className="mt-3 max-w-[38ch] text-[var(--font-size-base)] leading-relaxed text-[var(--color-text-secondary)]">
              {workspaceCount > 0
                ? "Try a different search or open a workspace from the sidebar to start new work."
                : "Open or clone a workspace from the sidebar to begin tracking activity here."}
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

function getPrimaryLabel(session: PortfolioActivityItem["session"]): string {
  return (
    session.summary ||
    session.issueTitle ||
    session.pr?.title ||
    session.issueLabel ||
    session.branch ||
    session.id
  );
}

function getSecondaryLabel(session: PortfolioActivityItem["session"]): string | null {
  return session.branch || session.issueLabel || null;
}

function groupActivityItems(items: PortfolioActivityItem[]): ActivityGroup[] {
  const groups = new Map<string, ActivityGroup>();

  for (const item of items) {
    const date = new Date(item.session.lastActivityAt);
    const key = getGroupKey(date);
    const label = getGroupLabel(date);
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
    } else {
      groups.set(key, { key, label, items: [item] });
    }
  }

  return [...groups.values()];
}

function getDayDifference(date: Date): number {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.floor((startOfToday - startOfDate) / 86_400_000);
}

function getGroupKey(date: Date): string {
  const diffDays = getDayDifference(date);
  if (diffDays <= 1) return `day:${diffDays}`;
  if (diffDays < 7) return `days:${diffDays}`;
  const weeks = Math.floor(diffDays / 7);
  if (weeks < 5) return `weeks:${weeks}`;
  const months =
    (new Date().getFullYear() - date.getFullYear()) * 12 +
    (new Date().getMonth() - date.getMonth());
  return `months:${Math.max(1, months)}`;
}

function getGroupLabel(date: Date): string {
  const diffDays = getDayDifference(date);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  const weeks = Math.floor(diffDays / 7);
  if (weeks === 1) return "1 week ago";
  if (weeks < 5) return `${weeks} weeks ago`;
  const months =
    (new Date().getFullYear() - date.getFullYear()) * 12 +
    (new Date().getMonth() - date.getMonth());
  return months <= 1 ? "1 month ago" : `${months} months ago`;
}

function formatAbsoluteDate(dateString: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(dateString));
}

function SearchIcon() {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" strokeLinecap="round" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <path d="m10 7 5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
