import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import { getProjectName } from "@/lib/project-name";
import { getSelfProjectId } from "@/lib/self-project";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import "./globals.css";

const ibmPlexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  variable: "--font-ibm-plex-sans",
  display: "swap",
  weight: ["300", "400", "500", "600", "700"],
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-ibm-plex-mono",
  display: "swap",
  weight: ["300", "400", "500"],
});

export async function generateMetadata(): Promise<Metadata> {
  const projectName = getProjectName();
  return {
    title: {
      template: `%s | ${projectName}`,
      default: `ao | ${projectName}`,
    },
    description: "Dashboard for managing parallel AI coding agents",
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const selfProjectId = getSelfProjectId();

  return (
    <html lang="en" suppressHydrationWarning className={`dark ${ibmPlexSans.variable} ${ibmPlexMono.variable}`}>
      <body className="bg-[var(--color-bg-base)] text-[var(--color-text-primary)] antialiased">
        <ErrorBoundary selfProjectId={selfProjectId}>
          {children}
        </ErrorBoundary>
      </body>
    </html>
  );
}
