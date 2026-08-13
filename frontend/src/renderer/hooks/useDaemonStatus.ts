import { useEffect, useRef, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { aoBridge } from "../lib/bridge";
import { applyDaemonStatus, readDaemonStatus, type DaemonStatus } from "../lib/daemon-status";
import { queryClient as defaultQueryClient } from "../lib/query-client";
import { createEventTransport } from "../lib/event-transport";

const STATUS_REFRESH_MS = 2_000;
const READY_STATUS_REFRESH_MS = 10_000;

// Each poll answers with a fresh object even when nothing changed. Every
// consumer of this hook (including the app shell) would re-render per poll
// without a field-level equality bailout.
function sameDaemonStatus(a: DaemonStatus, b: DaemonStatus): boolean {
	return (
		a.state === b.state &&
		a.port === b.port &&
		a.pid === b.pid &&
		a.executablePath === b.executablePath &&
		a.workingDirectory === b.workingDirectory &&
		a.message === b.message &&
		a.details === b.details &&
		a.code === b.code &&
		a.exitCode === b.exitCode &&
		a.signal === b.signal
	);
}

export function useDaemonStatus(queryClient: QueryClient = defaultQueryClient) {
	const [status, setStatus] = useState<DaemonStatus>({ state: "stopped" });
	const statusRef = useRef(status);

	useEffect(() => {
		let active = true;
		let stopTransport: () => void = () => undefined;
		let refreshTimer: ReturnType<typeof setTimeout> | undefined;
		let statusVersion = 0;

		const clearRefresh = () => {
			if (refreshTimer) {
				clearTimeout(refreshTimer);
				refreshTimer = undefined;
			}
		};

		const refreshStatus = () => {
			clearRefresh();
			const requestVersion = ++statusVersion;
			void readDaemonStatus()
				.then((nextStatus) => {
					if (active && requestVersion === statusVersion) applyStatus(nextStatus);
				})
				.catch(() => {
					// IPC unavailable (browser preview, broken preload): stay on the
					// last known status and keep the recovery loop alive.
				})
				.finally(() => {
					if (!active || requestVersion !== statusVersion) return;
					scheduleRefresh(statusRef.current.state === "ready" ? READY_STATUS_REFRESH_MS : STATUS_REFRESH_MS);
				});
		};

		const scheduleRefresh = (delayMs = STATUS_REFRESH_MS) => {
			if (refreshTimer || !active) return;
			refreshTimer = setTimeout(refreshStatus, delayMs);
		};

		const applyStatus = (nextStatus: DaemonStatus) => {
			// Only point REST at the new port; the workspace refetch is the event
			// transport's job (it invalidates, debounced, on every daemon status).
			const unchanged = sameDaemonStatus(statusRef.current, nextStatus);
			if (!unchanged) statusRef.current = nextStatus;
			if (nextStatus.state === "ready" && nextStatus.port) {
				applyDaemonStatus(nextStatus);
				clearRefresh();
				scheduleRefresh(READY_STATUS_REFRESH_MS);
			} else {
				applyDaemonStatus(nextStatus);
				scheduleRefresh();
			}
			// Unchanged polls keep the previous object so consumers skip a render.
			if (!unchanged) setStatus(nextStatus);
		};

		refreshStatus();
		const refreshOnFocus = () => {
			refreshStatus();
		};
		const refreshOnVisibility = () => {
			if (document.visibilityState === "visible") refreshOnFocus();
		};
		window.addEventListener("focus", refreshOnFocus);
		document.addEventListener("visibilitychange", refreshOnVisibility);

		void Promise.resolve().then(() => {
			if (active) stopTransport = createEventTransport(queryClient).connect();
		});

		const stopStatusListener = aoBridge.daemon.onStatus((nextStatus) => {
			statusVersion += 1;
			applyStatus(nextStatus);
		});

		return () => {
			active = false;
			clearRefresh();
			window.removeEventListener("focus", refreshOnFocus);
			document.removeEventListener("visibilitychange", refreshOnVisibility);
			stopTransport();
			stopStatusListener();
		};
	}, [queryClient]);

	return status;
}
