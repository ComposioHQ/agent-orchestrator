interface RelativeTimeOptions {
  minUnit?: "second" | "minute";
  nowLabel?: string;
}

export function getRelativeTime(
  dateStr: string,
  { minUnit = "second", nowLabel = "just now" }: RelativeTimeOptions = {},
): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (minUnit === "second") {
    if (diffSec < 60) return `${diffSec}s ago`;
  } else if (diffSec < 60) {
    return nowLabel;
  }

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;

  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}
