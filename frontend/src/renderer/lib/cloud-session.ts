import { useEffect, useState } from "react";
import { aoBridge } from "./bridge";
import type { CloudAccount } from "../../shared/cloud-account";

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
	const configured = aoBridge.cloud.isEnabled();
	const [session, setSession] = useState<CloudAccount | null>(null);
	const [status, setStatus] = useState<CloudSessionStatus>(configured ? "loading" : "unauthenticated");

	useEffect(() => {
		if (!configured) return;
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
	}, [configured]);

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
