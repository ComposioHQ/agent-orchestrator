"use client";

import { useFileContent } from "./useFileContent";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { highlightFileContentByLines, languageForFilePath } from "./codeHighlight";

interface FilePreviewProps {
  sessionId: string;
  selectedFile: string | null;
}

function CodeViewer({ content, fileName }: { content: string; fileName: string }) {
  const lines = content.split("\n");
  const gutterWidth = String(lines.length).length;

  const lang = languageForFilePath(fileName);
  const highlightedLines = lang ? highlightFileContentByLines(content, lang) : null;

  return (
    <pre className="workspace-code-viewer">
      {lines.map((line, i) => (
        <div key={i} className="workspace-code-line">
          <span className="workspace-code-gutter">{String(i + 1).padStart(gutterWidth)}</span>
          {highlightedLines ? (
            <span
              className="workspace-code-content"
              dangerouslySetInnerHTML={{ __html: highlightedLines[i] ?? "" }}
            />
          ) : (
            <span className="workspace-code-content">{line}</span>
          )}
        </div>
      ))}
    </pre>
  );
}

function UnsupportedPreview({ message, size }: { error: string; message: string; size: number }) {
  return (
    <div className="workspace-empty-state">
      <span className="workspace-empty-icon">🚫</span>
      <p>{message}</p>
      {size > 0 && (
        <p style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}>
          ({(size / 1024 / 1024).toFixed(1)} MB)
        </p>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="workspace-empty-state">
      <span className="workspace-empty-icon">📄</span>
      <p>Select a file from the tree to preview</p>
    </div>
  );
}

export function FilePreview({ sessionId, selectedFile }: FilePreviewProps) {
  const { data, error, loading } = useFileContent(sessionId, selectedFile);

  if (!selectedFile) {
    return <EmptyState />;
  }

  if (loading) {
    return (
      <div className="workspace-empty-state">
        <span className="workspace-empty-icon">⏳</span>
        <p>Loading...</p>
      </div>
    );
  }

  if (error) {
    return (
      <UnsupportedPreview
        error={error.error}
        message={error.message}
        size={error.size}
      />
    );
  }

  if (!data) {
    return <EmptyState />;
  }

  const isMarkdown = data.path.endsWith(".md");

  return (
    <>
      {isMarkdown ? (
        <div className="workspace-markdown-preview">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
          >
            {data.content}
          </ReactMarkdown>
        </div>
      ) : (
        <CodeViewer content={data.content} fileName={data.path} />
      )}
    </>
  );
}
