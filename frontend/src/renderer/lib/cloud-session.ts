import { useEffect, useState } from "react";
import { aoBridge } from "./bridge";
import type { CloudAccount } from "../../shared/cloud-account";
import { useCloudSettingsStore } from "../stores/cloud-settings-store";

export type { CloudAccount };

export type CloudSessionStatus = "loading" | "authenticated" | "unauthenticated";

export interface UseCloudSessionResult {
	configured: boolean;
	session: CloudAccount | null;
	status: CloudSessionStatus;
	signIn: (returnTo?: string) => void;
	signOut: () => Promise<void>;
}

export function useCloudSession(): UseCloudSessionResult {
	const available = aoBridge.cloud.isAvailable();
	const environmentEnabled = aoBridge.cloud.isEnabled();
	const cloudEnabled = useCloudSettingsStore((state) => state.enabled);
	const cloudSettingsLoaded = useCloudSettingsStore((state) => state.loaded);
	const loadCloudSettings = useCloudSettingsStore((state) => state.load);
	const configured = available && (environmentEnabled || (cloudSettingsLoaded && cloudEnabled));
	const [session, setSession] = useState<CloudAccount | null>(null);
	const [status, setStatus] = useState<CloudSessionStatus>("loading");

	useEffect(() => {
		void loadCloudSettings();
	}, [loadCloudSettings]);

	useEffect(() => {
		if (!configured) {
			if (cloudSettingsLoaded) setStatus("unauthenticated");
			return;
		}
		let active = true;
		void aoBridge.cloud.getSession().then((cloudSession) => {
			if (!active) return;
			setSession(cloudSession);
			setStatus(cloudSession ? "authenticated" : "unauthenticated");
		}).catch(() => {
			if (!active) return;
			setSession(null);
			setStatus("unauthenticated");
		});

		const unsub = aoBridge.cloud.onSessionChanged((cloudSession) => {
			setSession(cloudSession);
			setStatus(cloudSession ? "authenticated" : "unauthenticated");
		});

		return () => {
			active = false;
			unsub();
		};
	}, [cloudSettingsLoaded, configured]);

	const signIn = () => {
		void aoBridge.cloud.signIn();
	};

	const signOut = async () => {
		await aoBridge.cloud.signOut();
		setSession(null);
		setStatus("unauthenticated");
	};

	return { configured, session, status, signIn, signOut };
}
