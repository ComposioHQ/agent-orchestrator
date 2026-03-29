"use client";

import { useState } from "react";

/**
 * True catch-all error boundary — catches errors in the root layout itself.
 * Must render full <html> and <body> since it replaces the root layout.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <html lang="en" className="dark">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#0a0d12",
          color: "#eef3ff",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <div style={{ textAlign: "center", maxWidth: 480, padding: 24 }}>
          {/* Terminal icon with error dot */}
          <svg
            style={{ marginBottom: 16, width: 32, height: 32, color: "#ef4444" }}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            viewBox="0 0 24 24"
          >
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <path d="M6 9l4 3-4 3M13 15h5" />
            <circle cx="19" cy="7" r="3" fill="#ef4444" stroke="none" />
          </svg>

          <h2 style={{ fontSize: 15, fontWeight: 500, marginBottom: 8 }}>
            Something went wrong
          </h2>
          <p style={{ fontSize: 13, color: "#6f7c94", marginBottom: 24 }}>
            An unexpected error occurred. Please try again or reload the page.
          </p>

          <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
            <button
              onClick={() => reset()}
              style={{
                padding: "8px 16px",
                fontSize: 13,
                fontWeight: 500,
                border: "1px solid #272a2f",
                borderRadius: 6,
                backgroundColor: "#1a1d22",
                color: "#eef3ff",
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: "8px 16px",
                fontSize: 13,
                fontWeight: 500,
                border: "1px solid #272a2f",
                borderRadius: 6,
                backgroundColor: "#1a1d22",
                color: "#eef3ff",
                cursor: "pointer",
              }}
            >
              Reload page
            </button>
            <a
              href="/"
              style={{
                padding: "8px 16px",
                fontSize: 13,
                fontWeight: 500,
                border: "1px solid #272a2f",
                borderRadius: 6,
                backgroundColor: "#1a1d22",
                color: "#eef3ff",
                textDecoration: "none",
                display: "inline-block",
                cursor: "pointer",
              }}
            >
              Go to dashboard
            </a>
          </div>

          <div style={{ marginTop: 24 }}>
            <button
              onClick={() => setShowDetails((prev) => !prev)}
              style={{
                fontSize: 12,
                color: "#6f7c94",
                textDecoration: "underline",
                textDecorationStyle: "dotted",
                textUnderlineOffset: 2,
                background: "none",
                border: "none",
                cursor: "pointer",
              }}
            >
              {showDetails ? "Hide" : "Show"} technical details
            </button>
            {showDetails && (
              <pre
                style={{
                  marginTop: 12,
                  maxWidth: 480,
                  overflow: "auto",
                  borderRadius: 6,
                  border: "1px solid #272a2f",
                  backgroundColor: "#141720",
                  padding: 12,
                  textAlign: "left",
                  fontSize: 11,
                  color: "#6f7c94",
                  fontFamily: "monospace",
                }}
              >
                {error.digest ? `Digest: ${error.digest}\n\n` : ""}
                {error.message}
                {"\n\n"}
                {error.stack}
              </pre>
            )}
          </div>
        </div>
      </body>
    </html>
  );
}
