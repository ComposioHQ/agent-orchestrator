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
		<div className="flex h-inspector-tabs w-full shrink-0 items-stretch bg-sidebar" data-testid="session-terminal-bar">
			{children}
		</div>
	);

	return fullscreen ? row : <SessionTopbarPortal>{row}</SessionTopbarPortal>;
}
