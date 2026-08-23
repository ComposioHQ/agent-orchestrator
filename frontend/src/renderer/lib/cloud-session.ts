import { useEffect, useState } from "react";
import { aoBridge } from "./bridge";
import { useCloudSettingsStore } from "../stores/cloud-settings-store";
import type { CloudAccount, CloudAvailability } from "../../shared/cloud-account";

export type { CloudAccount, CloudAvailability };

export type CloudSessionStatus = "loading" | "authenticated" | "unauthenticated";

export interface UseCloudSessionResult {
	/** The build can reach a control plane at all — gates the early-access toggle. */
	available: boolean;
	/** Available *and* early access is on — gates every other cloud surface. */
	enabled: boolean;
	/** Kept empty; authenticated cloud transport is purpose-specific main IPC. */
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
	const availability = useCloudSettingsStore((state) => state.availability);
	const loadAvailability = useCloudSettingsStore((state) => state.load);
	const [session, setSession] = useState<CloudAccount | null>(null);
	const [status, setStatus] = useState<CloudSessionStatus>("loading");

	useEffect(() => {
		void loadAvailability();
	}, [loadAvailability]);

	useEffect(() => {
		let active = true;
		const applySession = (account: CloudAccount | null) => {
			if (!active) return;
			setSession(account);
			setStatus(account ? "authenticated" : "unauthenticated");
		};

		if (!availability.enabled) {
			applySession(null);
			return () => {
				active = false;
			};
		}

		void aoBridge.cloud
			.getSession()
			.then(applySession)
			.catch(() => applySession(null));
		const unsubscribe = aoBridge.cloud.onSessionChanged(applySession);
		return () => {
			active = false;
			unsubscribe();
		};
	}, [availability.enabled]);

	const signIn = () => {
		void aoBridge.cloud.signIn().then((account) => {
			if (!account) return;
			setSession(account);
			setStatus("authenticated");
		});
	};

	const signOut = async () => {
		await aoBridge.cloud.signOut();
		setSession(null);
		setStatus("unauthenticated");
	};

	return {
		available: availability.available,
		enabled: availability.enabled,
		apiBaseUrl: "",
		session,
		status,
		signIn,
		signOut,
	};
}
