"use client";

import { type DashboardSession } from "@/lib/types";
import { CompactTopBar } from "./CompactTopBar";
import { usePaneSizes } from "./usePaneSizes";
import "./workspace.css";
import { type ReactNode, useRef, useEffect } from "react";
import { useSearchParams } from "next/navigation";

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
    [20, 40, 40],
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const searchParams = useSearchParams();
  const selectedFile = searchParams.get("file");
  const prevFileRef = useRef<string | null>(null);

  // Auto-collapse file tree when a file is selected
  useEffect(() => {
    if (selectedFile && selectedFile !== prevFileRef.current && !collapsed[0]) {
      toggleCollapsed(0);
    }
    prevFileRef.current = selectedFile;
  }, [selectedFile]); // intentionally exclude collapsed/toggleCollapsed to avoid loops

  const handleDragStart = (separatorIndex: number, e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const containerWidth = containerRef.current?.clientWidth || 1;
    const startSizes = [...sizes];
    const mins = [8, 15, 15];

    function onMouseMove(moveEvent: MouseEvent) {
      const deltaX = moveEvent.clientX - startX;
      const deltaPct = (deltaX / containerWidth) * 100;
      const newSizes = [...startSizes];
      newSizes[separatorIndex] = Math.max(mins[separatorIndex], startSizes[separatorIndex] + deltaPct);
      newSizes[separatorIndex + 1] = Math.max(
        mins[separatorIndex + 1],
        startSizes[separatorIndex + 1] - deltaPct,
      );
      setSizes(newSizes);
    }

    function onMouseUp() {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  // Files and terminal collapse into a side icon strip; preview always visible
  const filesVisible = !collapsed[0];
  const terminalVisible = !collapsed[2];

  // Compute grid columns for visible panes only
  function getGridTemplate(): string {
    const parts: string[] = [];
    const visiblePanes = [
      { visible: filesVisible, size: sizes[0] },
      { visible: true, size: sizes[1] }, // preview always visible
      { visible: terminalVisible, size: sizes[2] },
    ];

    const expandedTotal = visiblePanes.reduce((sum, p) => sum + (p.visible ? p.size : 0), 0);
    let first = true;

    for (let i = 0; i < visiblePanes.length; i++) {
      if (!visiblePanes[i].visible) continue;
      if (!first) {
        parts.push("4px"); // separator
      }
      const normalized = (visiblePanes[i].size / expandedTotal) * 100;
      parts.push(`${normalized}fr`);
      first = false;
    }
    return parts.join(" ");
  }

  if (!isHydrated) {
    return (
      <div className="workspace-container">
        <CompactTopBar session={session} />
        <div
          style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <div style={{ color: "var(--color-text-secondary)", fontSize: "14px" }}>Loading...</div>
        </div>
      </div>
    );
  }

  // Determine separator indices for the visible panes
  // (need to know which "gap" corresponds to which separator)
  const visiblePaneIndices: number[] = [];
  if (filesVisible) visiblePaneIndices.push(0);
  visiblePaneIndices.push(1); // preview always
  if (terminalVisible) visiblePaneIndices.push(2);

  return (
    <div className="workspace-container">
      <CompactTopBar session={session} />
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>
        {/* Left icon strip — file tree toggle + terminal toggle */}
        <div
          style={{
            width: "40px",
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            paddingTop: "8px",
            gap: "4px",
            borderRight: "1px solid var(--color-border-subtle)",
            background: "var(--color-bg-surface)",
          }}
        >
          <button
            onClick={() => toggleCollapsed(0)}
            title={filesVisible ? "Hide file tree" : "Show file tree"}
            style={{
              background: filesVisible ? "rgba(255,255,255,0.06)" : "none",
              border: "none",
              cursor: "pointer",
              fontSize: "16px",
              padding: "6px",
              borderRadius: "4px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: filesVisible ? "var(--color-text-primary)" : "var(--color-text-tertiary)",
              transition: "all 0.15s",
            }}
          >
            📁
          </button>
          <button
            onClick={() => toggleCollapsed(2)}
            title={terminalVisible ? "Hide terminal" : "Show terminal"}
            style={{
              background: terminalVisible ? "rgba(255,255,255,0.06)" : "none",
              border: "none",
              cursor: "pointer",
              fontSize: "16px",
              padding: "6px",
              borderRadius: "4px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: terminalVisible ? "var(--color-text-primary)" : "var(--color-text-tertiary)",
              transition: "all 0.15s",
            }}
          >
            ▶
          </button>
        </div>

        {/* Main content area — resizable panes */}
        <div
          ref={containerRef}
          style={{
            flex: 1,
            display: "grid",
            gridTemplateColumns: getGridTemplate(),
            overflow: "hidden",
            minHeight: 0,
          }}
        >
          {/* File tree pane */}
          {filesVisible && (
            <>
              <div style={{ display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
                <div className="workspace-pane-header">
                  <span>FILES</span>
                </div>
                <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>{children.fileTree}</div>
              </div>
              {/* Separator between files and preview */}
              <div
                className="workspace-separator"
                onMouseDown={(e) => handleDragStart(0, e)}
              />
            </>
          )}

          {/* Preview pane — always visible */}
          <div style={{ display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
            <div className="workspace-pane-header">
              <span>PREVIEW</span>
            </div>
            <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>{children.preview}</div>
          </div>

          {/* Terminal pane */}
          {terminalVisible && (
            <>
              {/* Separator between preview and terminal */}
              <div
                className="workspace-separator"
                onMouseDown={(e) => handleDragStart(1, e)}
              />
              <div
                className="workspace-terminal-pane"
                style={{ display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}
              >
                <div className="workspace-pane-header">
                  <span>TERMINAL</span>
                </div>
                <div style={{ flex: 1, overflow: "hidden", minHeight: 0 }}>{children.terminal}</div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
