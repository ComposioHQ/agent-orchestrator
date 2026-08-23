import { aoBridge } from "./bridge";
import { setApiBaseUrl, setApiDaemonStatus } from "./api-client";
import { parseDaemonProbe } from "../../shared/daemon-attach";

export type DaemonStatus = Awaited<ReturnType<typeof aoBridge.daemon.getStatus>>;

export function applyDaemonStatus(nextStatus: DaemonStatus): void {
	setApiDaemonStatus(nextStatus);
	if (!aoBridge.capabilities.daemonControl) {
		setApiBaseUrl(window.location.origin);
		return;
	}
	if (nextStatus.state === "ready" && nextStatus.port) {
		setApiBaseUrl(`http://127.0.0.1:${nextStatus.port}`);
	} else {
		setApiBaseUrl(null);
	}
}

export async function refreshDaemonStatus(): Promise<DaemonStatus> {
	const nextStatus = await readDaemonStatus();
	applyDaemonStatus(nextStatus);
	return nextStatus;
}

export function readDaemonStatus(): Promise<DaemonStatus> {
	if (!aoBridge.capabilities.daemonControl) return readWebDaemonStatus();
	return aoBridge.daemon.getStatus();
}

function webOriginPort(): number {
	const explicitPort = Number(window.location.port);
	if (Number.isInteger(explicitPort) && explicitPort > 0) return explicitPort;
	return window.location.protocol === "https:" ? 443 : 80;
}

async function readWebDaemonStatus(): Promise<DaemonStatus> {
	try {
		const response = await fetch(new URL("/healthz", window.location.origin), {
			cache: "no-store",
			credentials: "same-origin",
			headers: { Accept: "application/json" },
		});
		if (!response.ok) throw new Error(`health check returned ${response.status}`);
		const probe = parseDaemonProbe("healthz", await response.json());
		if (!probe) throw new Error("health check returned an invalid response");
		return {
			state: "ready",
			port: webOriginPort(),
			pid: probe.pid,
			executablePath: probe.executablePath,
			workingDirectory: probe.workingDirectory,
		};
	} catch {
		return {
			state: "stopped",
			code: "daemon_unreachable",
		};
	}
}
