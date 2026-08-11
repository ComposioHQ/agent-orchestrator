import type { Metadata } from "next";
import { IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const ibmPlexMono = IBM_Plex_Mono({
	weight: ["300", "400", "500"],
	subsets: ["latin"],
	variable: "--font-ibm-plex-mono",
	display: "swap",
});

export const metadata: Metadata = {
	title: "AO Cloud",
	description: "The hosted Agent Orchestrator workspace.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
	return (
		<html lang="en" className={`dark ${ibmPlexMono.variable}`}>
			<body><Providers>{children}</Providers></body>
		</html>
	);
}
