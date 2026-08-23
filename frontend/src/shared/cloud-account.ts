/**
 * The account shape the renderer is allowed to see.
 *
 * Deliberately token-free: the AO access token and the rotating refresh token
 * live only in Electron main under ~/.ao (see main/cloud-auth.ts). The renderer
 * asks main for a short-lived access token per request and never persists one.
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
