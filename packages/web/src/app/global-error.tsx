"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en" className="dark">
      <body style={{ backgroundColor: "#0d1117", color: "#e6edf3", fontFamily: "system-ui, sans-serif", margin: 0 }}>
        <div style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", padding: "24px" }}>
          <div style={{ maxWidth: 480 }}>
            <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 12 }}>Something went wrong</h1>
            <pre style={{ fontSize: 12, color: "#f85149", background: "rgba(0,0,0,0.3)", padding: 12, borderRadius: 6, overflow: "auto", maxHeight: 200 }}>
              {error.message}
            </pre>
            <button
              onClick={reset}
              style={{ marginTop: 16, padding: "8px 20px", borderRadius: 6, border: "1px solid #30363d", background: "transparent", color: "#e6edf3", cursor: "pointer", fontSize: 13 }}
            >
              Retry
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
