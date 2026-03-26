"use client";

import { useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useFileTree } from "./useFileTree";
import type { FileNode } from "@/app/api/sessions/[id]/files/route";

type GitStatus = "M" | "A" | "D" | "?" | "R";

interface FileTreeItemProps {
  node: FileNode;
  selectedFile: string | null;
  gitStatus: Record<string, GitStatus>;
  depth: number;
  onSelectFile: (path: string) => void;
}

function getGitStatusColor(status: GitStatus): string {
  switch (status) {
    case "A":
    case "?":
      return "#3fb950"; // green
    case "M":
      return "#d29922"; // yellow
    case "D":
      return "#f85149"; // red
    default:
      return "transparent";
  }
}

function getGitStatusLabel(status: GitStatus): string {
  switch (status) {
    case "A":
      return "A";
    case "M":
      return "M";
    case "D":
      return "D";
    case "?":
      return "?";
    case "R":
      return "R";
    default:
      return "";
  }
}

function FileTreeNode({
  node,
  selectedFile,
  gitStatus,
  depth,
  onSelectFile,
}: FileTreeItemProps) {
  const [expanded, setExpanded] = useState(true);
  const status = gitStatus[node.path];

  if (node.type === "file") {
    const isSelected = selectedFile === node.path;
    return (
      <div
        className={`workspace-file-tree-item ${isSelected ? "selected" : ""}`}
        style={{
          marginLeft: `${depth * 16}px`,
          backgroundColor: isSelected ? "var(--color-bg-selected)" : "transparent",
          color: isSelected ? "var(--color-accent)" : "var(--color-text-primary)",
        }}
        onClick={() => onSelectFile(node.path)}
      >
        <span className="workspace-file-tree-item-icon">📄</span>
        <span className="workspace-file-tree-item-name">{node.name}</span>
        {status && (
          <span
            className={`workspace-file-tree-item-status ${
              status === "M" ? "modified" : status === "A" || status === "?" ? "added" : "deleted"
            }`}
            style={{ color: getGitStatusColor(status) }}
          >
            {getGitStatusLabel(status)}
          </span>
        )}
      </div>
    );
  }

  // Directory
  const hasModifiedChildren = node.children?.some((child) => {
    const childStatus = gitStatus[child.path];
    return childStatus && childStatus !== "?";
  });

  const hasAddedChildren = node.children?.some((child) => {
    const childStatus = gitStatus[child.path];
    return childStatus === "A" || childStatus === "?";
  });

  const dirColor = hasAddedChildren ? "#3fb950" : hasModifiedChildren ? "#d29922" : "transparent";

  return (
    <div key={node.path}>
      <div
        className="workspace-file-tree-item"
        style={{
          marginLeft: `${depth * 16}px`,
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <span
          className={`workspace-file-tree-folder-toggle ${expanded ? "expanded" : ""}`}
          style={{ color: dirColor }}
        >
          ▶
        </span>
        <span className="workspace-file-tree-item-icon">📁</span>
        <span className="workspace-file-tree-item-name" style={{ color: dirColor }}>
          {node.name}
        </span>
      </div>
      {expanded && node.children && (
        <div className="workspace-file-tree-children">
          {node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              selectedFile={selectedFile}
              gitStatus={gitStatus}
              depth={depth + 1}
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
}

export function FileTree({ sessionId, selectedFile }: FileTreeProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { tree, gitStatus, loading, error } = useFileTree(sessionId);

  const handleSelectFile = useCallback(
    (path: string) => {
      const params = new URLSearchParams(searchParams);
      params.set("file", path);
      router.push(`/sessions/${sessionId}/workspace?${params.toString()}`);
    },
    [router, sessionId, searchParams]
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

  if (tree.length === 0) {
    return (
      <div style={{ padding: "12px", color: "var(--color-text-secondary)", fontSize: "12px" }}>
        No files found
      </div>
    );
  }

  return (
    <div className="workspace-file-tree">
      {tree.map((node) => (
        <FileTreeNode
          key={node.path}
          node={node}
          selectedFile={selectedFile}
          gitStatus={gitStatus}
          depth={0}
          onSelectFile={handleSelectFile}
        />
      ))}
    </div>
  );
}
