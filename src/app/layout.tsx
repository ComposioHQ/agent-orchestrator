import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
	title: "AO Cloud",
	description: "The hosted Agent Orchestrator workspace.",
	icons: { icon: "/ao-logo.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
	return (
		<html lang="en" className="dark">
			<body>{children}</body>
		</html>
	);
}
