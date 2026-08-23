import { createHashHistory, createRouter } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { DaemonStartupLoader } from "./components/DaemonStartupLoader";
import { routeTree } from "./routeTree.gen";

// Hash history is required for Electron's file:// renderer origin — browser
// history would break on hard reload since there is no server to serve paths.
export function createAppRouter(queryClient: QueryClient) {
	return createRouter({
		history: createHashHistory(),
		routeTree,
		context: { queryClient },
		defaultPreload: "intent",
		// Parent route loaders probe the daemon before ShellLayout can mount.
		// Render the same viewport-wide startup screen during that gap so the
		// native window never exposes an empty frame before its shell appears.
		defaultPendingComponent: DaemonStartupLoader,
		defaultPendingMs: 0,
		// Always re-run loaders when a route is preloaded or visited so React
		// Query's cache is the single source of truth for staleness.
		defaultPreloadStaleTime: 0,
		scrollRestoration: true,
	});
}
