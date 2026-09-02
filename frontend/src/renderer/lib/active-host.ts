import { useUiStore } from "../stores/ui-store";
import { aoBridge } from "./bridge";
import { connectedHosts, connectHost, disconnectHost } from "./host-clients";

/** Connect every saved host without making any one host own the window. */
async function connectSavedHosts(): Promise<void> {
	const saved = await aoBridge.remotes.list().catch(() => []);
	await Promise.allSettled(saved.map(({ url }) => connectHost(url)));
}

async function disconnectAllHosts(): Promise<void> {
	await Promise.allSettled(connectedHosts().map((host) => disconnectHost(host)));
}

let watchingFlag = false;

/**
 * Boot the remote-host layer, honouring the Remote hosts flag. Off means no
 * saved host is read, probed or connected — not "connected but hidden" — so a
 * reviewer can verify the off state from the network side. Flipping the switch
 * connects or tears down without a restart.
 */
export async function initHosts(): Promise<void> {
	if (!watchingFlag) {
		watchingFlag = true;
		useUiStore.subscribe((state, previous) => {
			if (state.remoteHosts === previous.remoteHosts) return;
			void (state.remoteHosts ? connectSavedHosts() : disconnectAllHosts());
		});
	}
	if (useUiStore.getState().remoteHosts) await connectSavedHosts();
}
