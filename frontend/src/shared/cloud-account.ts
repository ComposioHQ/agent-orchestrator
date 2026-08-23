/**
 * The account shape the renderer is allowed to see.
 *
 * Deliberately token-free: the AO access token and the rotating refresh token
 * live only in Electron main under ~/.ao (see main/cloud-auth.ts). Electron
 * main performs authenticated cloud requests behind purpose-specific IPC.
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
	/** Legacy compatibility field. Cloud HTTP remains in Electron main. */
	apiBaseUrl: string;
}
