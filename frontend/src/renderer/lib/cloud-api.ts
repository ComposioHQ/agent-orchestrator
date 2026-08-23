// The renderer's cloud control-plane client.
//
// Built once per control-plane origin and bound to Electron main for auth: the
// client asks main for a short-lived AO access token per request, so the
// renderer never stores one and a refresh (or a sign-out) in main takes effect
// on the very next call. This is the transport-independent contract described
// in docs/cloud-refactor.md — cloud-client accepts a base URL and an
// access-token provider and owns no credential of its own.

import { CloudApiError, createCloudClient, type CloudClient } from "@aoagents/cloud-client";
import { aoBridge } from "./bridge";

export { CloudApiError };
export type { CloudClient };

let cachedBaseUrl = "";
let cachedClient: CloudClient | null = null;

/**
 * The client for the given control-plane origin, or null when cloud is
 * unavailable or early access is off (main reports an empty base URL then).
 */
export function cloudClientFor(baseUrl: string): CloudClient | null {
	if (!baseUrl) {
		cachedBaseUrl = "";
		cachedClient = null;
		return null;
	}
	if (baseUrl !== cachedBaseUrl || !cachedClient) {
		cachedBaseUrl = baseUrl;
		cachedClient = createCloudClient({
			baseUrl,
			getAccessToken: () => aoBridge.cloud.getAccessToken(),
		});
	}
	return cachedClient;
}

/** Test seam: forget the memoized client between cases. */
export function resetCloudClient(): void {
	cachedBaseUrl = "";
	cachedClient = null;
}
