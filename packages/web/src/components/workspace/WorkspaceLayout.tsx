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
    fileTree: (
      selectedFile: string | null,
      opts: { showChangedOnly: boolean; onFileSelected: () => void },
    ) => ReactNode;
    preview: (selectedFile: string | null, opts: { diffMode: boolean }) => ReactNode;
    terminal: ReactNode;
  };
}

type FileSelectSource = "tree" | "quickopen" | "diff";

interface FileTreeSettings {
  autoCloseOnTreeSelect: boolean;
  autoCloseOnQuickOpen: boolean;
  autoCloseOnDiffSelect: boolean;
}

const FILE_TREE_SETTINGS_KEY = "workspace:file-tree-settings";
const DEFAULT_SETTINGS: FileTreeSettings = {
  autoCloseOnTreeSelect: false,
  autoCloseOnQuickOpen: false,
  autoCloseOnDiffSelect: false,
};

function loadFileTreeSettings(): FileTreeSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(FILE_TREE_SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveFileTreeSettings(settings: FileTreeSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FILE_TREE_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // ignore
  }
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
  const [showChangedOnly, setShowChangedOnly] = useState(false);
  const [fileTreeSettings, setFileTreeSettings] = useState<FileTreeSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsBtnRef = useRef<HTMLButtonElement>(null);
  const settingsPopoverRef = useRef<HTMLDivElement>(null);
  const fileSelectSourceRef = useRef<FileSelectSource | null>(null);
  const sidebarCtx = useSidebarContext();

  // Load settings from localStorage on mount
  useEffect(() => {
    setFileTreeSettings(loadFileTreeSettings());
  }, []);

  // Close settings popover when clicking outside
  useEffect(() => {
    if (!settingsOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        settingsPopoverRef.current && !settingsPopoverRef.current.contains(target) &&
        settingsBtnRef.current && !settingsBtnRef.current.contains(target)
      ) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [settingsOpen]);

  const updateSetting = useCallback((key: keyof FileTreeSettings, value: boolean) => {
    setFileTreeSettings((prev) => {
      const next = { ...prev, [key]: value };
      saveFileTreeSettings(next);
      return next;
    });
  }, []);

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
  const diffMode = showChangedOnly && !!selectedFile;

  // CMD+P / Ctrl+P → open quick file search
  // Cmd+Shift+F / Ctrl+Shift+F → toggle file tree
  // Cmd+Shift+P / Ctrl+Shift+P → toggle preview
  // Cmd+Shift+Z / Ctrl+Shift+Z → toggle terminal
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      // Cmd+P / Ctrl+P → quick open (lowercase p without shift)
      if (mod && !e.shiftKey && e.key === "p") {
        e.preventDefault();
        setQuickOpenVisible((v) => !v);
      }

      // Cmd+Shift+F / Ctrl+Shift+F → toggle file tree
      if (mod && e.shiftKey && e.key === "F") {
        e.preventDefault();
        toggleCollapsed(0);
      }

      // Cmd+Shift+P / Ctrl+Shift+P → toggle preview
      if (mod && e.shiftKey && e.key === "P") {
        e.preventDefault();
        toggleCollapsed(1);
      }

      // Cmd+Shift+Z / Ctrl+Shift+Z → toggle terminal
      if (mod && e.shiftKey && e.key === "Z") {
        e.preventDefault();
        toggleCollapsed(2);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleCollapsed]);
  useEffect(() => {
    const prev = prevFileRef.current;
    if (selectedFile && selectedFile !== prev && !collapsed[0]) {
      const source = fileSelectSourceRef.current;
      fileSelectSourceRef.current = null;
      const shouldClose =
        (source === "tree" && fileTreeSettings.autoCloseOnTreeSelect) ||
        (source === "quickopen" && fileTreeSettings.autoCloseOnQuickOpen) ||
        (source === "diff" && fileTreeSettings.autoCloseOnDiffSelect);
      if (shouldClose) {
        toggleCollapsed(0);
      }
    }
    prevFileRef.current = selectedFile;
  }, [selectedFile, fileTreeSettings, collapsed, toggleCollapsed]);

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
  function getGridTemplate(): string {
    return buildTemplate([
      { visible: filesVisible, size: sizes[0] },
      { visible: previewVisible, size: sizes[1] },
      { visible: terminalVisible, size: sizes[2] },
    ]);
  }

  // Vertical layout: top row = file tree + preview columns, bottom row = terminal full width
  // sizes[0] and sizes[1] control the file tree / preview column split (horizontal separator 0)
  // The row split between top and bottom uses sizes[1]+sizes[0] vs sizes[2] (vertical separator 1)
  function getVerticalRowTemplate(): string {
    const topVisible = filesVisible || previewVisible;
    return buildTemplate([
      { visible: topVisible, size: sizes[0] + sizes[1] },
      { visible: terminalVisible, size: sizes[2] },
    ]);
  }

  function getVerticalColumnTemplate(): string {
    return buildTemplate([
      { visible: filesVisible, size: sizes[0] },
      { visible: previewVisible, size: sizes[1] },
    ]);
  }

  // Ensure preview pane is visible when a file is opened
  const ensurePreviewVisible = useCallback(() => {
    if (collapsed[1]) {
      toggleCollapsed(1);
    }
  }, [collapsed, toggleCollapsed]);

  const onTreeFileSelected = useCallback(() => {
    fileSelectSourceRef.current = showChangedOnly ? "diff" : "tree";
    ensurePreviewVisible();
  }, [showChangedOnly, ensurePreviewVisible]);

  const onQuickOpenFileSelected = useCallback(() => {
    fileSelectSourceRef.current = "quickopen";
    ensurePreviewVisible();
  }, [ensurePreviewVisible]);

  useEffect(() => {
    if (diffMode && selectedFile) {
      ensurePreviewVisible();
    }
  }, [diffMode, selectedFile, ensurePreviewVisible]);

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
        <div style={{ display: "flex", alignItems: "center", gap: "2px", marginLeft: "auto", position: "relative" }}>
          <button
            type="button"
            ref={settingsBtnRef}
            onClick={() => setSettingsOpen((v) => !v)}
            title="File tree settings"
            className={`workspace-pane-header-btn ${settingsOpen ? "workspace-pane-header-btn--active" : ""}`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
            </svg>
          </button>
          {settingsOpen && (
            <div ref={settingsPopoverRef} className="workspace-file-tree-settings-popover">
              <div className="workspace-file-tree-settings-title">Auto-close file tree</div>
              {([
                { key: "autoCloseOnTreeSelect" as const, label: "On file tree select" },
                { key: "autoCloseOnQuickOpen" as const, label: "On quick open select" },
                { key: "autoCloseOnDiffSelect" as const, label: "On git diff select" },
              ]).map(({ key, label }) => (
                <label key={key} className="workspace-file-tree-settings-row">
                  <input
                    type="checkbox"
                    checked={fileTreeSettings[key]}
                    onChange={(e) => updateSetting(key, e.target.checked)}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => setShowChangedOnly((v) => !v)}
            title={showChangedOnly ? "Show all files" : "Show changed files only"}
            className={`workspace-pane-header-btn ${showChangedOnly ? "workspace-pane-header-btn--active" : ""}`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden>
              <text
                x="12"
                y="17"
                textAnchor="middle"
                fontSize="15"
                fill="currentColor"
                fontFamily="ui-sans-serif, system-ui, sans-serif"
              >
                Δ
              </text>
            </svg>
          </button>
        </div>
      </div>
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {children.fileTree(selectedFile, { showChangedOnly, onFileSelected: onTreeFileSelected })}
      </div>
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
        {children.preview(selectedFile, { diffMode })}
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
      onFileSelected={onQuickOpenFileSelected}
    />
  );

  // Vertical layout: [file tree | preview] on top, terminal full-width below
  if (verticalLayout) {
    const topVisible = filesVisible || previewVisible;
    return (
      <div className="workspace-container">
        <CompactTopBar {...topBarProps} />
        <div
          ref={containerRef}
          style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr", gridTemplateRows: getVerticalRowTemplate(), overflow: "hidden", minHeight: 0 }}
        >
          {topVisible && (
            <div style={{ display: "grid", gridTemplateColumns: getVerticalColumnTemplate(), overflow: "hidden", minHeight: 0 }}>
              {fileTreePane}
              {filesVisible && previewVisible && (
                <div className="workspace-separator" onMouseDown={(e) => onSeparatorMouse(0, "horizontal", e)} onTouchStart={(e) => onSeparatorTouch(0, "horizontal", e)} />
              )}
              {previewPane}
            </div>
          )}
          {topVisible && terminalVisible && (
            <div className="workspace-separator workspace-separator--horizontal" onMouseDown={(e) => onSeparatorMouse(1, "vertical", e)} onTouchStart={(e) => onSeparatorTouch(1, "vertical", e)} />
          )}
          {terminalPane}
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
