import { ImageResponse } from "next/og";
import { getProjectName } from "@/lib/project-name";
import { renderIconElement, sanitizeIconName } from "@/lib/icon-renderer";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  const name = sanitizeIconName(getProjectName());
  return new ImageResponse(renderIconElement(180, name), { ...size });
}
