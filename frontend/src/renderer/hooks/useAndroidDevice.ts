import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient, hasTrustedApiBaseUrl } from "../lib/api-client";

export type AndroidSDKStatus = components["schemas"]["AndroidSDKStatusResponse"];
export type AndroidEmulatorStatus = components["schemas"]["AndroidEmulatorStatusResponse"];
export type AndroidInputAction = components["schemas"]["AndroidInputActionRequest"];

export const androidSDKStatusQueryKey = ["android-sdk-status"] as const;
export const androidEmulatorStatusQueryKey = ["android-emulator-status"] as const;

// The SDK download is a one-time, multi-GB fetch, so poll fairly often while
// it's in flight and stop entirely once it settles. The emulator's boot/stop
// transitions are much faster (seconds), so they poll tighter; once running,
// a slow background poll is enough to notice an external crash.
const sdkDownloadPollInterval = 1_500;
const emulatorTransitioningPollInterval = 1_000;
const emulatorIdlePollInterval = 15_000;

export async function fetchAndroidSDKStatus(): Promise<AndroidSDKStatus> {
	const { data, error } = await apiClient.GET("/api/v1/android-device/sdk/status");
	if (error) throw error;
	return data;
}

export async function fetchAndroidEmulatorStatus(): Promise<AndroidEmulatorStatus> {
	const { data, error } = await apiClient.GET("/api/v1/android-device/status");
	if (error) throw error;
	return data;
}

// acceptLicenses is always true here, not a caller-supplied parameter: the
// button that calls this must itself state — in its own label/copy — that
// clicking it downloads the SDK and accepts Google's Android SDK license, so
// the consent is explicit at the one call site that exists (EmulatorPanel),
// not implied by an API default.
export async function setupAndroidSDK(): Promise<AndroidSDKStatus> {
	const { data, error } = await apiClient.POST("/api/v1/android-device/sdk/setup", {
		body: { acceptLicenses: true },
	});
	if (error) throw error;
	return data;
}

export async function startAndroidEmulator(): Promise<AndroidEmulatorStatus> {
	const { data, error } = await apiClient.POST("/api/v1/android-device/start");
	if (error) throw error;
	return data;
}

export async function stopAndroidEmulator(): Promise<AndroidEmulatorStatus> {
	const { data, error } = await apiClient.POST("/api/v1/android-device/stop");
	if (error) throw error;
	return data;
}

export async function sendAndroidInput(action: AndroidInputAction): Promise<void> {
	const { error } = await apiClient.POST("/api/v1/android-device/input", { body: action });
	if (error) throw error;
}

export function useAndroidSDKStatus(enabled: boolean) {
	return useQuery({
		queryKey: androidSDKStatusQueryKey,
		queryFn: fetchAndroidSDKStatus,
		enabled: enabled && hasTrustedApiBaseUrl(),
		refetchInterval: (state) => (state.state.data?.state === "downloading" ? sdkDownloadPollInterval : false),
		retry: 1,
	});
}

export function useAndroidEmulatorStatus(enabled: boolean) {
	return useQuery({
		queryKey: androidEmulatorStatusQueryKey,
		queryFn: fetchAndroidEmulatorStatus,
		enabled: enabled && hasTrustedApiBaseUrl(),
		refetchInterval: (state) => {
			const emulatorState = state.state.data?.state;
			if (emulatorState === "booting" || emulatorState === "stopping") return emulatorTransitioningPollInterval;
			return emulatorIdlePollInterval;
		},
		retry: 1,
	});
}

/**
 * Combined status + lifecycle mutations for AO's single, shared Android
 * emulator. `enabled` should reflect the ui-store's emulatorEnabled setting
 * (the feature is a heavy opt-in; this hook does no work at all when off).
 */
export function useAndroidDevice(enabled: boolean) {
	const queryClient = useQueryClient();
	const sdk = useAndroidSDKStatus(enabled);
	const emulator = useAndroidEmulatorStatus(enabled && sdk.data?.state === "installed");

	const setup = useMutation({
		mutationFn: setupAndroidSDK,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: androidSDKStatusQueryKey });
		},
	});
	const start = useMutation({
		mutationFn: startAndroidEmulator,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: androidEmulatorStatusQueryKey });
		},
	});
	const stop = useMutation({
		mutationFn: stopAndroidEmulator,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: androidEmulatorStatusQueryKey });
		},
	});

	return { sdk, emulator, setup, start, stop };
}

/** Fire-and-forget tap/swipe/key/text input, independent of useAndroidDevice's status polling. */
export function useSendAndroidInput() {
	return useMutation({ mutationFn: sendAndroidInput });
}
