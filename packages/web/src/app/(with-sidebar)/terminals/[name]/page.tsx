"use client";

import { useParams } from "next/navigation";
import { DirectTerminal } from "@/components/DirectTerminal";
import { useSidebarContext } from "@/components/workspace/SidebarContext";

export default function StandaloneTerminalPage() {
  const params = useParams();
  const name = params.name as string;
  const sidebarCtx = useSidebarContext();

  return (
    <div className="flex h-full flex-col">
      {/* Simple top bar */}
      <div className="compact-top-bar">
        <div className="compact-top-bar__left">
          {sidebarCtx?.onToggleSidebar && (
            <button
              type="button"
              onClick={sidebarCtx.onToggleSidebar}
              className="compact-top-bar__sidebar-toggle"
              title="Toggle sidebar"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="2" y1="4" x2="14" y2="4" />
                <line x1="2" y1="8" x2="14" y2="8" />
                <line x1="2" y1="12" x2="14" y2="12" />
              </svg>
            </button>
          )}
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--color-text-primary)",
            }}
          >
            Terminal: {decodeURIComponent(name)}
          </span>
        </div>
      </div>

      {/* Full-height terminal */}
      <div className="min-h-0 flex-1">
        <DirectTerminal
          sessionId={decodeURIComponent(name)}
          height="100%"
        />
      </div>
    </div>
  );
}
