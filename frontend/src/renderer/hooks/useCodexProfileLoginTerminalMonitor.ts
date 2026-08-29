import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useUiStore } from "../stores/ui-store";
import { ensureCodexProfiles, mergeCodexProfiles } from "./useCodexProfilesQuery";
import type { ShellTerminal } from "./useShellTerminals";

const loginCheckIntervalMs = 2_000;
const loginMonitorLifetimeMs = 15 * 60_000;

export function useCodexProfileLoginTerminalMonitor(
	terminals: ShellTerminal[],
	navigateToTerminals: () => void,
): void {
	const queryClient = useQueryClient();
	const monitor = useUiStore((state) => state.codexProfileLoginTerminal);
	const clearMonitor = useUiStore((state) => state.clearCodexProfileLoginTerminal);
	const seenHandle = useRef<string | null>(null);

	useEffect(() => {
		if (!monitor) {
			seenHandle.current = null;
			return;
		}
		if (terminals.some((terminal) => terminal.handleId === monitor.handleId)) {
			seenHandle.current = monitor.handleId;
			return;
		}
		if (seenHandle.current === monitor.handleId) {
			clearMonitor();
		}
	}, [clearMonitor, monitor, terminals]);

	useEffect(() => {
		if (!monitor) return;
		navigateToTerminals();
	}, [monitor?.startedAt, navigateToTerminals]);

	useEffect(() => {
		if (!monitor) return;
		let active = true;
		const check = async () => {
			if (Date.now() - monitor.startedAt >= loginMonitorLifetimeMs) {
				if (active) clearMonitor();
				return;
			}
			try {
				const next = await ensureCodexProfiles([monitor.profileId], true);
				if (!active) return;
				mergeCodexProfiles(queryClient, next);
				const profile = next.profiles.find((item) => item.id === monitor.profileId);
				if (profile?.authentication.state === "authorized") clearMonitor();
			} catch {
				// The next bounded poll retries transient daemon or Codex failures.
			}
		};
		void check();
		const interval = window.setInterval(() => void check(), loginCheckIntervalMs);
		return () => {
			active = false;
			window.clearInterval(interval);
		};
	}, [clearMonitor, monitor, queryClient]);
}
