import { useCallback, useEffect, useState } from "react";
import { aoBridge } from "../lib/bridge";
import { LOCAL_WORKSPACE_ID, resolveWorkspace, type RemoteWorkspace, type WorkspaceRegistry } from "../../shared/workspaces";
import type { SshConfigHost } from "../../shared/ssh-config";

/**
 * The remote-workspace registry, as the settings UI sees it.
 *
 * Mutations go through the supervisor, which owns both the file and the SSH
 * tunnel. Selecting a workspace does not return the new connection state: the
 * supervisor repoints the client and the result arrives on the ordinary
 * `daemon:status` channel, the same one a local daemon start uses. That is
 * deliberate — the UI has exactly one source of truth for "which daemon am I
 * talking to, and is it up".
 */
export function useWorkspaces() {
	const [registry, setRegistry] = useState<WorkspaceRegistry>({ remotes: [] });
	const [sshHosts, setSshHosts] = useState<SshConfigHost[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			setRegistry(await aoBridge.workspaces.list());
			setError(null);
		} catch {
			// IPC unavailable (browser preview, broken preload): remote workspaces
			// need the Electron supervisor, so an empty registry is the honest state.
			setRegistry({ remotes: [] });
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
		// Best-effort, and deliberately inside the promise chain: an absent or
		// unreadable ssh_config just means an empty picker and a hand-typed
		// target. The bridge section itself can also be missing (browser preview,
		// or a renderer hot-reloaded against an older preload), and that must
		// degrade the picker rather than throw out of the effect and blank the
		// whole settings page.
		void Promise.resolve()
			.then(() => aoBridge.workspaces.sshHosts())
			.then(setSshHosts)
			.catch(() => setSshHosts([]));
	}, [load]);

	// Every mutation reports its own failure rather than throwing: these are
	// user-correctable (duplicate id, bad target), not exceptions.
	const run = useCallback(async (operation: () => Promise<WorkspaceRegistry>): Promise<boolean> => {
		setError(null);
		try {
			setRegistry(await operation());
			return true;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			return false;
		}
	}, []);

	return {
		registry,
		sshHosts,
		loading,
		error,
		/** The workspace the client is pointed at, resolved the same way the supervisor resolves it. */
		activeId: activeWorkspaceId(registry),
		add: useCallback((workspace: RemoteWorkspace) => run(() => aoBridge.workspaces.add(workspace)), [run]),
		remove: useCallback((id: string) => run(() => aoBridge.workspaces.remove(id)), [run]),
		setActive: useCallback((id: string) => run(() => aoBridge.workspaces.setActive(id)), [run]),
		clearError: useCallback(() => setError(null), []),
	};
}

/**
 * Which workspace is in effect — not merely which one is persisted. With one
 * remote registered and no explicit choice, the supervisor connects to it, so
 * the UI must show that rather than a misleading "Local".
 */
export function activeWorkspaceId(registry: WorkspaceRegistry): string {
	const resolved = resolveWorkspace(registry);
	if ("error" in resolved) return LOCAL_WORKSPACE_ID;
	return resolved.workspace?.id ?? LOCAL_WORKSPACE_ID;
}
