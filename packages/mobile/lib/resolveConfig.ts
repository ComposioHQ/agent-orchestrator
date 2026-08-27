import type { ConnectResult } from "./connect";
import { loadConfig, type ServerConfig } from "./config";
import type { Host } from "./hosts";
import { loadHosts, migrateLegacyConfig } from "./hosts";
import { connectToHost } from "./connectRuntime";

export type ResolveDeps = {
	migrate: () => Promise<void>;
	loadHosts: () => Promise<Host[]>;
	connect: (hostId: string) => Promise<ConnectResult>;
	loadLegacyConfig: () => Promise<ServerConfig>;
};

/**
 * Works out which address the app should be talking to right now.
 *
 * Races the most recently used machine's endpoints, so the app lands on
 * whichever of its addresses currently works — LAN at home, the tunnel from
 * anywhere else — without the user choosing.
 *
 * Always returns something. The rest of the app is built around having a
 * config, so every failure path degrades to the last stored one rather than
 * returning nothing, which would look like being unpaired. A machine that
 * cannot be reached is a connection problem for the UI to report, not a reason
 * to forget it.
 */
export async function resolveActiveConfig(deps: ResolveDeps): Promise<ServerConfig | null> {
	try {
		// Before looking for machines, bring any pre-existing single-server
		// pairing into the list — otherwise an upgrading user looks unpaired.
		await deps.migrate();

		const hosts = await deps.loadHosts();
		if (hosts.length > 0) {
			// loadHosts is ordered most-recent-first.
			const result = await deps.connect(hosts[0].id);
			if (result.ok) return result.config;
		}
	} catch {
		// Falling through to the stored config: a resolution failure must not
		// leave the app with no connection at all.
	}
	return await deps.loadLegacyConfig();
}

/** The production dependency set. */
export function runtimeResolveDeps(): ResolveDeps {
	return {
		migrate: migrateLegacyConfig,
		loadHosts,
		connect: connectToHost,
		loadLegacyConfig: loadConfig,
	};
}
