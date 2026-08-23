/**
 * The account shape the renderer is allowed to see.
 *
 * Deliberately token-free, and there is no channel that would add one back: the
 * AO access token and the rotating refresh token live only in Electron main
 * under ~/.ao (see main/cloud-auth.ts), which is also the only process that
 * makes cloud HTTP requests. The renderer never holds, requests, or persists a
 * credential — it drives the cloud through narrow IPC verbs instead.
 */
export interface CloudAccount {
	authProvider: "google";
	user: {
		id: string;
		email: string;
		displayName: string;
	};
	/** Live memberships from GET /api/cloud/v1/me — reloaded on every account read. */
	organizations: CloudOrganization[];
	storedAt: string;
}

export interface CloudOrganization {
	id: string;
	slug: string;
	displayName: string;
	role: string;
}

/**
 * What the renderer needs to decide whether any cloud UI may exist at all.
 * `available` is a build/environment fact (API URL + Google client configured);
 * `enabled` additionally requires the developer early-access opt-in.
 */
export interface CloudAvailability {
	available: boolean;
	enabled: boolean;
	/** Control-plane origin, so the renderer can build its own cloud client. */
	apiBaseUrl: string;
}
