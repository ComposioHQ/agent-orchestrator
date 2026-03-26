import type { ReactElement } from "react";

/** Derive a consistent hue from a string (0-360). */
export function stringToHue(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = s.charCodeAt(i) + ((hash << 5) - hash);
  }
  return ((hash % 360) + 360) % 360;
}

export function sanitizeIconName(rawName: string): string {
  return rawName.replace(/[^\w\s-]/g, "").slice(0, 50) || "AO";
}

/** Render a colored icon element with the first letter of the given name. */
export function renderIconElement(size: number, name: string): ReactElement {
  const initial = (name.charAt(0) || "A").toUpperCase();
  const hue = stringToHue(name);
  const borderRadius = Math.round(size * 0.19);
  const fontSize = Math.round(size * 0.625);

  return (
    <div
      style={{
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: `${borderRadius}px`,
        background: `hsl(${hue}, 60%, 45%)`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "white",
        fontSize: `${fontSize}px`,
        fontWeight: 700,
        fontFamily: "sans-serif",
      }}
    >
      {initial}
    </div>
  );
}
