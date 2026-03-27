"use client";

import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useFileTree } from "./useFileTree";
import type { FileNode } from "@/app/api/sessions/[id]/files/route";

type GitStatus = "M" | "A" | "D" | "?" | "R";

interface FileTreeItemProps {
  node: FileNode;
  selectedFile: string | null;
  gitStatus: Record<string, GitStatus>;
  depth: number;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  onSelectFile: (path: string) => void;
}

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
  expandedFolders,
  onToggleFolder,
  onSelectFile,
}: FileTreeItemProps) {
  const status = gitStatus[node.path];

  if (node.type === "file") {
    const isSelected = selectedFile === node.path;
    return (
      <div
        className={`workspace-file-tree-item ${isSelected ? "selected" : ""}`}
        style={{
          paddingLeft: `${8 + depth * 16}px`,
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
  const isExpanded = expandedFolders.has(node.path);
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
          paddingLeft: `${8 + depth * 16}px`,
        }}
        onClick={() => onToggleFolder(node.path)}
      >
        <span
          className={`workspace-file-tree-folder-toggle ${isExpanded ? "expanded" : ""}`}
          style={{ color: dirColor }}
        >
          ▶
        </span>
        <span className="workspace-file-tree-item-icon">📁</span>
        <span className="workspace-file-tree-item-name" style={{ color: dirColor }}>
          {node.name}
        </span>
      </div>
      {isExpanded && node.children && (
        <div className="workspace-file-tree-children">
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
}

export function FileTree({ sessionId, selectedFile, onFileSelected }: FileTreeProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { tree, gitStatus, loading, error } = useFileTree(sessionId);

  // Compute which folders should be expanded based on selected file
  const expandedFolders = useMemo(() => {
    const folders = new Set<string>();
    if (!selectedFile) return folders;

    // Open all parent directories of the selected file
    const parts = selectedFile.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      folders.add(parts.slice(0, i + 1).join("/"));
    }
    return folders;
  }, [selectedFile]);

  const handleToggleFolder = useCallback((_path: string) => {
    // This is just for UI - the expandedFolders state is derived from selectedFile
  }, []);

  const handleSelectFile = useCallback(
    (path: string) => {
      const params = new URLSearchParams(searchParams);
      params.set("file", path);
      router.push(`/sessions/${sessionId}?${params.toString()}`);
      onFileSelected?.();
    },
    [router, sessionId, searchParams, onFileSelected]
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
          expandedFolders={expandedFolders}
          onToggleFolder={handleToggleFolder}
          onSelectFile={handleSelectFile}
        />
      ))}
    </div>
  );
}
