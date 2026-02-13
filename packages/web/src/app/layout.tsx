import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Orchestrator",
  description: "Dashboard for managing parallel AI coding agents",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] antialiased">
        {children}
      </body>
    </html>
  );
}
