import type { ReactNode } from "react";
import { isLinuxPlatform, isMacPlatform } from "../lib/platform";
import { cn } from "../lib/utils";
import { useUiStore } from "../stores/ui-store";
import { SessionTopbarPortal } from "./SessionTopbarPortal";

const isMac = isMacPlatform();
const isLinux = isLinuxPlatform();

export function SessionTerminalBar({
	children,
	fullscreen = false,
}: {
	children: ReactNode;
	fullscreen?: boolean;
}) {
	const isSidebarOpen = useUiStore((state) => state.isSidebarOpen);
	const row = (
		<div
			className={cn(
				"flex h-inspector-tabs w-full shrink-0 items-stretch bg-sidebar",
				!fullscreen && !isSidebarOpen && isMac && "pl-titlebar-content-offset",
				!fullscreen &&
					!isSidebarOpen &&
					isLinux &&
					"pl-[calc(var(--size-titlebar-cluster-width)+var(--size-titlebar-content-gap))]",
			)}
			data-testid="session-terminal-bar"
		>
			{children}
		</div>
	);

	return fullscreen ? row : <SessionTopbarPortal>{row}</SessionTopbarPortal>;
}
