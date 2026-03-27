"use client";

import React, { useRef, type ReactNode } from "react";

interface PaneConfig {
  id: string;
  label: string;
  icon: string;
  defaultPercent: number;
  minPercent: number;
}

interface ResizablePanesProps {
  panes: PaneConfig[];
  sizes: number[];
  collapsed: boolean[];
  setSizes: (sizes: number[]) => void;
  toggleCollapsed: (index: number) => void;
  children: ReactNode[];
  _showToggleButton?: boolean;
}

const PANE_DEFAULTS: Record<string, PaneConfig> = {
  files: { id: "files", label: "FILES", icon: "📁", defaultPercent: 20, minPercent: 8 },
  preview: { id: "preview", label: "PREVIEW", icon: "📄", defaultPercent: 40, minPercent: 15 },
  terminal: { id: "terminal", label: "TERMINAL", icon: "▶", defaultPercent: 40, minPercent: 15 },
};

function getGridColumns(sizes: number[], collapsed: boolean[]): string {
  const parts: string[] = [];
  const expandedTotal = sizes.reduce((sum, s, i) => sum + (collapsed[i] ? 0 : s), 0);

  for (let i = 0; i < sizes.length; i++) {
    if (i > 0) {
      parts.push(collapsed[i - 1] || collapsed[i] ? "0px" : "4px");
    }
    if (collapsed[i]) {
      parts.push("32px");
    } else {
      const normalized = (sizes[i] / expandedTotal) * 100;
      parts.push(`${normalized}fr`);
    }
  }
  return parts.join(" ");
}

export function ResizablePanes({
  panes,
  sizes,
  collapsed,
  setSizes,
  toggleCollapsed,
  children,
  _showToggleButton = false,
}: ResizablePanesProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const handleDragStart = (separatorIndex: number, e: React.MouseEvent) => {
    e.preventDefault();

    const startX = e.clientX;
    const containerWidth = containerRef.current?.clientWidth || 1;
    const startSizes = [...sizes];

    function onMouseMove(moveEvent: MouseEvent) {
      const deltaX = moveEvent.clientX - startX;
      const deltaPct = (deltaX / containerWidth) * 100;

      const newSizes = [...startSizes];
      const minLeft = PANE_DEFAULTS[panes[separatorIndex].id]?.minPercent || 8;
      const minRight = PANE_DEFAULTS[panes[separatorIndex + 1].id]?.minPercent || 8;

      newSizes[separatorIndex] = Math.max(minLeft, startSizes[separatorIndex] + deltaPct);
      newSizes[separatorIndex + 1] = Math.max(minRight, startSizes[separatorIndex + 1] - deltaPct);

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

  const gridColumns = getGridColumns(sizes, collapsed);

  return (
    <div
      ref={containerRef}
      className="workspace-panes"
      style={{
        display: "grid",
        gridTemplateColumns: gridColumns,
        height: "calc(100vh - 40px)",
        overflow: "hidden",
        gap: 0,
      }}
    >
      {panes.map((pane, idx) => (
        <React.Fragment key={pane.id}>
          {idx > 0 && (
            <div
              className="workspace-separator"
              onMouseDown={(e) => handleDragStart(idx - 1, e)}
              style={{
                cursor: "col-resize",
                background: "var(--color-border-subtle)",
                transition: "background 0.15s",
                opacity: collapsed[idx - 1] || collapsed[idx] ? 0 : 1,
                pointerEvents: collapsed[idx - 1] || collapsed[idx] ? "none" : "auto",
              }}
            />
          )}

          {collapsed[idx] ? (
            <div
              className="workspace-collapsed-strip"
              style={{
                width: "40px",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                paddingTop: "12px",
                paddingBottom: "12px",
                gap: "12px",
                background: "var(--color-bg-surface)",
                borderRight: idx < panes.length - 1 ? "1px solid var(--color-border-subtle)" : "none",
              }}
              title={`Show ${pane.label}`}
            >
              <button
                onClick={() => toggleCollapsed(idx)}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  fontSize: "20px",
                  padding: "4px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--color-text-secondary)",
                  transition: "color 0.2s",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.color = "var(--color-text-primary)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.color = "var(--color-text-secondary)";
                }}
              >
                {pane.icon}
              </button>
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
                background: "var(--color-bg)",
              }}
            >
              <div
                className="workspace-pane-header"
                style={{
                  minHeight: "32px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  paddingLeft: "12px",
                  paddingRight: "8px",
                  fontSize: "11px",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: "var(--color-text-tertiary)",
                  borderBottom: "1px solid var(--color-border-subtle)",
                  background: "var(--color-bg-surface)",
                  gap: "8px",
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span>{pane.icon}</span>
                  <span>{pane.label}</span>
                </span>
                <button
                  onClick={() => toggleCollapsed(idx)}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "var(--color-text-secondary)",
                    fontSize: "14px",
                    padding: "4px 6px",
                    display: "flex",
                    alignItems: "center",
                    transition: "color 0.2s",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.color = "var(--color-text-primary)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.color = "var(--color-text-secondary)";
                  }}
                  title={`Hide ${pane.label}`}
                >
                  {idx === 0 ? "«" : "»"}
                </button>
              </div>
              <div
                style={{
                  flex: 1,
                  overflow: "hidden",
                  display: "flex",
                  flexDirection: "column",
                  minHeight: 0,
                }}
              >
                {children[idx]}
              </div>
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}
