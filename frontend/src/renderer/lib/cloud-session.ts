import { useEffect } from "react";
import { aoBridge } from "./bridge";
import { useCloudStore } from "../stores/cloud-store";
import type { CloudAccount, CloudAvailability } from "../../shared/cloud-account";

export type { CloudAccount, CloudAvailability };

export type CloudSessionStatus = "loading" | "authenticated" | "unauthenticated";

export interface UseCloudSessionResult {
	/** The build can reach a control plane at all — gates the early-access toggle. */
	available: boolean;
	/** Available *and* early access is on — gates every other cloud surface. */
	enabled: boolean;
	/** Control-plane origin for the renderer's cloud client; "" while disabled. */
	apiBaseUrl: string;
	session: CloudAccount | null;
	status: CloudSessionStatus;
	signIn: () => void;
	signOut: () => Promise<void>;
}

/**
 * Cloud identity as the renderer sees it. Availability and the account both come
 * from Electron main — the renderer holds no client id, no token, and no build
 * flag of its own, so turning early access off in main takes effect here without
 * a rebuild.
 */
export function useCloudSession(): UseCloudSessionResult {
	const availability = useCloudStore((state) => state.availability);
	const account = useCloudStore((state) => state.account);
	const accountLoaded = useCloudStore((state) => state.accountLoaded);
	const load = useCloudStore((state) => state.load);
	const setAccount = useCloudStore((state) => state.setAccount);
	const signInToCloud = useCloudStore((state) => state.signIn);
	const signOut = useCloudStore((state) => state.signOut);

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => aoBridge.cloud.onSessionChanged(setAccount), [setAccount]);

	return {
		available: availability.available,
		enabled: availability.enabled,
		apiBaseUrl: availability.apiBaseUrl,
		session: account,
		status: !accountLoaded ? "loading" : account ? "authenticated" : "unauthenticated",
		signIn: () => {
			void signInToCloud();
		},
		signOut,
	};
}
