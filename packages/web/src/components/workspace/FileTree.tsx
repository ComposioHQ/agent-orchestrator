"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useFileTree } from "./useFileTree";
import type { FileNode } from "@/app/api/sessions/[id]/files/route";
import { filterTreeToChanged } from "./fileTreeFilter";

export { filterTreeToChanged } from "./fileTreeFilter";

type GitStatus = "M" | "A" | "D" | "?" | "R";

function getGitStatusColor(status: GitStatus): string {
  switch (status) {
    case "A":
    case "?":
      return "#3fb950";
    case "M":
      return "#d29922";
    case "D":
      return "#f85149";
    default:
      return "transparent";
  }
}

function getGitStatusLabel(status: GitStatus): string {
  switch (status) {
    case "A": return "A";
    case "M": return "M";
    case "D": return "D";
    case "?": return "U";
    case "R": return "R";
    default: return "";
  }
}

function getDirGitColor(node: FileNode, gitStatus: Record<string, GitStatus>): string | undefined {
  if (node.type !== "directory" || !node.children) return undefined;
  let hasModified = false;
  let hasAdded = false;
  for (const child of node.children) {
    const s = gitStatus[child.path];
    if (s === "M") hasModified = true;
    if (s === "A" || s === "?") hasAdded = true;
    if (child.type === "directory") {
      const childColor = getDirGitColor(child, gitStatus);
      if (childColor === "#d29922") hasModified = true;
      if (childColor === "#3fb950") hasAdded = true;
    }
  }
  if (hasModified) return "#d29922";
  if (hasAdded) return "#3fb950";
  return undefined;
}

interface FileTreeItemProps {
  node: FileNode;
  selectedFile: string | null;
  gitStatus: Record<string, GitStatus>;
  depth: number;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  onSelectFile: (path: string) => void;
}

function FileTreeNode({
  node,
  selectedFile,
  gitStatus,
  depth,
  expandedFolders,
  onToggleFolder,
  onSelectFile,
}: FileTreeItemProps) {
  const indent = 8 + depth * 5;

  if (node.type === "file") {
    const status = gitStatus[node.path];
    const isSelected = selectedFile === node.path;
    const nameColor = status ? getGitStatusColor(status) : undefined;

    const fileIcon = node.name.endsWith(".md") || node.name.endsWith(".mdx") ? "📝" : "📄";

    return (
      <div
        className={`workspace-file-tree-item ${isSelected ? "workspace-file-tree-item--selected" : ""}`}
        style={{ paddingLeft: `${indent + 16}px` }}
        onClick={() => onSelectFile(node.path)}
      >
        <span className="workspace-file-tree-icon">{fileIcon}</span>
        <span className="workspace-file-tree-name" style={nameColor ? { color: nameColor } : undefined}>
          {node.name}
        </span>
        {status && (
          <span className="workspace-file-tree-badge" style={{ color: getGitStatusColor(status) }}>
            {getGitStatusLabel(status)}
          </span>
        )}
      </div>
    );
  }

  // Directory
  const isExpanded = expandedFolders.has(node.path);
  const dirColor = getDirGitColor(node, gitStatus);

  return (
    <div>
      <div
        className="workspace-file-tree-item"
        style={{ paddingLeft: `${indent}px` }}
        onClick={() => onToggleFolder(node.path)}
      >
        <span className={`workspace-file-tree-chevron ${isExpanded ? "workspace-file-tree-chevron--open" : ""}`}>
          ▶
        </span>
        <span className="workspace-file-tree-icon">{isExpanded ? "📂" : "📁"}</span>
        <span className="workspace-file-tree-name" style={dirColor ? { color: dirColor } : undefined}>
          {node.name}
        </span>
      </div>
      {isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              selectedFile={selectedFile}
              gitStatus={gitStatus}
              depth={depth + 1}
              expandedFolders={expandedFolders}
              onToggleFolder={onToggleFolder}
              onSelectFile={onSelectFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface FileTreeProps {
  sessionId: string;
  selectedFile: string | null;
  onFileSelected?: () => void;
  showChangedOnly?: boolean;
}

export function FileTree({ sessionId, selectedFile, onFileSelected, showChangedOnly }: FileTreeProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { tree, gitStatus, loading, error } = useFileTree(sessionId);

  // Maintain user-toggled folders as state
  const [userExpanded, setUserExpanded] = useState<Set<string>>(new Set());

  // Auto-expand parents of selected file
  useEffect(() => {
    if (!selectedFile) return;
    const parts = selectedFile.split("/");
    const parents: string[] = [];
    for (let i = 0; i < parts.length - 1; i++) {
      parents.push(parts.slice(0, i + 1).join("/"));
    }
    if (parents.length > 0) {
      setUserExpanded((prev) => {
        const next = new Set(prev);
        for (const p of parents) next.add(p);
        return next;
      });
    }
  }, [selectedFile]);

  const handleToggleFolder = useCallback((path: string) => {
    setUserExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleSelectFile = useCallback(
    (path: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("file", path);
      router.push(`/sessions/${encodeURIComponent(sessionId)}?${params.toString()}`);
      onFileSelected?.();
    },
    [router, sessionId, searchParams, onFileSelected],
  );

  if (error) {
    return (
      <div style={{ padding: "12px", color: "var(--color-text-secondary)", fontSize: "12px" }}>
        Error: {error}
      </div>
    );
  }

  if (loading && tree.length === 0) {
    return (
      <div style={{ padding: "12px", color: "var(--color-text-secondary)", fontSize: "12px" }}>
        Loading files...
      </div>
    );
  }

  const displayTree = showChangedOnly ? filterTreeToChanged(tree, gitStatus) : tree;

  if (displayTree.length === 0) {
    return (
      <div style={{ padding: "12px", color: "var(--color-text-secondary)", fontSize: "12px" }}>
        {showChangedOnly ? "No changed files" : "No files found"}
      </div>
    );
  }

  return (
    <div className="workspace-file-tree-list">
      {displayTree.map((node) => (
        <FileTreeNode
          key={node.path}
          node={node}
          selectedFile={selectedFile}
          gitStatus={gitStatus}
          depth={0}
          expandedFolders={userExpanded}
          onToggleFolder={handleToggleFolder}
          onSelectFile={handleSelectFile}
        />
      ))}
    </div>
  );
}
