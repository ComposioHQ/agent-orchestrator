import { ImageResponse } from "next/og";
import { getProjectName } from "@/lib/project-name";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

/** Derive a consistent hue from a string (0-360). */
function stringToHue(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = s.charCodeAt(i) + ((hash << 5) - hash);
  }
  return ((hash % 360) + 360) % 360;
}

export default function Icon() {
  const name = getProjectName();
  const initial = name.charAt(0).toUpperCase();
  const hue = stringToHue(name);

  return new ImageResponse(
    (
      <div
        style={{
          width: "32px",
          height: "32px",
          borderRadius: "6px",
          background: `hsl(${hue}, 60%, 45%)`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "white",
          fontSize: "20px",
          fontWeight: 700,
          fontFamily: "sans-serif",
        }}
      >
        {initial}
      </div>
    ),
    { ...size },
  );
}
