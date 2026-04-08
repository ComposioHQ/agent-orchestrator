export default function DashboardLoading() {
  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-[var(--color-bg-surface)]">
      {/* Header with title skeleton */}
      <div className="border-b border-[var(--color-border-subtle)] px-6 py-5">
        <div className="flex items-center justify-between">
          <div>
            <div
              className="mb-2 h-6 w-32 animate-pulse rounded"
              style={{ background: "var(--color-bg-hover)" }}
            />
            <div
              className="h-4 w-48 animate-pulse rounded"
              style={{ background: "var(--color-bg-hover)" }}
            />
          </div>
          <div
            className="h-8 w-24 animate-pulse rounded"
            style={{ background: "var(--color-bg-hover)" }}
          />
        </div>
      </div>

      {/* Kanban columns skeleton */}
      <div className="flex flex-1 gap-4 overflow-x-auto p-6">
        {[1, 2, 3, 4].map((col) => (
          <div key={col} className="flex min-w-[300px] flex-col gap-3">
            {/* Column header */}
            <div
              className="h-5 w-20 animate-pulse rounded"
              style={{ background: "var(--color-bg-hover)" }}
            />

            {/* Card placeholders */}
            {[1, 2, 3].map((card) => (
              <div
                key={card}
                className="rounded border border-[var(--color-border-subtle)] p-4"
              >
                <div
                  className="mb-3 h-4 w-3/4 animate-pulse rounded"
                  style={{ background: "var(--color-bg-hover)" }}
                />
                <div
                  className="h-3 w-full animate-pulse rounded"
                  style={{ background: "var(--color-bg-hover)" }}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
