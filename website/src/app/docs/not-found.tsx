import Link from "next/link";

export default function DocsNotFound() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "60vh",
        gap: "1rem",
        textAlign: "center",
        padding: "2rem 1rem",
        width: "100%",
      }}
    >
      <p
        style={{
          fontSize: "3.5rem",
          fontWeight: 700,
          color: "var(--color-text-secondary)",
          margin: 0,
        }}
      >
        404
      </p>
      <p
        style={{
          color: "var(--color-text-secondary)",
          maxWidth: "28rem",
          fontSize: "0.875rem",
          margin: 0,
        }}
      >
        This docs page doesn&apos;t exist. It may have been moved or the URL
        might be incorrect.
      </p>
      <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.5rem" }}>
        <Link
          href="/docs"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "0.5rem 1.25rem",
            borderRadius: "0.5rem",
            fontSize: "0.875rem",
            fontWeight: 500,
            backgroundColor: "var(--color-accent-amber)",
            color: "#1a1918",
            textDecoration: "none",
          }}
        >
          Browse docs
        </Link>
        <Link
          href="/"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "0.5rem 1.25rem",
            borderRadius: "0.5rem",
            fontSize: "0.875rem",
            fontWeight: 500,
            border: "1px solid var(--color-border-default)",
            color: "var(--color-text-secondary)",
            textDecoration: "none",
          }}
        >
          Home
        </Link>
      </div>
    </div>
  );
}
