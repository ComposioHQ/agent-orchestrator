"use client";

import { type DashboardSession } from "@/lib/types";
import { CompactTopBar } from "./CompactTopBar";
import { ResizablePanes } from "./ResizablePanes";
import { usePaneSizes } from "./usePaneSizes";
import "./workspace.css";
import React, { type ReactNode } from "react";

interface WorkspaceLayoutProps {
  session: DashboardSession;
  children: {
    fileTree: ReactNode;
    preview: ReactNode;
    terminal: ReactNode;
  };
}

export function WorkspaceLayout({ session, children }: WorkspaceLayoutProps) {
  const { sizes, collapsed, setSizes, toggleCollapsed, isHydrated } = usePaneSizes(
    session.id,
    [20, 40, 40] // Default sizes: 20% files, 40% preview, 40% terminal
  );

  const panes = [
    { id: "files", label: "FILES", icon: "📁", defaultPercent: 20, minPercent: 8 },
    { id: "preview", label: "PREVIEW", icon: "📄", defaultPercent: 40, minPercent: 15 },
    { id: "terminal", label: "TERMINAL", icon: "▶", defaultPercent: 40, minPercent: 15 },
  ];

  // Don't render panes until hydrated to avoid layout shift
  if (!isHydrated) {
    return (
      <div className="workspace-container">
        <CompactTopBar session={session} />
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ color: "var(--color-text-secondary)", fontSize: "14px" }}>Loading...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="workspace-container">
      <CompactTopBar session={session} />
      <ResizablePanes
        panes={panes}
        sizes={sizes}
        collapsed={collapsed}
        setSizes={setSizes}
        toggleCollapsed={toggleCollapsed}
      >
        {/* File Tree */}
        <div className="workspace-file-tree">{children.fileTree}</div>
        {/* Preview */}
        <div className="workspace-markdown-preview">{children.preview}</div>
        {/* Terminal */}
        <div className="workspace-terminal-pane">{children.terminal}</div>
      </ResizablePanes>
    </div>
  );
}
