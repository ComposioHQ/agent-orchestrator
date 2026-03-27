"use client";

import { type DashboardSession } from "@/lib/types";
import { CompactTopBar } from "./CompactTopBar";
import { QuickOpen } from "./QuickOpen";
import { usePaneSizes } from "./usePaneSizes";
import "./workspace.css";
import { useSidebarContext } from "./SidebarContext";
import { loadSessionFileState, saveSessionFileState } from "./sessionFileState";
import { type ReactNode, useRef, useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";

interface WorkspaceLayoutProps {
  session: DashboardSession;
  children: {
    fileTree: (selectedFile: string | null) => ReactNode;
    preview: (selectedFile: string | null) => ReactNode;
    terminal: ReactNode;
  };
}

export function WorkspaceLayout({ session, children }: WorkspaceLayoutProps) {
  const { sizes, collapsed, setSizes, toggleCollapsed, isHydrated, verticalLayout, setVerticalLayout } = usePaneSizes(
    session.id,
    [20, 40, 40],
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const saveScrollTimeoutRef = useRef<number | null>(null);
  const restoredScrollForFileRef = useRef<string | null>(null);
  const searchParams = useSearchParams();
  const urlFile = searchParams.get("file");
  const prevFileRef = useRef<string | null>(null);
  const [quickOpenVisible, setQuickOpenVisible] = useState(false);
  const sidebarCtx = useSidebarContext();

  // Compute effective selected file: URL takes precedence, then storage
  const [restoredFile, setRestoredFile] = useState<string | null>(null);
  const lastSessionRef = useRef<string | null>(null);
  
  useEffect(() => {
    if (lastSessionRef.current !== session.id) {
      lastSessionRef.current = session.id;
      // Session changed - check storage for this session
      if (!urlFile) {
        const stored = loadSessionFileState(session.id);
        setRestoredFile(stored?.filePath ?? null);
      } else {
        setRestoredFile(null);
      }
    }
  }, [session.id, urlFile]);

  // URL file always wins; fall back to restored file from storage
  const selectedFile = urlFile ?? restoredFile;

  // CMD+P / Ctrl+P → open quick file search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "p") {
        e.preventDefault();
        setQuickOpenVisible((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Auto-collapse file tree when a file is selected
  useEffect(() => {
    if (selectedFile && selectedFile !== prevFileRef.current && !collapsed[0]) {
      toggleCollapsed(0);
    }
    prevFileRef.current = selectedFile;
  }, [selectedFile]); // intentionally exclude collapsed/toggleCollapsed to avoid loops

  // Restore preview scroll after file content loads
  useEffect(() => {
    if (!selectedFile) return;
    
    const stored = loadSessionFileState(session.id);
    const targetScroll = stored?.filePath === selectedFile ? stored.scrollTop : 0;
    
    if (restoredScrollForFileRef.current === `${session.id}:${selectedFile}`) return;
    restoredScrollForFileRef.current = `${session.id}:${selectedFile}`;
    
    if (targetScroll === 0) return;
    
    // Poll until content is loaded and scrollable
    let attempts = 0;
    const maxAttempts = 50;
    const intervalId = window.setInterval(() => {
      attempts++;
      const el = previewScrollRef.current;
      if (!el) return;
      
      const canScroll = el.scrollHeight > el.clientHeight;
      if (canScroll) {
        el.scrollTop = targetScroll;
        window.clearInterval(intervalId);
      } else if (attempts >= maxAttempts) {
        window.clearInterval(intervalId);
      }
    }, 100);
    
    return () => window.clearInterval(intervalId);
  }, [session.id, selectedFile]);

  useEffect(() => {
    return () => {
      if (saveScrollTimeoutRef.current !== null) {
        window.clearTimeout(saveScrollTimeoutRef.current);
      }
    };
  }, []);

  // Save scroll position on scroll (debounced)
  const handlePreviewScroll = useCallback(() => {
    if (!selectedFile || !previewScrollRef.current) return;
    
    if (saveScrollTimeoutRef.current !== null) {
      window.clearTimeout(saveScrollTimeoutRef.current);
    }
    
    saveScrollTimeoutRef.current = window.setTimeout(() => {
      if (!previewScrollRef.current || !selectedFile) return;
      saveSessionFileState(session.id, {
        filePath: selectedFile,
        scrollTop: previewScrollRef.current.scrollTop,
        updatedAt: Date.now(),
      });
    }, 200);
  }, [session.id, selectedFile]);

  const handleDragStart = useCallback((separatorIndex: number, direction: "horizontal" | "vertical", startX: number, startY: number) => {
    const isHorizontal = direction === "horizontal";
    const startPos = isHorizontal ? startX : startY;
    const containerSize = isHorizontal
      ? (containerRef.current?.clientWidth || 1)
      : (containerRef.current?.clientHeight || 1);
    const startSizes = [...sizes];
    const mins = [8, 15, 15];

    function applyDelta(currentPos: number) {
      const deltaPct = ((currentPos - startPos) / containerSize) * 100;
      const newSizes = [...startSizes];
      newSizes[separatorIndex] = Math.max(mins[separatorIndex], startSizes[separatorIndex] + deltaPct);
      newSizes[separatorIndex + 1] = Math.max(
        mins[separatorIndex + 1],
        startSizes[separatorIndex + 1] - deltaPct,
      );
      setSizes(newSizes);
    }

    function onMouseMove(moveEvent: MouseEvent) {
      applyDelta(isHorizontal ? moveEvent.clientX : moveEvent.clientY);
    }
    function onTouchMove(moveEvent: TouchEvent) {
      if (moveEvent.touches.length !== 1) return;
      moveEvent.preventDefault();
      applyDelta(isHorizontal ? moveEvent.touches[0].clientX : moveEvent.touches[0].clientY);
    }

    function cleanup() {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", cleanup);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", cleanup);
      document.removeEventListener("touchcancel", cleanup);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", cleanup);
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", cleanup);
    document.addEventListener("touchcancel", cleanup);
    document.body.style.cursor = isHorizontal ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  }, [sizes, setSizes]);

  const onSeparatorMouse = useCallback((idx: number, dir: "horizontal" | "vertical", e: React.MouseEvent) => {
    e.preventDefault();
    handleDragStart(idx, dir, e.clientX, e.clientY);
  }, [handleDragStart]);

  const onSeparatorTouch = useCallback((idx: number, dir: "horizontal" | "vertical", e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    handleDragStart(idx, dir, e.touches[0].clientX, e.touches[0].clientY);
  }, [handleDragStart]);

  const filesVisible = !collapsed[0];
  const previewVisible = !collapsed[1];
  const terminalVisible = !collapsed[2];

  // Build a 1D grid template from an array of {visible, size} panes
  function buildTemplate(panes: { visible: boolean; size: number }[]): string {
    const parts: string[] = [];
    const expandedTotal = panes.reduce((sum, p) => sum + (p.visible ? p.size : 0), 0) || 1;
    let first = true;
    for (const pane of panes) {
      if (!pane.visible) continue;
      if (!first) parts.push("4px");
      const normalized = (pane.size / expandedTotal) * 100;
      parts.push(`${normalized}fr`);
      first = false;
    }
    return parts.join(" ") || "1fr";
  }

  // In horizontal mode: all 3 panes are columns
  // In vertical mode: file tree is left column, preview+terminal stack vertically in right column
  function getGridTemplate(): string {
    if (verticalLayout) {
      // Only file tree and the right column (which itself is a vertical split)
      const leftPanes = [{ visible: filesVisible, size: sizes[0] }];
      const rightVisible = previewVisible || terminalVisible;
      const rightPanes = [{ visible: rightVisible, size: sizes[1] + sizes[2] }];
      return buildTemplate([...leftPanes, ...rightPanes]);
    }
    return buildTemplate([
      { visible: filesVisible, size: sizes[0] },
      { visible: previewVisible, size: sizes[1] },
      { visible: terminalVisible, size: sizes[2] },
    ]);
  }

  function getVerticalTemplate(): string {
    return buildTemplate([
      { visible: previewVisible, size: sizes[1] },
      { visible: terminalVisible, size: sizes[2] },
    ]);
  }

  // Ensure preview pane is visible when a file is opened
  const ensurePreviewVisible = useCallback(() => {
    if (collapsed[1]) {
      toggleCollapsed(1);
    }
  }, [collapsed, toggleCollapsed]);

  const topBarProps = {
    session,
    collapsed,
    toggleCollapsed,
    verticalLayout,
    onToggleVertical: () => setVerticalLayout(!verticalLayout),
    onToggleSidebar: sidebarCtx?.onToggleSidebar,
  };

  if (!isHydrated) {
    return (
      <div className="workspace-container">
        <CompactTopBar {...topBarProps} />
        <div
          style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <div style={{ color: "var(--color-text-secondary)", fontSize: "14px" }}>Loading...</div>
        </div>
      </div>
    );
  }

  const fileTreePane = filesVisible && (
    <div style={{ display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
      <div className="workspace-pane-header">
        <span>FILES</span>
      </div>
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>{children.fileTree(selectedFile)}</div>
    </div>
  );

  const previewFileName = selectedFile ? selectedFile.split("/").pop() : null;

  const previewPane = previewVisible && (
    <div style={{ display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0, minWidth: 0 }}>
      <div className="workspace-pane-header">
        <span>PREVIEW</span>
        {previewFileName && (
          <span style={{
            marginLeft: "8px",
            fontWeight: 400,
            fontSize: "11px",
            color: "var(--color-text-secondary)",
            letterSpacing: "normal",
            textTransform: "none",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {previewFileName}
          </span>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: "2px", marginLeft: "auto" }}>
          <button
            onClick={() => setQuickOpenVisible(true)}
            title="Search files (Ctrl+P)"
            className="workspace-pane-header-btn"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
        </div>
      </div>
      <div
        ref={previewScrollRef}
        onScroll={handlePreviewScroll}
        style={{ flex: 1, overflow: "auto", minHeight: 0 }}
      >
        {children.preview(selectedFile)}
      </div>
    </div>
  );

  const terminalPane = terminalVisible && (
    <div style={{ display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0, minWidth: 0 }}>
      <div className="workspace-terminal-content">{children.terminal}</div>
    </div>
  );

  const quickOpen = (
    <QuickOpen
      sessionId={session.id}
      open={quickOpenVisible}
      onClose={() => setQuickOpenVisible(false)}
      onFileSelected={ensurePreviewVisible}
    />
  );

  // Vertical layout: file tree | [preview / terminal stacked vertically]
  if (verticalLayout) {
    const rightVisible = previewVisible || terminalVisible;
    return (
      <div className="workspace-container">
        <CompactTopBar {...topBarProps} />
        <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>
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
            {fileTreePane}
            {filesVisible && rightVisible && (
              <div className="workspace-separator" onMouseDown={(e) => onSeparatorMouse(0, "horizontal", e)} onTouchStart={(e) => onSeparatorTouch(0, "horizontal", e)} />
            )}
            {rightVisible && (
              <div style={{ display: "grid", gridTemplateRows: getVerticalTemplate(), overflow: "hidden", minHeight: 0 }}>
                {previewPane}
                {previewVisible && terminalVisible && (
                  <div className="workspace-separator workspace-separator--horizontal" onMouseDown={(e) => onSeparatorMouse(1, "vertical", e)} onTouchStart={(e) => onSeparatorTouch(1, "vertical", e)} />
                )}
                {terminalPane}
              </div>
            )}
          </div>
        </div>
        {quickOpen}
      </div>
    );
  }

  // Horizontal layout (default): file tree | preview | terminal side by side
  return (
    <div className="workspace-container">
      <CompactTopBar {...topBarProps} />
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>
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
          {fileTreePane}
          {filesVisible && (previewVisible || terminalVisible) && (
            <div className="workspace-separator" onMouseDown={(e) => onSeparatorMouse(0, "horizontal", e)} onTouchStart={(e) => onSeparatorTouch(0, "horizontal", e)} />
          )}
          {previewPane}
          {previewVisible && terminalVisible && (
            <div className="workspace-separator" onMouseDown={(e) => onSeparatorMouse(1, "horizontal", e)} onTouchStart={(e) => onSeparatorTouch(1, "horizontal", e)} />
          )}
          {terminalPane}
        </div>
      </div>
      {quickOpen}
    </div>
  );
}
