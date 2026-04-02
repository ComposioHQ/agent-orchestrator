"use client";

import { useDiffContent, type DiffContentResponse } from "./useDiffContent";
import { parseUnifiedDiff, syntheticUntrackedHunks, type DiffHunk, type DiffLine } from "./diffParse";
import { highlightDiffLine, languageForFilePath } from "./codeHighlight";

interface DiffViewerProps {
  sessionId: string;
  selectedFile: string | null;
}

function buildHunks(data: DiffContentResponse): DiffHunk[] {
  if (typeof data.diff === "string" && data.diff.length > 0) {
    return parseUnifiedDiff(data.diff);
  }
  if (typeof data.content === "string") {
    return syntheticUntrackedHunks(data.content);
  }
  return [];
}

function EmptyState() {
  return (
    <div className="workspace-empty-state">
      <span className="workspace-empty-icon">📄</span>
      <p>Select a changed file to view diff</p>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="workspace-empty-state">
      <span className="workspace-empty-icon">🚫</span>
      <p>{message}</p>
    </div>
  );
}

function DiffLineContent({ line, languageId }: { line: DiffLine; languageId: string | undefined }) {
  if (languageId && line.content.length > 0) {
    const html = highlightDiffLine(line.content, languageId);
    if (html !== null) {
      return (
        <span className="workspace-diff-content" dangerouslySetInnerHTML={{ __html: html }} />
      );
    }
  }
  return <span className="workspace-diff-content">{line.content}</span>;
}

export function DiffViewer({ sessionId, selectedFile }: DiffViewerProps) {
  const { data, error, loading } = useDiffContent(sessionId, selectedFile);

  if (!selectedFile) {
    return <EmptyState />;
  }

  if (loading) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-[var(--color-border-subtle)] px-4 py-2">
          <span className="font-mono text-[12px] text-[var(--color-text-secondary)]">
            {selectedFile}
          </span>
        </div>
        <div className="flex-1 p-4">
          <div className="space-y-2">
            {Array.from({ length: 10 }, (_, i) => (
              <div key={i} className="flex items-center gap-2">
                <div
                  className="h-3 w-6 shrink-0 animate-pulse rounded bg-[var(--color-border-subtle)]"
                  style={{ animationDelay: `${i * 50}ms` }}
                />
                <div
                  className="h-3 w-6 shrink-0 animate-pulse rounded bg-[var(--color-border-subtle)]"
                  style={{ animationDelay: `${i * 50}ms` }}
                />
                <div
                  className="h-3 w-4 shrink-0 animate-pulse rounded bg-[var(--color-tint-green)]/20"
                  style={{ animationDelay: `${i * 50}ms` }}
                />
                <div
                  className="h-3 animate-pulse rounded bg-[var(--color-border-subtle)]"
                  style={{
                    animationDelay: `${i * 50}ms`,
                    width: `${25 + Math.abs(Math.sin(i * 1.3)) * 50}%`,
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return <ErrorState message={error.message ?? error.error} />;
  }

  if (!data) {
    return <EmptyState />;
  }

  const hunks = buildHunks(data);
  const languageId = languageForFilePath(selectedFile);

  if (hunks.length === 0) {
    return (
      <div className="workspace-empty-state">
        <span className="workspace-empty-icon">✓</span>
        <p>No changes</p>
      </div>
    );
  }

  return (
    <pre className="workspace-diff-viewer">
      {hunks.map((hunk, i) => (
        <div key={i}>
          <div className="workspace-diff-hunk-header">{hunk.header}</div>
          {hunk.lines.map((line, j) => (
            <div key={j} className={`workspace-diff-line workspace-diff-line--${line.type}`}>
              <span className="workspace-diff-gutter workspace-diff-gutter--old">
                {line.oldLineNumber ?? ""}
              </span>
              <span className="workspace-diff-gutter workspace-diff-gutter--new">
                {line.newLineNumber ?? ""}
              </span>
              <span className="workspace-diff-marker">
                {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
              </span>
              <DiffLineContent line={line} languageId={languageId} />
            </div>
          ))}
        </div>
      ))}
    </pre>
  );
}
