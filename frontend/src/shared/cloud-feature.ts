/**
 * Early-access gating for every cloud surface, shared by Electron main (which
 * owns the credentials) and the renderer (which owns the UI).
 *
 * Two independent conditions must both hold before any cloud UI renders:
 *
 * 1. the build/environment is *configured* — a control-plane URL and a Google
 *    OAuth client id exist. Without these nothing can work, so the early-access
 *    toggle itself stays hidden rather than offering a dead switch; and
 * 2. the developer opted in — either a build/env feature flag or the persisted
 *    `cloudEnabled` UI setting.
 */
export function cloudFeatureFlagEnabled(value: string | undefined): boolean {
	return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

export function cloudDesktopConfigured(input: { apiUrl: string | undefined; googleClientId: string | undefined }): boolean {
	return Boolean(input.apiUrl?.trim() && input.googleClientId?.trim());
}

export function cloudEarlyAccessEnabled(input: {
	configured: boolean;
	featureFlags: Array<string | undefined>;
	preferenceEnabled: boolean;
}): boolean {
	if (!input.configured) return false;
	return input.preferenceEnabled || input.featureFlags.some(cloudFeatureFlagEnabled);
}
