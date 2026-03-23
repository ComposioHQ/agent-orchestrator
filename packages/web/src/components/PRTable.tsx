import type { DashboardPR } from "@/lib/types";
import { PRTableRow } from "./PRStatus";

interface PRTableProps {
  openPRs: DashboardPR[];
}

export function PRTable({ openPRs }: PRTableProps) {
  if (openPRs.length === 0) return null;

  return (
    <div className="mx-auto max-w-[900px]">
      <h2 className="mb-3 px-1 text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
        Pull Requests
      </h2>
      <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--color-border-default)]">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-[var(--color-border-muted)]">
              {["PR", "Title", "Size", "CI", "Review", "Unresolved"].map((col) => (
                <th key={col} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {openPRs.map((pr) => (
              <PRTableRow key={pr.number} pr={pr} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
