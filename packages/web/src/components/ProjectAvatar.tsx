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

  if (degraded) {
    return (
      <span
        className="grid shrink-0 place-items-center rounded-[var(--radius-sm)] bg-[var(--color-tint-red)] text-[var(--color-accent-red)]"
        style={{ width: size, height: size }}
      >
        <span className="font-[family-name:var(--font-mono)] text-[11px] font-medium">!</span>
      </span>
    );
  }

  const initial = (name.charAt(0) || "?").toUpperCase();
  const hue = stringToHue(name);
  const borderRadius = Math.round(size * 0.19);
  const fontSize = Math.round(size * 0.46);

  return (
    <span
      aria-label={`${name} icon`}
      className="grid shrink-0 place-items-center overflow-hidden"
      style={
        imageFailed
          ? {
              width: size,
              height: size,
              borderRadius,
              background: `hsl(${hue}, 60%, 45%)`,
            }
          : {
              width: size,
              height: size,
              borderRadius,
            }
      }
    >
      {!imageFailed ? (
        <img
          src={`/api/projects/${encodeURIComponent(projectId)}/favicon`}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <span
          className="font-[family-name:var(--font-sans)] font-semibold text-white/90"
          style={{ fontSize }}
        >
          {initial}
        </span>
      )}
    </span>
  );
}
