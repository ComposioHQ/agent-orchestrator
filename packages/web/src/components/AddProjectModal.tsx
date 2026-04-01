"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "./Modal";

interface AddProjectModalProps {
  open: boolean;
  onClose: () => void;
  onProjectAdded?: (projectId: string) => void;
}

interface BrowseEntry {
  name: string;
  path: string;
  hasChildren: boolean;
}

interface BrowseResult {
  path: string;
  parent: string | null;
  directories: BrowseEntry[];
  isGitRepo: boolean;
  hasConfig: boolean;
}

interface ParsedMigrationError {
  summary: string;
  filePath?: string;
  duplicateKeys?: string[];
  guidance?: string;
}

function parseMigrationError(error: string): ParsedMigrationError | null {
  if (!error.includes("older AO config")) return null;

  const lines = error
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const summary = lines[0] ?? error;
  const filePath = lines.find((line) => line.startsWith("File to edit: "))?.replace("File to edit: ", "");
  const duplicateKeysLine = lines
    .find((line) => line.startsWith("Duplicate project keys: "))
    ?.replace("Duplicate project keys: ", "");
  const guidance = lines[lines.length - 1];

  return {
    summary,
    filePath,
    duplicateKeys: duplicateKeysLine
      ? duplicateKeysLine.split(",").map((key) => key.trim()).filter(Boolean)
      : undefined,
    guidance: guidance && guidance !== summary ? guidance : undefined,
  };
}

export function AddProjectModal({ open, onClose, onProjectAdded }: AddProjectModalProps) {
  const router = useRouter();
  const [selectedPath, setSelectedPath] = useState("");
  const [name, setName] = useState("");
  const [nameManuallySet, setNameManuallySet] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Browser state
  const [browseResult, setBrowseResult] = useState<BrowseResult | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const browse = useCallback(async (dirPath?: string) => {
    setBrowsing(true);
    setBrowseError(null);
    try {
      const params = dirPath ? `?path=${encodeURIComponent(dirPath)}` : "";
      const res = await fetch(`/api/browse-directory${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to browse");
      setBrowseResult(data as BrowseResult);
      setPathInput(data.path);
      setSelectedPath(data.path);
      setError(null);
      // Scroll to top when navigating
      scrollRef.current?.scrollTo(0, 0);
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : "Failed to browse directory");
    } finally {
      setBrowsing(false);
    }
  }, []);

  // Load home directory when modal opens
  useEffect(() => {
    if (open) {
      void browse();
    }
  }, [open, browse]);

  // Auto-fill name from selected path
  useEffect(() => {
    if (!nameManuallySet && selectedPath) {
      const segments = selectedPath.replace(/\/+$/, "").split("/");
      const last = segments[segments.length - 1] || "";
      setName(last);
    }
  }, [selectedPath, nameManuallySet]);

  // Reset form when modal closes
  useEffect(() => {
    if (!open) {
      setSelectedPath("");
      setName("");
      setNameManuallySet(false);
      setError(null);
      setSubmitting(false);
      setBrowseResult(null);
      setBrowseError(null);
      setPathInput("");
    }
  }, [open]);

  const handleSubmit = useCallback(async () => {
    const path = selectedPath.trim();
    if (!path) {
      setError("Select a directory first");
      return;
    }

    setError(null);
    setSubmitting(true);

    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path,
          name: name.trim() || undefined,
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { error?: string; project?: { id?: string } }
        | null;

      if (!res.ok) {
        throw new Error(body?.error || `Failed to add project (${res.status})`);
      }

      const projectId = body?.project?.id;
      if (typeof projectId === "string" && projectId.length > 0) {
        onProjectAdded?.(projectId);
        router.push(`/projects/${encodeURIComponent(projectId)}`);
      } else {
        window.location.reload();
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add project");
    } finally {
      setSubmitting(false);
    }
  }, [selectedPath, name, onProjectAdded, onClose, router]);

  const parsedError = error ? parseMigrationError(error) : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Open Project"
      size="md"
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            {submitting ? (
              <span className="inline-flex items-center gap-2 text-[11px] text-[var(--color-text-tertiary)]">
                <InlineSpinner />
                Registering workspace...
              </span>
            ) : selectedPath ? (
              <span
                className="block truncate text-[11px] text-[var(--color-text-tertiary)]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {selectedPath}
              </span>
            ) : (
              <span className="text-[11px] text-[var(--color-text-quaternary)]">
                No directory selected
              </span>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={onClose}
              className="border border-[var(--color-border-default)] px-4 py-2 text-[12px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-elevated-hover)]"
              style={{ borderRadius: "2px", minHeight: 40 }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || !selectedPath.trim()}
              className="inline-flex items-center gap-2 bg-[var(--color-accent)] px-4 py-2 text-[12px] font-semibold text-[var(--color-text-inverse)] transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
              style={{ borderRadius: "2px", minHeight: 40 }}
            >
              {submitting ? (
                <>
                  <InlineSpinner inverse />
                  Opening...
                </>
              ) : (
                browseResult?.hasConfig
                  ? "Open Project"
                  : browseResult?.isGitRepo
                    ? "Set Up Project"
                    : "Initialize Project"
              )}
            </button>
          </div>
        </div>
      }
    >
      <div
        className="flex flex-col gap-3 transition-opacity duration-150"
        style={{ opacity: submitting ? 0.72 : 1 }}
      >
        {submitting ? (
          <div className="rounded-[6px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] px-3.5 py-2.5">
            <div className="flex items-center gap-2.5">
              <InlineSpinner />
              <div className="min-w-0">
                <p className="text-[11px] font-medium text-[var(--color-text-primary)]">
                  Opening workspace
                </p>
                <p className="text-[10px] text-[var(--color-text-tertiary)]">
                  Registering the repo and refreshing the portfolio view.
                </p>
              </div>
            </div>
          </div>
        ) : null}

        {error ? (
          parsedError ? (
            <div className="rounded-[6px] border border-[var(--color-border-default)] bg-[var(--color-tint-orange)]/60 px-3.5 py-3 text-[var(--color-text-secondary)]">
              <div className="flex items-start gap-2.5">
                <div className="mt-0.5 shrink-0 rounded-full bg-[var(--color-bg-surface)] p-1 text-[var(--color-accent-orange)]">
                  <MigrationNoticeIcon />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] font-semibold text-[var(--color-text-primary)]">
                    Older AO config needs a quick cleanup
                  </p>
                  <p className="mt-1 text-[11px] leading-5 text-[var(--color-text-secondary)]">
                    {parsedError.summary}
                  </p>

                  {parsedError.filePath ? (
                    <div className="mt-3 rounded-[4px] bg-[var(--color-bg-surface)] px-2.5 py-2">
                      <div className="text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
                        File to edit
                      </div>
                      <div
                        className="mt-1 break-all text-[11px] text-[var(--color-text-primary)]"
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        {parsedError.filePath}
                      </div>
                    </div>
                  ) : null}

                  {parsedError.duplicateKeys && parsedError.duplicateKeys.length > 0 ? (
                    <div className="mt-3">
                      <div className="text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
                        Duplicate project keys
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {parsedError.duplicateKeys.map((key) => (
                          <span
                            key={key}
                            className="rounded-full border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-primary)]"
                            style={{ fontFamily: "var(--font-mono)" }}
                          >
                            {key}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {parsedError.guidance ? (
                    <p className="mt-3 text-[11px] leading-5 text-[var(--color-text-secondary)]">
                      {parsedError.guidance}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-[4px] border border-[color-mix(in_srgb,var(--color-status-error)_18%,transparent)] bg-[var(--color-tint-red)] px-3 py-2 text-[11px] leading-5 text-[var(--color-status-error)]">
              {error}
            </div>
          )
        ) : null}

        {/* Path bar */}
        <div className="flex gap-2">
          <input
            type="text"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && pathInput.trim()) {
                void browse(pathInput.trim());
              }
            }}
            placeholder="/path/to/directory"
            className="min-w-0 flex-1 border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-3 py-1.5 text-[12px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-accent)] focus:outline-none"
            style={{ fontFamily: "var(--font-mono)", borderRadius: "2px" }}
          />
          <button
            type="button"
            onClick={() => pathInput.trim() && browse(pathInput.trim())}
            className="shrink-0 border border-[var(--color-border-default)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-elevated-hover)]"
            style={{ borderRadius: "2px" }}
          >
            Go
          </button>
        </div>

        {/* Directory browser */}
        <div
          ref={scrollRef}
          className="h-[300px] overflow-y-auto border border-[var(--color-border-default)] bg-[var(--color-bg-surface)]"
          style={{ borderRadius: "2px" }}
        >
          {browsing && !browseResult ? (
            <div className="flex h-full items-center justify-center text-[12px] text-[var(--color-text-tertiary)]">
              Loading...
            </div>
          ) : browseError ? (
            <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-[var(--color-status-error)]">
              {browseError}
            </div>
          ) : browseResult ? (
            <div>
              <div className="border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] px-3 py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
                      Current folder
                    </div>
                    <div
                      className="mt-1 truncate text-[12px] font-medium text-[var(--color-text-primary)]"
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      {browseResult.path}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {browseResult.isGitRepo ? (
                      <Badge label="git" color="var(--color-status-working)" />
                    ) : (
                      <Badge label="new" color="var(--color-text-tertiary)" />
                    )}
                    {browseResult.hasConfig ? (
                      <Badge label="ao" color="var(--color-accent)" />
                    ) : null}
                  </div>
                </div>
              </div>

              {/* Parent directory row */}
              {browseResult.parent && (
                <button
                  type="button"
                  onClick={() => {
                    if (browseResult.parent) {
                      void browse(browseResult.parent);
                    }
                  }}
                  className="flex w-full items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2 text-left text-[12px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-elevated-hover)]"
                >
                  <ParentDirIcon />
                  <span style={{ fontFamily: "var(--font-mono)" }}>..</span>
                </button>
              )}

              {/* Subdirectories */}
              {browseResult.directories.length === 0 ? (
                <div className="px-3 py-6 text-center text-[12px] text-[var(--color-text-tertiary)]">
                  No subdirectories
                </div>
              ) : (
                browseResult.directories.map((entry) => (
                  <DirectoryRow
                    key={entry.path}
                    entry={entry}
                    onOpen={() => browse(entry.path)}
                  />
                ))
              )}
            </div>
          ) : null}
        </div>

        {/* Display name */}
        {selectedPath && (
          <div>
            <label className="mb-1 block text-[11px] font-medium text-[var(--color-text-tertiary)]">
              Display Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameManuallySet(true);
              }}
              placeholder="my-project"
              className="w-full border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-3 py-1.5 text-[12px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-accent)] focus:outline-none"
              style={{ borderRadius: "2px" }}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ── Subcomponents ──────────────────────────────────────────────── */

function DirectoryRow({
  entry,
  onOpen,
}: {
  entry: BrowseEntry;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group/dir flex w-full items-center border-b border-[var(--color-border-subtle)] text-left transition-colors hover:bg-[var(--color-bg-elevated-hover)]"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-[12px]">
        <FolderIcon selected={false} />
        <span
          className="truncate text-[var(--color-text-primary)]"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {entry.name}
        </span>
      </div>
      {entry.hasChildren && (
        <span className="flex h-full shrink-0 items-center px-2.5 py-2 text-[var(--color-text-tertiary)] opacity-0 transition-opacity group-hover/dir:opacity-100">
          <ChevronIcon />
        </span>
      )}
    </button>
  );
}

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="inline-flex items-center rounded-sm px-1.5 py-px text-[9px] font-medium uppercase tracking-wide"
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)` }}
    >
      {label}
    </span>
  );
}

/* ── Icons ──────────────────────────────────────────────────────── */

function FolderIcon({ selected }: { selected: boolean }) {
  return (
    <svg
      className="h-4 w-4 shrink-0"
      fill="none"
      stroke={selected ? "var(--color-accent)" : "var(--color-text-tertiary)"}
      strokeWidth="1.5"
      viewBox="0 0 24 24"
    >
      <path d="M3.75 7.5A1.75 1.75 0 0 1 5.5 5.75h4.1l1.75 1.75h7.15A1.75 1.75 0 0 1 20.25 9.25v8A1.75 1.75 0 0 1 18.5 19H5.5a1.75 1.75 0 0 1-1.75-1.75V7.5Z" />
    </svg>
  );
}

function MigrationNoticeIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path d="M12 8v4m0 4h.01" />
      <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.72 3h16.92a2 2 0 0 0 1.72-3L13.7 3.86a2 2 0 0 0-3.4 0Z" />
    </svg>
  );
}

function InlineSpinner({ inverse = false }: { inverse?: boolean }) {
  return (
    <svg
      className="h-3.5 w-3.5 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke={inverse ? "rgba(255,255,255,0.28)" : "currentColor"}
        strokeWidth="2"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke={inverse ? "currentColor" : "var(--color-accent)"}
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ParentDirIcon() {
  return (
    <svg className="h-4 w-4 shrink-0" fill="none" stroke="var(--color-text-tertiary)" strokeWidth="1.5" viewBox="0 0 24 24">
      <path d="m15 18-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
