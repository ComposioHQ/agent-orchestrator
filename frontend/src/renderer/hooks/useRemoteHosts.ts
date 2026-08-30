import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteHealth } from "../../main/remote-request";
import { aoBridge } from "../lib/bridge";
import { reportHostConnect } from "../lib/host-telemetry";
import { useUiStore } from "../stores/ui-store";

export const LOCAL_HOST_ID = "local";

// Re-exported, not re-declared: probe() returns whatever the main process says,
// so a second hand-written copy of this union can only drift out of agreement
// with the values actually arriving over the bridge.
export type { RemoteHealth };

/** Every health a probe can report, plus the two states no probe produces. */
export type HostStatus = "local" | "checking" | RemoteHealth;

/**
 * Whether a probe came back bad. Written as "not one of the good ones" so a
 * health added later is unselectable until someone decides otherwise — the safe
 * default, since selecting a host that cannot serve only fails a step later.
 */
export function probeFailed(status: HostStatus): boolean {
	return status !== "local" && status !== "checking" && status !== "online";
}

/** What the main process is allowed to hand the renderer — never the password. */
export type RemoteHostView = { label: string; url: string };

export type Host = {
	id: string;
	label: string;
	/** null for the local daemon — the app already knows how to reach it. */
	url: string | null;
	status: HostStatus;
};

/** The preload bridge's saved-host surface: list, add, probe, request. */
export function remotesBridge() {
	return aoBridge.remotes;
}

export function useRemoteHosts(): { hosts: Host[]; refresh: () => Promise<void> } {
	const { t } = useTranslation();
	const localHost: Host = { id: LOCAL_HOST_ID, label: t("hosts.local"), url: null, status: "local" };
	const [remotes, setRemotes] = useState<Host[]>([]);
	// Off means no saved host is listed or probed — the flag is a network
	// boundary, not a visibility toggle.
	const enabled = useUiStore((state) => state.remoteHosts);

	const refresh = useCallback(async () => {
		if (!enabled) {
			setRemotes([]);
			return;
		}
		const saved = await remotesBridge().list();
		// Show every saved host immediately as "checking" — a host that is slow to
		// answer must not look like a host that does not exist.
		setRemotes(saved.map((host) => ({ id: host.url, label: host.label, url: host.url, status: "checking" })));
		await Promise.all(
			saved.map(async (host) => {
				const startedAt = Date.now();
				const status = await remotesBridge().probe(host.url);
				reportHostConnect(host.url, "probe", status, Date.now() - startedAt);
				setRemotes((current) => current.map((row) => (row.id === host.url ? { ...row, status } : row)));
			}),
		);
	}, [enabled]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	return { hosts: [localHost, ...remotes], refresh };
}
