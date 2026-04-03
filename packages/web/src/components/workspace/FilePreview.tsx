"use client";

import dynamic from "next/dynamic";
import { useFileContent } from "./useFileContent";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { highlightFileContentByLines, languageForFilePath } from "./codeHighlight";

const MermaidDiagram = dynamic(
  () => import("./MermaidDiagram").then((m) => ({ default: m.MermaidDiagram })),
  { ssr: false }
);

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
      <div className="flex h-full flex-col">
        <div className="border-b border-[var(--color-border-subtle)] px-4 py-2">
          <span className="font-mono text-[12px] text-[var(--color-text-secondary)]">
            {selectedFile}
          </span>
        </div>
        <div className="flex-1 p-4">
          <div className="space-y-2">
            {Array.from({ length: 12 }, (_, i) => (
              <div key={i} className="flex items-center gap-3">
                <div
                  className="h-3 w-8 shrink-0 animate-pulse rounded bg-[var(--color-border-subtle)]"
                  style={{ animationDelay: `${i * 50}ms` }}
                />
                <div
                  className="h-3 animate-pulse rounded bg-[var(--color-border-subtle)]"
                  style={{
                    animationDelay: `${i * 50}ms`,
                    width: `${30 + Math.abs(Math.sin(i * 1.5)) * 55}%`,
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
            components={{
              code({ className, children, ...props }) {
                if (className === "language-mermaid") {
                  return <MermaidDiagram code={String(children).trim()} />;
                }
                return <code className={className} {...props}>{children}</code>;
              },
            }}
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
