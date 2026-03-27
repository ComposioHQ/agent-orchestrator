"use client";

import { type DashboardSession } from "@/lib/types";
import { CompactTopBar } from "./CompactTopBar";
import { ResizablePanes } from "./ResizablePanes";
import { usePaneSizes } from "./usePaneSizes";
import "./workspace.css";
import React, { type ReactNode, useState, useEffect } from "react";

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
    [20, 40, 40]
  );

  const [isMobile, setIsMobile] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(!isMobile);

  // Detect mobile
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  const panes = [
    { id: "files", label: "FILES", icon: "📁", defaultPercent: 20, minPercent: 8 },
    { id: "preview", label: "PREVIEW", icon: "📄", defaultPercent: 40, minPercent: 15 },
    { id: "terminal", label: "TERMINAL", icon: "▶", defaultPercent: 40, minPercent: 15 },
  ];

  const handleFileSelected = () => {
    if (isMobile) setSidebarOpen(false);
  };

  const handlePreviewClick = () => {
    if (isMobile && sidebarOpen) setSidebarOpen(false);
  };

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
      <div style={{ position: "relative", flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Mobile overlay */}
        {isMobile && sidebarOpen && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              backgroundColor: "rgba(0, 0, 0, 0.4)",
              zIndex: 10,
            }}
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Main panes */}
        <div
          style={{
            flex: 1,
            display: "flex",
            overflow: "hidden",
            position: isMobile ? "absolute" : "relative",
            width: isMobile ? "100%" : "auto",
            height: "100%",
            zIndex: isMobile ? 20 : "auto",
            left: isMobile && !sidebarOpen ? 0 : isMobile ? "-100%" : 0,
            transition: isMobile ? "left 0.3s ease-in-out" : "none",
          }}
        >
          <ResizablePanes
            panes={panes}
            sizes={sizes}
            collapsed={collapsed}
            setSizes={setSizes}
            toggleCollapsed={toggleCollapsed}
            showToggleButton={true}
          >
            <div className="workspace-file-tree">
              {React.cloneElement(children.fileTree as React.ReactElement, {
                onFileSelected: handleFileSelected,
              })}
            </div>
            <div className="workspace-preview-pane" onClick={handlePreviewClick}>
              {children.preview}
            </div>
            <div className="workspace-terminal-pane">{children.terminal}</div>
          </ResizablePanes>
        </div>
      </div>
    </div>
  );
}

// Add CSS class for preview pane
const style = document.createElement("style");
style.textContent = `
  .workspace-preview-pane {
    overflow: auto;
    height: 100%;
    display: flex;
    flex-direction: column;
  }
`;
if (typeof document !== "undefined") {
  document.head.appendChild(style);
}
