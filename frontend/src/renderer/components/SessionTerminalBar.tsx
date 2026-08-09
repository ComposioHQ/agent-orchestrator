import type { ReactNode } from "react";
import { SessionTopbarPortal } from "./SessionTopbarPortal";

export function SessionTerminalBar({
	children,
	fullscreen = false,
}: {
	children: ReactNode;
	fullscreen?: boolean;
}) {
	const row = (
		<div
			className="session-terminal-bar flex h-inspector-tabs w-full shrink-0 items-stretch bg-sidebar"
			data-session-terminal-bar=""
			data-testid="session-terminal-bar"
		>
			{children}
		</div>
	);

	return fullscreen ? row : <SessionTopbarPortal>{row}</SessionTopbarPortal>;
}
