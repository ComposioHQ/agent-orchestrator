/**
 * Square terminal-window glyph (prompt inside a square frame), for pane toggle chrome.
 */
export function TerminalToggleIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.25" />
      <path d="M4.25 7.25 5.75 8.5 4.25 9.75" />
      <line x1="6.75" y1="9.75" x2="9.75" y2="9.75" />
    </svg>
  );
}
