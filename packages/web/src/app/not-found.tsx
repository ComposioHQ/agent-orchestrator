import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[var(--color-bg-base)]">
      <svg
        className="h-8 w-8 text-[var(--color-border-strong)]"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        viewBox="0 0 24 24"
      >
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="M6 9l4 3-4 3M13 15h5" />
      </svg>
      <p className="text-[13px] text-[var(--color-text-muted)]">
        Page not found
      </p>
      <Link
        href="/"
        className="text-[12px] text-[var(--color-accent)] hover:underline"
      >
        ← Back to dashboard
      </Link>
    </div>
  );
}
