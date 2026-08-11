import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
	title: "AO Cloud",
	description: "The hosted Agent Orchestrator workspace.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
	return (
		<html lang="en" className="dark">
			<body>{children}</body>
		</html>
	);
}
