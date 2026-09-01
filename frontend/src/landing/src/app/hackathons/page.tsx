import { COMPANY } from "@ao/shared/constants";
import {
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  CircleDot,
  Trophy,
  Users,
} from "lucide-react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

const pageUrl = `${COMPANY.MARKETING_URL}/hackathons/`;

export const metadata: Metadata = {
  title: "AO Hackathons",
  description:
    "Join upcoming AO hackathons and explore past community build sprints.",
  openGraph: {
    type: "website",
    url: pageUrl,
    siteName: COMPANY.NAME,
    title: `AO Hackathons | ${COMPANY.NAME}`,
    description:
      "Join upcoming AO hackathons and explore past community build sprints.",
    images: [
      {
        url: `${COMPANY.MARKETING_URL}/og-image.png`,
        width: 1200,
        height: 630,
        alt: `${COMPANY.NAME} hackathons`,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@aoagents",
    title: `AO Hackathons | ${COMPANY.NAME}`,
    description:
      "Join upcoming AO hackathons and explore past community build sprints.",
    images: [`${COMPANY.MARKETING_URL}/og-image.png`],
  },
  alternates: {
    canonical: pageUrl,
  },
};

const pastStats = [
  { icon: CalendarDays, label: "Aug 12-13", detail: "Two-day online sprint" },
  { icon: Users, label: "311 went", detail: "Community builders on Luma" },
  { icon: Trophy, label: "$200 prizes", detail: "Plus AO merch for standouts" },
] as const;

export default function HackathonsPage() {
  return (
    <main className="min-h-[100dvh] overflow-hidden bg-background text-foreground">
      <section className="relative px-4 pb-16 pt-16 sm:px-8 sm:pb-20 sm:pt-20 lg:px-[30px] lg:pb-24 lg:pt-24">
        <div className="pointer-events-none absolute inset-0 opacity-30">
          <Image
            src="/optimized/hero-background.webp"
            alt=""
            fill
            priority
            sizes="100vw"
            className="object-cover"
          />
        </div>
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_8%,rgba(210,86,17,0.2),transparent_32%),linear-gradient(to_bottom,rgba(24,24,22,0.08),var(--background)_78%)]" />

        <div className="relative mx-auto max-w-7xl">
          <div className="max-w-4xl">
            <div className="inline-flex items-center gap-2 rounded-3xl border border-border bg-background/70 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground backdrop-blur">
              <CalendarDays
                className="size-3.5 text-brand-light"
                aria-hidden="true"
              />
              AO Hackathons
            </div>
            <h1 className="mt-6 text-balance text-[clamp(44px,8vw,96px)] font-normal leading-[0.96] tracking-normal text-foreground">
              Build with agents, then show the work.
            </h1>
            <p className="mt-6 max-w-2xl text-pretty text-lg leading-8 text-muted-foreground sm:text-xl">
              Community build sprints for people turning AO into their coding
              workspace. Join the next run or look back at what builders already
              shipped.
            </p>
          </div>

          <div className="mt-12 grid gap-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)] lg:items-stretch">
            <article className="group relative overflow-hidden rounded-[8px] border border-border bg-card/85 backdrop-blur">
              <div className="absolute inset-0 opacity-45">
                <Image
                  src="/optimized/feature3.webp"
                  alt=""
                  fill
                  sizes="(max-width: 1024px) 100vw, 55vw"
                  className="object-cover transition-transform duration-700 group-hover:scale-[1.02]"
                />
              </div>
              <div className="absolute inset-0 bg-gradient-to-br from-background via-background/85 to-background/35" />
              <div className="relative flex min-h-[520px] flex-col justify-between p-6 sm:p-8 lg:p-10">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-2 rounded-3xl border border-brand/35 bg-brand/15 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-brand-light">
                      <CircleDot className="size-3" aria-hidden="true" />
                      Upcoming
                    </span>
                    <span className="rounded-3xl border border-border bg-background/70 px-3 py-1.5 text-sm text-muted-foreground">
                      Registration open
                    </span>
                  </div>
                  <h2 className="mt-7 max-w-2xl text-balance text-[clamp(34px,5vw,64px)] font-normal leading-[0.98] tracking-normal text-foreground">
                    Syndicate Hackathon
                  </h2>
                  <p className="mt-5 max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">
                    A build sprint for people using coding agents as a team
                    sport. Bring an idea worth handing to a fleet.
                  </p>
                </div>

                <Link
                  href="/hackathons/syndicate"
                  className="mt-10 inline-flex w-fit items-center gap-2 rounded-3xl bg-primary px-5 py-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  View Syndicate
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
              </div>
            </article>

            <article className="rounded-[8px] border border-border bg-card/75 p-6 backdrop-blur sm:p-8 lg:p-10">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                    Past Hackathon
                  </p>
                  <h2 className="mt-4 text-3xl font-normal leading-tight tracking-normal text-foreground sm:text-4xl">
                    The Orchestra
                  </h2>
                </div>
                <a
                  href="https://luma.com/iw1v5erp"
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Open The Orchestra on Luma"
                  className="inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <ArrowUpRight className="size-4" aria-hidden="true" />
                </a>
              </div>

              <p className="mt-5 text-base leading-7 text-muted-foreground">
                AO's first hackathon was a fully online sprint with no fixed
                theme. Builders used AO to plan, delegate, code, review, test,
                and ship with agents running on their own machines.
              </p>

              <div className="mt-8 grid gap-3">
                {pastStats.map((item) => {
                  const Icon = item.icon;
                  return (
                    <div
                      key={item.label}
                      className="flex items-center gap-4 rounded-[8px] border border-border bg-background/50 p-4"
                    >
                      <Icon
                        className="size-5 shrink-0 text-brand-light"
                        aria-hidden="true"
                      />
                      <div>
                        <div className="text-sm font-medium tracking-normal text-foreground">
                          {item.label}
                        </div>
                        <div className="mt-1 text-sm text-muted-foreground">
                          {item.detail}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-8 flex flex-wrap gap-2">
                {["Teams up to 4", "Demo video required", "Public repo required"].map(
                  (item) => (
                    <span
                      key={item}
                      className="rounded-3xl border border-border px-3 py-1.5 text-sm text-muted-foreground"
                    >
                      {item}
                    </span>
                  ),
                )}
              </div>
            </article>
          </div>
        </div>
      </section>
    </main>
  );
}
