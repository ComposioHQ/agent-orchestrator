"use client";

import { ActivityDot } from "./ActivityDot";

interface ActivityDisplayProps {
  activity: string | null;
  label: string;
  color: string;
}

export function ActivityDisplay({ activity, label, color }: ActivityDisplayProps) {
  return (
    <div
      className="flex items-center gap-1.5 rounded-full px-2.5 py-0.5"
      style={{
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 20%, transparent)`,
      }}
    >
      <ActivityDot activity={activity} dotOnly size={6} />
      <span className="text-[11px] font-semibold" style={{ color }}>
        {label}
      </span>
    </div>
  );
}
