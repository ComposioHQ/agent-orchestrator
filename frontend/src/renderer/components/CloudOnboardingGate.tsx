import { useEffect, useRef } from "react";
import { useCloudGate } from "../hooks/useCloudGate";
import { useCloudSession } from "../lib/cloud-session";
import { useCloudOrg } from "../hooks/useCloudOrg";
import { hasValidAgentConnection, useProviderConnections } from "../hooks/useProviderConnections";
import { useCredentialDialogStore } from "../stores/credential-dialog-store";
import { CloudCredentialDialog } from "./CloudCredentialDialog";

// Mounted once at the app root. When the cloud offering is on and the developer
// has signed in but their org has no validated coding-agent connection yet, it
// prompts once for a setup token (the in-app replacement for the dev script).
// It also renders the single credential dialog instance the manual entry point
// (sidebar account row) drives through the shared store.
export function CloudOnboardingGate() {
	const { cloudEnabled } = useCloudGate();
	const { status } = useCloudSession();
	const { org } = useCloudOrg();
	const connections = useProviderConnections(org?.id);
	const openDialog = useCredentialDialogStore((s) => s.openDialog);
	// Prompt at most once per signed-in session so a developer who dismisses
	// without connecting is not re-nagged every render.
	const autoPromptedRef = useRef(false);

	const signedIn = cloudEnabled && status === "authenticated";

	useEffect(() => {
		if (!signedIn) {
			autoPromptedRef.current = false;
			return;
		}
		if (org === undefined || !connections.isSuccess || autoPromptedRef.current) return;
		if (!hasValidAgentConnection(connections.data)) {
			autoPromptedRef.current = true;
			openDialog();
		}
	}, [signedIn, org, connections.isSuccess, connections.data, openDialog]);

	if (!cloudEnabled) return null;
	return <CloudCredentialDialog />;
}
