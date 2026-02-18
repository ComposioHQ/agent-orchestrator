"use client";

import { useEffect } from "react";
import { type DashboardSession, type AttentionLevel, getAttentionLevel } from "@/lib/types";

/**
 * Determine overall health from sessions.
 * - "green"  — all sessions working/done/pending, nothing needs attention
 * - "yellow" — some sessions need review or response
 * - "red"    — critical: sessions stuck, errored, or needing immediate action
 */
function computeHealth(sessions: DashboardSession[]): "green" | "yellow" | "red" {
  if (sessions.length === 0) return "green";

  let hasYellow = false;

  for (const session of sessions) {
    const level: AttentionLevel = getAttentionLevel(session);
    if (level === "respond") return "red";
    if (level === "review" || level === "merge") hasYellow = true;
  }

  return hasYellow ? "yellow" : "green";
}

const HEALTH_COLORS: Record<"green" | "yellow" | "red", string> = {
  green: "#22c55e",
  yellow: "#eab308",
  red: "#ef4444",
};

/** Generate an SVG favicon as a data URL with the given initial and color. */
function generateFaviconSvg(initial: string, color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
    <rect width="32" height="32" rx="6" fill="${color}"/>
    <text x="16" y="23" text-anchor="middle" fill="white" font-family="sans-serif" font-weight="700" font-size="20">${initial}</text>
  </svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

interface DynamicFaviconProps {
  sessions: DashboardSession[];
  projectName?: string;
}

/**
 * Client component that dynamically updates the browser favicon
 * based on system health (session attention levels).
 */
export function DynamicFavicon({ sessions, projectName = "A" }: DynamicFaviconProps) {
  const initial = projectName.charAt(0).toUpperCase();

  useEffect(() => {
    const health = computeHealth(sessions);
    const color = HEALTH_COLORS[health];
    const href = generateFaviconSvg(initial, color);

    // Find or create the favicon link element
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.type = "image/svg+xml";
    link.href = href;
  }, [sessions, initial]);

  return null;
}
