"use client";

import Link from "next/link";
import { track } from "@/lib/analytics";
import { isMacPlatform, Platform, usePlatform } from "../../hooks/useOS";

interface DownloadButtonProps {
  size?: "sm" | "md";
  className?: string;
  /**
   * Where on the page this button lives, e.g. "hero" or "footer".
   *
   * Without it every download click looks identical, so we cannot tell which
   * CTA earns them. GitHub's own counts cannot answer this either: they are
   * dominated by `latest-*.yml` update polls rather than installs.
   */
  placement?: string;
}

type DownloadPlatform = "apple" | "windows" | "linux";

function getDownloadPlatform(platform: Platform): DownloadPlatform {
  if (platform === Platform.Windows) return "windows";
  if (platform === Platform.Linux) return "linux";
  if (isMacPlatform(platform)) return "apple";
  return "apple";
}

function DownloadIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
      className="size-4 shrink-0"
      aria-hidden="true"
    >
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

export function DownloadButton({
  size = "md",
  className = "",
  placement = "unknown",
}: DownloadButtonProps) {
  const { platform } = usePlatform();
  const downloadPlatform = getDownloadPlatform(platform);
  const isMobile = platform === Platform.Mobile;
  const sizeClasses =
    size === "sm"
      ? "h-8 px-3 text-sm"
      : "px-3 sm:px-6 py-2 sm:py-3 text-sm sm:text-base";
  const buttonClasses = `bg-foreground text-background ${sizeClasses} rounded-2xl tracking-[-0.5px] font-semibold hover:opacity-90 transition-opacity flex items-center gap-2 whitespace-nowrap shrink-0 ${className}`;

  return (
    <Link
      href="/download"
      className={buttonClasses}
      onClick={() =>
        track("download_clicked", {
          platform: downloadPlatform,
          is_mobile: isMobile,
          placement,
          size,
        })
      }
    >
      <DownloadIcon />
      <span>Download AO</span>
    </Link>
  );
}
