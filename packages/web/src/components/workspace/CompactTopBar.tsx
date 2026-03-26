"use client";

import { type DashboardSession } from "@/lib/types";
import { useRouter } from "next/navigation";

interface CompactTopBarProps {
  session: DashboardSession;
}

const activityMeta: Record<string, { label: string; color: string }> = {
  active: { label: "Active", color: "var(--color-status-working)" },
  ready: { label: "Ready", color: "var(--color-status-ready)" },
  idle: { label: "Idle", color: "var(--color-status-idle)" },
  waiting_input: { label: "Waiting for input", color: "var(--color-status-attention)" },
  blocked: { label: "Blocked", color: "var(--color-status-error)" },
  exited: { label: "Exited", color: "var(--color-status-error)" },
};

export function CompactTopBar({ session }: CompactTopBarProps) {
  const router = useRouter();
  const meta = (session.activity && activityMeta[session.activity]) || { label: session.activity ?? "unknown", color: "var(--color-text-secondary)" };

  return (
    <div
      style={{
        height: "40px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        paddingLeft: "12px",
        paddingRight: "12px",
        borderBottom: "1px solid var(--color-border-subtle)",
        background: "var(--color-bg-surface)",
        gap: "12px",
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flex: 1, minWidth: 0 }}>
        <button
          onClick={() => router.back()}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            fontSize: "18px",
            padding: "0",
            display: "flex",
            alignItems: "center",
            color: "var(--color-text-secondary)",
          }}
          title="Back"
        >
          ←
        </button>

        <span
          style={{
            fontSize: "12px",
            fontWeight: 600,
            color: "var(--color-text-primary)",
            whiteSpace: "nowrap",
          }}
        >
          {session.id}
        </span>

        <span style={{ color: "var(--color-border-subtle)" }}>·</span>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "4px",
            color: "var(--color-text-secondary)",
            fontSize: "11px",
          }}
        >
          <span style={{ color: meta.color, fontSize: "8px" }}>●</span>
          <span>{meta.label}</span>
        </div>

        {session.branch && (
          <>
            <span style={{ color: "var(--color-border-subtle)" }}>·</span>
            <span
              style={{
                fontSize: "11px",
                color: "var(--color-text-secondary)",
                fontFamily: "monospace",
                whiteSpace: "nowrap",
                cursor: "pointer",
              }}
              onClick={() => {
                if (session.branch) {
                  navigator.clipboard.writeText(session.branch);
                }
              }}
              title="Click to copy"
            >
              {session.branch}
            </span>
          </>
        )}

        {session.pr && (
          <>
            <span style={{ color: "var(--color-border-subtle)" }}>·</span>
            <a
              href={session.pr.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontSize: "11px",
                color: "var(--color-accent)",
                textDecoration: "none",
                whiteSpace: "nowrap",
              }}
            >
              PR #{session.pr.number}
            </a>
            {session.pr.additions !== undefined && session.pr.deletions !== undefined && (
              <span style={{ fontSize: "11px", color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>
                +{session.pr.additions} -{session.pr.deletions}
              </span>
            )}
          </>
        )}

        {session.pr?.ciStatus && (
          <>
            <span style={{ color: "var(--color-border-subtle)" }}>·</span>
            <span
              style={{
                fontSize: "11px",
                color:
                  session.pr.ciStatus === "passing"
                    ? "var(--color-status-ready)"
                    : session.pr.ciStatus === "failing"
                      ? "var(--color-status-error)"
                      : "var(--color-status-idle)",
                whiteSpace: "nowrap",
              }}
            >
              CI {session.pr.ciStatus === "passing" ? "✓" : session.pr.ciStatus === "failing" ? "✗" : "◌"}
            </span>
          </>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <button
          onClick={() => window.open(`/sessions/${session.id}`, "_blank")}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            fontSize: "14px",
            color: "var(--color-text-secondary)",
            padding: "4px",
          }}
          title="Open in new tab"
        >
          🔗
        </button>
        <button
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            fontSize: "14px",
            color: "var(--color-text-secondary)",
            padding: "4px",
          }}
          title="Settings"
        >
          ⚙
        </button>
      </div>
    </div>
  );
}
