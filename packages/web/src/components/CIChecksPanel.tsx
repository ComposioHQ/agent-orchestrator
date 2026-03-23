"use client";

import type { DashboardCICheck } from "@/lib/types";
import { CICheckList } from "./CIBadge";

interface CIChecksPanelProps {
  checks: DashboardCICheck[];
}

export function CIChecksPanel({ checks }: CIChecksPanelProps) {
  if (checks.length === 0) return null;

  const failedChecks = checks.filter((c) => c.status === "failed");

  return (
    <div className="mt-4 border-t border-[var(--color-border-subtle)] pt-4">
      <CICheckList
        checks={checks}
        layout={failedChecks.length > 0 ? "expanded" : "inline"}
      />
    </div>
  );
}
