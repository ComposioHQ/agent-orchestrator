"use client";

import {
  COMPANY,
  HERO_SUBHEADLINE,
  TAGLINE,
} from "@ao/shared/constants";
import { Star } from "lucide-react";
import { useEffect, useState } from "react";
import { FaGithub, FaProductHunt } from "react-icons/fa";
import { track } from "@/lib/analytics";
import { DownloadButton } from "../DownloadButton";
import { ProductDemo } from "./components/ProductDemo";

const INSTALL_COMMAND = "brew install agentwrapper/tap/agent-orchestrator";
// Wraps at the path separators instead of mid-word once the pill goes two-line.
const INSTALL_COMMAND_PARTS = INSTALL_COMMAND.split("/");
// Product Hunt launch day closes at midnight Pacific Time on August 16, 2026.
const PRODUCT_HUNT_LAUNCH_END_MS = Date.parse("2026-08-16T07:00:00.000Z");

function formatStarCount(count: number) {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  }

  return count.toString();
}

function formatLaunchCountdown(now = Date.now()) {
  const remainingMs = PRODUCT_HUNT_LAUNCH_END_MS - now;

  if (remainingMs <= 0) return "Final hours";

  const totalSeconds = Math.floor(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

interface HeroSectionProps {
  initialStars: number | null;
}

export function HeroSection({ initialStars }: HeroSectionProps) {
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [launchCountdown, setLaunchCountdown] = useState("--:--:--");
  const stars = initialStars;

  const githubButtonLabel =
    stars === null
      ? "Stars on GitHub"
      : `${formatStarCount(stars)} Stars on GitHub`;

  const copyInstallCommand = async () => {
    if (!navigator.clipboard) return;

    await navigator.clipboard.writeText(INSTALL_COMMAND);
    // A copy is download intent that never touches a download button, so without
    // this the brew path is invisible in the acquisition funnel.
    track("install_command_copied", { method: "brew" });
    setCopiedCommand(true);
    window.setTimeout(() => setCopiedCommand(false), 1600);
  };

  useEffect(() => {
    const updateCountdown = () => setLaunchCountdown(formatLaunchCountdown());
    updateCountdown();

    const interval = window.setInterval(updateCountdown, 1000);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <div className="relative">
      <div className="relative flex flex-col items-center overflow-hidden pt-24 pb-8 sm:pt-32 sm:pb-10 lg:pt-36 lg:pb-12">
        <div className="relative w-full max-w-[1600px] mx-auto px-4 sm:px-8 lg:px-[30px]">
          <div className="flex flex-col items-center text-center">
            <div className="space-y-5 sm:space-y-7 select-none">
              <a
                href={COMPANY.PRODUCT_HUNT_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="group mx-auto inline-flex w-full max-w-[min(100%,78rem)] items-center justify-between gap-2.5 rounded-[1.75rem] border border-[#da552f]/45 bg-[#da552f]/[0.07] px-3 py-2.5 text-sm font-normal tracking-[-0.3px] text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] ring-1 ring-[#da552f]/10 transition-[background-color,border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-[#da552f]/70 hover:bg-[#da552f]/[0.11] hover:shadow-[0_18px_44px_-30px_rgba(218,85,47,0.85)] sm:w-auto sm:justify-center sm:gap-3 sm:rounded-[2rem] sm:px-5 sm:py-3 sm:text-lg"
              >
                <span className="flex min-w-0 items-center gap-2.5 sm:gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#da552f] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.22)] sm:size-10">
                    <FaProductHunt className="size-4.5 sm:size-5.5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 text-left leading-5 sm:leading-6 xl:whitespace-nowrap">
                    <span className="sm:hidden">
                      <span className="block">Live on Product Hunt today.</span>
                      <span className="block text-muted-foreground">An upvote or note would mean a lot.</span>
                    </span>
                    <span className="hidden sm:inline">Today, Agent Orchestrator is live on Product Hunt.</span>
                    <span className="hidden text-muted-foreground sm:inline"> An upvote or note would mean a lot.</span>
                  </span>
                </span>
                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[#da552f]/35 bg-background/70 px-2 py-1 font-mono text-[11px] tracking-[0.3px] text-[#ff805d] sm:gap-2 sm:px-3 sm:py-1.5 sm:text-sm">
                  <span className="size-1.5 rounded-full bg-[#da552f]" aria-hidden="true" />
                  <time dateTime="2026-08-16T00:00:00-07:00">{launchCountdown}</time>
                  <span className="hidden font-sans text-[10px] uppercase tracking-[0.14em] text-muted-foreground sm:inline">
                    left
                  </span>
                </span>
              </a>

              <h1 className="font-sans text-4xl sm:text-5xl md:text-6xl lg:text-[4.75rem] font-normal tracking-[-0.5px] leading-[0.98] text-foreground max-w-6xl mx-auto text-balance">
                {TAGLINE}
              </h1>
              <p
                id="hero-subheadline"
                className="text-base sm:text-xl font-normal leading-8 text-muted-foreground max-w-4xl mx-auto text-balance"
              >
                {HERO_SUBHEADLINE}
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-4 mt-6 sm:mt-8">
              <DownloadButton className="rounded-3xl" />
              <a
                href={COMPANY.GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={githubButtonLabel}
                className="inline-flex items-center gap-2.5 rounded-3xl border border-border bg-background px-5 py-2.5 sm:py-3 text-sm sm:text-base font-normal tracking-[-0.5px] text-foreground transition-colors hover:bg-muted"
              >
                <FaGithub className="size-4" aria-hidden="true" />
                <span>Star on GitHub</span>
                {stars !== null ? (
                  <span className="flex items-center gap-1 pl-0.5 text-muted-foreground">
                    <Star
                      className="size-3.5 fill-yellow-400 text-yellow-400"
                      aria-hidden="true"
                    />
                    <span className="tabular-nums">
                      {formatStarCount(stars)}
                    </span>
                  </span>
                ) : null}
              </a>
            </div>

            <a
              href="https://www.producthunt.com/products/agent-orchestrator?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-agent-orchestrator"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-flex rounded-[14px] transition-opacity hover:opacity-90"
            >
              <img
                alt="Agent Orchestrator - Run a fleet of coding agents. Ship like a team. | Product Hunt"
                className="h-[54px] w-[250px]"
                height="54"
                src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1215599&theme=light&t=1786778713789"
                width="250"
              />
            </a>

            <div className="landing-install-command mt-4">
              <button
                type="button"
                aria-label={`Copy brew install command: ${INSTALL_COMMAND}`}
                title="Click to copy"
                className="group flex min-h-11 w-full max-w-xl items-start gap-2 rounded-3xl border border-border bg-card/70 px-3 py-2.5 text-left font-mono text-xs tracking-[0.5px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground sm:w-auto sm:items-center sm:overflow-hidden sm:text-sm"
                onClick={copyInstallCommand}
              >
                <span className="text-foreground/40" aria-hidden="true">
                  $
                </span>
                <code className="min-w-0 flex-1 break-words whitespace-normal text-foreground/80 sm:flex-none sm:truncate sm:whitespace-nowrap">
                  {INSTALL_COMMAND_PARTS.map((part, index) => (
                    <span key={part}>
                      {index > 0 ? "/" : null}
                      {part}
                      {index < INSTALL_COMMAND_PARTS.length - 1 ? <wbr /> : null}
                    </span>
                  ))}
                </code>
                <span
                  className="ml-2 inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground transition-colors group-hover:text-foreground"
                  aria-hidden="true"
                >
                  <svg
                    className="h-3.5 w-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  >
                    <rect x="9" y="9" width="12" height="12" rx="2" />
                    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                  </svg>
                  {copiedCommand ? "Copied" : "Copy"}
                </span>
              </button>
            </div>
          </div>

          <div className="relative w-full max-w-7xl mx-auto mt-12 sm:mt-16 lg:mt-20">
            <ProductDemo />
          </div>
        </div>
      </div>
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-[100px]"
        style={{
          background:
            "linear-gradient(to bottom, rgba(0,0,0,0) 0%, var(--background) 100%)",
        }}
      />
    </div>
  );
}
