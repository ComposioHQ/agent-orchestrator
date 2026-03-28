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
      <div className="workspace-empty-state">
        <span className="workspace-empty-icon">⏳</span>
        <p>Loading diff...</p>
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
