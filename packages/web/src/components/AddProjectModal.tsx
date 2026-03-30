"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Modal } from "./Modal";

interface AddProjectModalProps {
  open: boolean;
  onClose: () => void;
  onProjectAdded?: () => void;
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

export function AddProjectModal({ open, onClose, onProjectAdded }: AddProjectModalProps) {
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

  function selectDirectory(dirPath: string) {
    setSelectedPath(dirPath);
    setError(null);
  }

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

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Failed to add project (${res.status})`);
      }

      onProjectAdded?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add project");
    } finally {
      setSubmitting(false);
    }
  }, [selectedPath, name, onProjectAdded, onClose]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Open Project"
      size="md"
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            {selectedPath ? (
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
              className="bg-[var(--color-accent)] px-4 py-2 text-[12px] font-semibold text-[var(--color-text-inverse)] transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
              style={{ borderRadius: "2px", minHeight: 40 }}
            >
              {submitting ? "Adding..." : "Open"}
            </button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {error && (
          <div className="text-[12px] text-[var(--color-status-error)]">{error}</div>
        )}

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
              {/* Parent directory row */}
              {browseResult.parent && (
                <button
                  type="button"
                  onClick={() => browse(browseResult.parent!)}
                  className="flex w-full items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2 text-left text-[12px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-elevated-hover)]"
                >
                  <ParentDirIcon />
                  <span style={{ fontFamily: "var(--font-mono)" }}>..</span>
                </button>
              )}

              {/* Current directory — select this */}
              <button
                type="button"
                onClick={() => selectDirectory(browseResult.path)}
                className={`flex w-full items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2 text-left text-[12px] transition-colors ${
                  selectedPath === browseResult.path
                    ? "bg-[var(--color-accent-subtle)] text-[var(--color-accent)]"
                    : "text-[var(--color-text-primary)] hover:bg-[var(--color-bg-elevated-hover)]"
                }`}
              >
                <CurrentDirIcon selected={selectedPath === browseResult.path} />
                <span className="flex-1 font-medium" style={{ fontFamily: "var(--font-mono)" }}>
                  . <span className="font-normal text-[var(--color-text-tertiary)]">(this directory)</span>
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  {browseResult.isGitRepo && <Badge label="git" color="var(--color-status-working)" />}
                  {browseResult.hasConfig && <Badge label="ao" color="var(--color-accent)" />}
                </div>
              </button>

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
                    isSelected={selectedPath === entry.path}
                    onSelect={() => selectDirectory(entry.path)}
                    onNavigate={() => browse(entry.path)}
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
  isSelected,
  onSelect,
  onNavigate,
}: {
  entry: BrowseEntry;
  isSelected: boolean;
  onSelect: () => void;
  onNavigate: () => void;
}) {
  return (
    <div
      className={`group/dir flex items-center border-b border-[var(--color-border-subtle)] transition-colors ${
        isSelected
          ? "bg-[var(--color-accent-subtle)]"
          : "hover:bg-[var(--color-bg-elevated-hover)]"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-[12px]"
      >
        <FolderIcon selected={isSelected} />
        <span
          className={`truncate ${isSelected ? "font-medium text-[var(--color-accent)]" : "text-[var(--color-text-primary)]"}`}
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {entry.name}
        </span>
      </button>
      {entry.hasChildren && (
        <button
          type="button"
          onClick={onNavigate}
          className="flex h-full shrink-0 items-center px-2.5 py-2 text-[var(--color-text-tertiary)] opacity-0 transition-opacity hover:text-[var(--color-text-secondary)] group-hover/dir:opacity-100"
          aria-label={`Open ${entry.name}`}
        >
          <ChevronIcon />
        </button>
      )}
    </div>
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

function CurrentDirIcon({ selected }: { selected: boolean }) {
  return (
    <svg
      className="h-4 w-4 shrink-0"
      fill="none"
      stroke={selected ? "var(--color-accent)" : "var(--color-text-secondary)"}
      strokeWidth="1.5"
      viewBox="0 0 24 24"
    >
      <path d="M3.75 7.5A1.75 1.75 0 0 1 5.5 5.75h4.1l1.75 1.75h7.15A1.75 1.75 0 0 1 20.25 9.25v8A1.75 1.75 0 0 1 18.5 19H5.5a1.75 1.75 0 0 1-1.75-1.75V7.5Z" />
      <path d="m9 13 2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
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
