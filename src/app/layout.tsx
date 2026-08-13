import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
	title: "AO Cloud",
	description: "The hosted Agent Orchestrator workspace.",
	icons: { icon: "/ao-logo.svg" },
};

const themeInitScript = `(function(){try{var t=localStorage.getItem("ao.theme");var s=localStorage.getItem("ao.theme-style");var r=t==="light"||t==="dark"?t:t==="system"?(window.matchMedia("(prefers-color-scheme:light)").matches?"light":"dark"):"dark";document.documentElement.dataset.theme=r;document.documentElement.style.colorScheme=r;if(s&&s!=="orchestrate")document.documentElement.dataset.styleTheme=s}catch(e){}})()`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
			</head>
			<body>{children}</body>
		</html>
	);
}
