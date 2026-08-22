export function cloudFeatureFlagEnabled(value: string | undefined): boolean {
	return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

export function cloudDesktopConfigured(input: {
	featureFlags: Array<string | undefined>;
	apiUrl: string | undefined;
	googleClientId: string | undefined;
	forceEnabled?: boolean;
}): boolean {
	const enabled = input.forceEnabled || input.featureFlags.some(cloudFeatureFlagEnabled);
	return Boolean(enabled && input.apiUrl?.trim() && input.googleClientId?.trim());
}
