/**
 * Skeleton shell for the session detail page.
 *
 * Renders a stable layout placeholder (breadcrumb, header, terminal frame)
 * so the page doesn't shift when async data arrives. Used by both the
 * route-level loading.tsx and the client-side loading branch in page.tsx.
 */

import { cn } from "@/lib/cn";

function Bone({ className }: { className?: string }) {
  return (
    <div
      className={cn("animate-pulse rounded bg-[var(--color-bg-subtle)]", className)}
    />
  );
}

export function SessionDetailSkeleton() {
  return (
    <div className="min-h-screen bg-[var(--color-bg-base)]">
      <div className="mx-auto max-w-[1180px] px-5 py-5 lg:px-8">
        <main className="min-w-0">
          {/* Header skeleton matching .session-page-header */}
          <section className="session-page-header">
            {/* Breadcrumb row */}
            <div className="session-page-header__crumbs">
              <Bone className="h-3 w-16" />
              <span className="text-[var(--color-border-strong)]">/</span>
              <Bone className="h-3 w-24" />
            </div>

            {/* Main row: title + status pill */}
            <div className="session-page-header__main">
              <div className="session-page-header__identity">
                <Bone className="h-5 w-48" />
                <div className="session-page-header__meta">
                  <Bone className="h-6 w-16 rounded-full" />
                  <Bone className="h-5 w-28" />
                </div>
              </div>
            </div>
          </section>

          {/* Terminal section skeleton */}
          <section className="mt-5">
            <div className="mb-3 flex items-center gap-2">
              <Bone className="h-3 w-0.5" />
              <Bone className="h-3 w-20" />
            </div>
            <Bone className="h-[440px] w-full rounded" />
          </section>
        </main>
      </div>
    </div>
  );
}
