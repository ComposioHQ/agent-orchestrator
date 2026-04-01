"use client";

import { useState } from "react";
import { stringToHue } from "@/lib/icon-renderer";

interface ProjectAvatarProps {
  projectId: string;
  name: string;
  size?: number;
  degraded?: boolean;
}

export function ProjectAvatar({ projectId, name, size = 24, degraded }: ProjectAvatarProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const initial = (name.charAt(0) || "?").toUpperCase();
  const hue = stringToHue(name);
  const borderRadius = Math.round(size * 0.23);
  const fontSize = Math.round(size * 0.42);
  const inset = Math.max(2, Math.round(size * 0.14));
  const innerRadius = Math.max(4, borderRadius - 2);

  if (degraded) {
    return (
      <span
        className="grid shrink-0 place-items-center border text-[var(--color-accent-red)] shadow-[inset_0_1px_0_rgba(255,255,255,0.22)]"
        style={{
          width: size,
          height: size,
          borderRadius,
          borderColor: "color-mix(in srgb, var(--color-accent-red) 20%, var(--color-border-subtle))",
          background:
            "linear-gradient(180deg, color-mix(in srgb, var(--color-tint-red) 82%, transparent), color-mix(in srgb, var(--color-tint-red) 52%, var(--color-bg-elevated)))",
        }}
      >
        <span className="font-[family-name:var(--font-mono)] text-[10px] font-semibold leading-none">
          !
        </span>
      </span>
    );
  }

  return (
    <span
      aria-label={`${name} icon`}
      className="relative grid shrink-0 place-items-center overflow-hidden border shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]"
      style={{
        width: size,
        height: size,
        borderRadius,
        borderColor: "var(--color-border-subtle)",
        background:
          "linear-gradient(180deg, color-mix(in srgb, var(--color-bg-elevated) 92%, white), var(--color-bg-surface))",
      }}
    >
      {!imageFailed ? (
        <span
          className="grid h-full w-full place-items-center overflow-hidden"
          style={{
            padding: inset,
            borderRadius: innerRadius,
            background: "color-mix(in srgb, var(--color-bg-base) 62%, transparent)",
          }}
        >
          <img
            src={`/api/projects/${encodeURIComponent(projectId)}/favicon`}
            alt=""
            className="h-full w-full object-contain"
            onError={() => setImageFailed(true)}
          />
        </span>
      ) : (
        <span
          className="grid h-full w-full place-items-center font-[family-name:var(--font-sans)] font-semibold text-white"
          style={{
            fontSize,
            background: `linear-gradient(135deg, hsl(${hue} 68% 52%), hsl(${(hue + 32) % 360} 58% 38%))`,
          }}
        >
          {initial}
        </span>
      )}
    </span>
  );
}
