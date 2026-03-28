import { ImageResponse } from "next/og";
import { getProjectName } from "@/lib/project-name";
import { renderIconElement, sanitizeIconName } from "@/lib/icon-renderer";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  const name = sanitizeIconName(getProjectName());
  return new ImageResponse(renderIconElement(32, name), { ...size });
}
